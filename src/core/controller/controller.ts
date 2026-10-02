/**
 * The headless controller: the renderer's App component without a DOM.
 *
 * It holds the same `AppState` through the same reducer (`src/renderer/store.ts`),
 * turns shell input (`ui:event`, `ui:command`, `term:event`, `shell:geometry`)
 * into the actions `app.tsx` dispatches, calls `src/main` through the shim's
 * local ipc exactly as the preload would, and after every change sends the
 * whole view as one `ui:model` (coalesced to one per macrotask). The terminal
 * grids live in the shell; the controller drives them with `grid:cmd`.
 *
 * Handlers are ported from `app.tsx` and `PaneView.tsx`; each port names its
 * source. Behaviour that is not ported yet toasts "<name> arrives in phase 2".
 * The session snapshot and restore live in `session.ts`, the status bar's
 * strings in `status.ts`.
 */
import path from 'node:path'
import {
  isTerm,
  MAX_TAB_NAME,
  paneById,
  reducer,
  type Action,
  type AppState,
  type PaneState,
  type TabState,
  uid,
} from '../../renderer/store.js'
import { MAX_PANES_PER_TAB, type CellSize, type RowNode } from '../../renderer/layout/types.js'
import { dfsPaneOrder } from '../../renderer/layout/tree.js'
import { applyDividerDrag, type DividerSpec } from '../../renderer/layout/dividers.js'
import { clampIndex, DEFAULT_ZOOM_INDEX, levelAt, zoomPercent } from '../../renderer/term/zoom.js'
import { paneColorHex } from '../../renderer/panes/colors.js'
import { shouldOfferRestore } from '../../renderer/session/offer.js'
import { launchCommandText } from '../../renderer/projects/serialize.js'
import { isLocalHost, parseOsc7 } from '../../renderer/term/osc7.js'
import { DONE_ATTENTION_MS } from '../../renderer/panes/attention.js'
import { dropText } from '../../renderer/panes/drop.js'
import { chordLabel } from '../../shared/keys.js'
import type {
  AppPaths,
  LastSession,
  MetricsTickEvent,
  PtyKillResponse,
  PtySpawnResponse,
} from '../../shared/ipc.js'
import { layOut, layOutZoomed, type LaidOut } from './layout.js'
import { defaultUiState, loadUiState, saveUiState, type UiState } from './ui-state.js'
import { collectSaveLookup, restoreSavedTabs, snapshotTabs, SNAPSHOT_INTERVAL_MS } from './session.js'
import { mem, statusModel } from './status.js'
import type {
  ChordModel,
  FindModel,
  Geometry,
  GridCmd,
  PaneModel,
  Rect,
  TermEvent,
  UiEvent,
  UiModel,
} from './model.js'

export interface ControllerDeps {
  /** shim.invokeLocal */
  invoke<T = unknown>(ch: string, p: unknown): Promise<T>
  /** shim.sendLocal */
  send(ch: string, p: unknown): void
  /** Write an `on` envelope to the shell. */
  toShell(ch: 'ui:model' | 'grid:cmd', p: unknown): void
  invokeShell<T = unknown>(ch: string, p: unknown): Promise<T>
  now(): number
  setTimer(fn: () => void, ms: number): () => void
  /** 'win32' for the keys.ts spelling. */
  platform: string
}

/** Scrollback per grid, the native design's fixed figure. */
export const SCROLLBACK = 20_000

/** How long a toast stays up (`app.tsx:1255-1259`). */
const TOAST_MS = 3200

/** How long after a spawn the launch command is typed (`PaneView.tsx:415-423`). */
const LAUNCH_DELAY_MS = 300

/** How long the find box waits after the last keystroke before searching. */
const FIND_DEBOUNCE_MS = 120

/** Chrome heights at uiScale 1, from styles.css (`--tabbar-h`, `--statusbar-h`). */
const TAB_STRIP_PX = 38
const STATUS_PX = 28

/** Commands owned by Phase 2. Each toasts `<name> arrives in phase 2`. */
const PHASE2_COMMANDS: Readonly<Record<string, string>> = {
  'drawer.toggle': 'The shell drawer',
  'explorer.toggle': 'The file explorer',
  'explorer.refresh': 'The file explorer',
  'help.tutorial': 'The tutorial',
  'app.projects': 'Projects',
  'app.saveProject': 'Save project',
  'app.saveTab': 'Save tab as project',
  'app.settings': 'Settings',
  'preview.file': 'File preview',
  'preview.web': 'Web preview',
  'pane.closeAll': 'Close all panes',
}

/** Pane title-bar controls owned by Phase 2, keyed by the target's last part. */
const PHASE2_TARGETS: Readonly<Record<string, string>> = {
  color: 'Pane colors',
  link: 'Pane links',
}

interface GridInfo {
  cols: number
  rows: number
  fontPx: number
}

interface DragState {
  tabId: string
  spec: DividerSpec
  area: Rect
  cell: CellSize
  tree: RowNode
}

function emptyFind(): FindModel {
  return { open: false, paneId: null, query: '', caseSensitive: false, regex: false, count: null, miss: false }
}

export class Controller {
  private readonly deps: ControllerDeps
  private readonly opts: { home: string; version: string; chords: ChordModel[] }
  private s: AppState = {
    tabs: [],
    activeTabId: '',
    sidebarVisible: false,
    explorerRoot: '',
    revealPath: null,
    system: null,
    toast: null,
  }
  private ui: UiState = defaultUiState()
  private uiFile: string | null = null
  private paths: AppPaths | null = null
  private home: string
  private geo: Geometry | null = null
  /** The window font the geometry's cell was measured at. */
  private geoFontPx = levelAt(DEFAULT_ZOOM_INDEX).font
  private booting = true
  private restoreCandidate: LastSession | null = null
  /** Between Restore and the rebuilt tabs arriving: still starting, not empty. */
  private restoring = false
  private renamingTabId: string | null = null
  private renameDraft = ''
  private find: FindModel = emptyFind()
  private toastCancel: (() => void) | null = null
  private findDebounce: (() => void) | null = null
  /** The last snapshot written, so an unchanged window is not rewritten (`app.tsx:565-571`). */
  private lastSnapshot = ''
  private snapshotArmed = false
  /** Expiry timers for `done` pulses, by pane id. */
  private readonly doneTimers = new Map<string, () => void>()
  private drag: DragState | null = null
  /** Grids the shell holds, by pane id. */
  private readonly grids = new Map<string, GridInfo>()
  /** `<paneId>:<generation>` already spawned, so a re-sync never respawns. */
  private readonly spawned = new Set<string>()
  /** Panes being reaped right now; their grids stay until the reducer drops them. */
  private readonly closing = new Set<string>()
  private emitQueued = false
  private seq = 0
  private last: UiModel

  constructor(deps: ControllerDeps, opts: { home: string; version: string; chords: ChordModel[] }) {
    this.deps = deps
    this.opts = opts
    this.home = opts.home
    this.last = this.build()
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Boot order from `app.tsx:328-365`: paths, preferences, last session, then a tab or the card. */
  async boot(geometry: Geometry): Promise<void> {
    this.geo = geometry
    try {
      this.paths = await this.deps.invoke<AppPaths>('app:getPaths', undefined)
      this.home = this.paths.home || this.opts.home
    } catch {
      this.paths = null
    }
    if (this.paths?.userData) {
      this.uiFile = path.posix.join(this.paths.userData, 'ui-state.json')
      this.ui = loadUiState(this.uiFile)
    }
    this.s = reducer(this.s, { type: 'explorer.setRoot', root: this.home })

    // Nothing is restored without being asked (app.tsx:344-347).
    let last: LastSession | null = null
    try {
      last = await this.deps.invoke<LastSession | null>('session:load', undefined)
    } catch {
      last = null
    }
    this.booting = false
    if (last && Array.isArray(last.tabs) && shouldOfferRestore(last.tabs)) {
      this.restoreCandidate = last
      this.emit()
    } else {
      this.newTab()
    }
    this.armSnapshot()
  }

  geometry(g: Geometry): void {
    // The cell in a fresh geometry belongs to the font the shell last drew.
    this.geoFontPx = this.last.window.fontPx
    this.geo = g
    this.sync()
    this.emit()
  }

  model(): UiModel {
    return this.last
  }

  /** @internal for tests */
  state(): AppState {
    return this.s
  }

  // ---------------------------------------------------------------------------
  // Commands (the app.tsx command switch, app.tsx:861-1090)
  // ---------------------------------------------------------------------------

  command(name: string): void {
    if (name.startsWith('tab.select.')) {
      this.dispatch({ type: 'tab.selectIndex', index: Number(name.split('.')[2]) })
      return
    }
    const phase2 = PHASE2_COMMANDS[name]
    if (phase2) {
      this.toast(`${phase2} arrives in phase 2`)
      return
    }
    const tab = this.activeTab()
    switch (name) {
      case 'tab.new':
        this.newTab()
        break
      case 'tab.close':
        if (tab) void this.closeTab(tab.id)
        break
      case 'tab.next':
        this.dispatch({ type: 'tab.cycle', delta: 1 })
        break
      case 'tab.prev':
        this.dispatch({ type: 'tab.cycle', delta: -1 })
        break
      case 'tab.rename':
        if (tab) this.startRename(tab)
        break
      case 'pane.new':
        this.newPane()
        break
      case 'pane.close':
        if (tab?.focusedPaneId) void this.closePane(tab.focusedPaneId)
        break
      case 'pane.next':
        this.dispatch({ type: 'pane.cycle', delta: 1 })
        this.focusGrid()
        break
      case 'pane.prev':
        this.dispatch({ type: 'pane.cycle', delta: -1 })
        this.focusGrid()
        break
      case 'pane.zoom':
        this.dispatch({ type: 'pane.zoom' })
        break
      case 'pane.clear': {
        const id = this.focusedTermId()
        if (id) this.grid({ paneId: id, op: 'clear' })
        break
      }
      case 'layout.rebalance':
        this.dispatch({ type: 'layout.rebalance' })
        break
      // The global zoom also clears per-pane overrides (app.tsx:977-990).
      case 'ui.zoomIn':
        this.setZoom(this.ui.zoomIndex + 1)
        break
      case 'ui.zoomOut':
        this.setZoom(this.ui.zoomIndex - 1)
        break
      case 'ui.zoomReset':
        this.setZoom(DEFAULT_ZOOM_INDEX)
        break
      // The shifted pair zooms the focused pane alone (app.tsx:1130-1135).
      case 'pane.zoomIn':
        this.dispatch({ type: 'pane.zoomText', delta: 1, base: this.ui.zoomIndex })
        break
      case 'pane.zoomOut':
        this.dispatch({ type: 'pane.zoomText', delta: -1, base: this.ui.zoomIndex })
        break
      case 'edit.find':
        this.openFind()
        break
      case 'edit.findNext':
        this.stepFind('next')
        break
      case 'edit.findPrev':
        this.stepFind('prev')
        break
      case 'edit.copy': {
        // The shell writes the clipboard from the grid's own selection.
        const id = this.focusedTermId()
        if (id) this.grid({ paneId: id, op: 'copy' })
        break
      }
      case 'edit.paste':
        // The text arrives with the command from the shell (see push).
        break
      case 'edit.selectAll': {
        const id = this.focusedTermId()
        if (id) this.grid({ paneId: id, op: 'selectAll' })
        break
      }
      default:
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Shell input
  // ---------------------------------------------------------------------------

  event(e: UiEvent): void {
    const t = e.target
    if (t.startsWith('divider:')) {
      if (e.type === 'down' || e.type === 'move' || e.type === 'up') this.dividerEvent(t.slice('divider:'.length), e)
      return
    }
    if (e.type === 'key') {
      this.keyEvent(t, e.key)
      return
    }
    if (e.type === 'text') {
      if (this.renamingTabId && t === `tab:${this.renamingTabId}:rename`) {
        this.renameDraft = e.text.slice(0, MAX_TAB_NAME)
      } else if (t === 'find:query') {
        this.find = { ...this.find, query: e.text, count: null, miss: false }
        this.debounceFind()
        this.emit()
      }
      return
    }
    if (e.type === 'blur') {
      // Blur commits rather than cancels (app.tsx TabNameInput).
      if (this.renamingTabId && t === `tab:${this.renamingTabId}:rename`) this.commitRename()
      return
    }
    if (e.type === 'focus' || e.type === 'wheel' || e.type === 'drop' || e.type === 'up' || e.type === 'move') return

    const parts = t.split(':')
    const head = parts[0]
    if (head === 'tab') this.tabEvent(parts, e.type)
    else if (head === 'pane') this.paneEvent(parts, e.type)
    else if (head === 'find') this.findEvent(parts[1] ?? '', e.type)
    else if (e.type === 'click') this.chromeClick(t)
    else if (e.type === 'dblclick' && t === 'strip:empty') this.newTab()
  }

  term(e: TermEvent): void {
    switch (e.type) {
      case 'findResult':
        if (this.find.paneId === e.paneId) {
          this.find = {
            ...this.find,
            count: e.total > 0 ? { index: e.index, total: e.total, capped: e.capped } : null,
            miss: e.total === 0 && this.find.query !== '',
          }
          this.emit()
        }
        break
      case 'title':
        // app.tsx:1670-1673: the setting gates it; the reducer keeps a custom label.
        if (this.ui.settings.autoTitlePanes && typeof e.title === 'string') {
          this.dispatch({ type: 'pane.autoTitle', paneId: e.paneId, title: e.title })
        }
        break
      case 'cwd': {
        const cwd = this.trustedCwd(e.cwd)
        if (cwd && paneById(this.s, e.paneId)) this.dispatch({ type: 'pane.cwd', paneId: e.paneId, cwd, home: this.home })
        break
      }
      case 'bell':
        this.dispatch({ type: 'pane.bell', paneId: e.paneId, at: this.deps.now() })
        break
      default:
        // Path clicks reveal and preview files, which need the explorer and the
        // preview panes (Phase 2). Selections are the shell's own business.
        break
    }
  }

  /**
   * The shell reports either the raw OSC 7 payload (`file://host/path`) or a
   * path it already parsed. Both go through `parseOsc7` (`terminal.ts:261-266`),
   * so a path from a remote host or one carrying control characters is dropped.
   */
  private trustedCwd(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw === '') return null
    if (raw.startsWith('file://')) {
      return isLocalHost(raw, this.paths?.hostname ?? '') ? parseOsc7(raw) : null
    }
    if (!raw.startsWith('/') || raw.length > 4096) return null
    let encoded: string
    try {
      encoded = raw.split('/').map(encodeURIComponent).join('/')
    } catch {
      return null // a lone surrogate
    }
    return parseOsc7(`file://${encoded}`)
  }

  push(ch: string, p: unknown): void {
    switch (ch) {
      case 'app:toast': {
        const message = (p as { message?: unknown } | null)?.message
        if (typeof message === 'string') this.toast(message)
        break
      }
      case 'ui:command': {
        const cmd = p as { command?: unknown; text?: unknown } | null
        if (typeof cmd?.command !== 'string') break
        if (cmd.command === 'edit.paste') {
          void this.paste(typeof cmd.text === 'string' ? cmd.text : '')
          break
        }
        this.command(cmd.command)
        break
      }
      case 'pty:exit': {
        const x = p as { paneId?: unknown; exitCode?: unknown; signal?: unknown } | null
        if (typeof x?.paneId !== 'string') break
        const code = typeof x.exitCode === 'number' ? x.exitCode : 0
        const signal = typeof x.signal === 'number' ? x.signal : null
        this.dispatch({ type: 'pane.exited', paneId: x.paneId, code, signal })
        if (this.grids.has(x.paneId)) this.grid({ paneId: x.paneId, op: 'exited', failed: code !== 0 })
        break
      }
      case 'metrics:tick': {
        const m = p as Partial<MetricsTickEvent> | null
        if (!m || !Array.isArray(m.panes)) break
        this.dispatch({ type: 'metrics', panes: m.panes, system: m.system ?? null })
        this.armDoneExpiry()
        break
      }
      case 'session:requestSnapshot':
        // The quit path: always answer, changed or not (app.tsx:629).
        void this.snapshot(true)
        break
      default:
        // update:state and watch:* belong to Phase 2 (the update banner, the explorer).
        break
    }
  }

  /**
   * `app.tsx:1018-1065`, for a terminal pane. The shell read the clipboard and
   * sends its text. Quoted `C:\` paths (Explorer's "Copy as path") paste as
   * quoted WSL paths; no text at all asks main for copied files, then for a
   * screenshot saved as a PNG. Ordinary text is untouched. The target is
   * resolved before anything awaits, so a focus change cannot redirect it.
   */
  private async paste(text: string): Promise<void> {
    const id = this.focusedTermId()
    if (!id) return
    const platform = this.deps.platform
    let winPaths: string[] = []
    if (/^\s*"?[A-Za-z]:[\\/]/.test(text)) {
      winPaths = text.split(/\r?\n/).map((l) => l.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
    } else if (!text) {
      try {
        const files = await this.deps.invoke<string[]>('clipboard:windows-files', undefined)
        if (Array.isArray(files)) winPaths = files.filter((f) => typeof f === 'string' && f !== '')
      } catch {
        /* no files on the clipboard, or no way to read them here */
      }
    }
    if (winPaths.length) {
      const out = dropText({ paths: winPaths }, platform)
      if (out && this.grids.has(id)) this.grid({ paneId: id, op: 'paste', text: out })
      return
    }
    if (!text) {
      let image = ''
      try {
        image = await this.deps.invoke<string>('clipboard:image', undefined)
      } catch {
        image = ''
      }
      if (typeof image === 'string' && image && this.grids.has(id)) {
        this.grid({ paneId: id, op: 'paste', text: dropText({ paths: [image] }, platform) })
      }
      return
    }
    if (this.grids.has(id)) this.grid({ paneId: id, op: 'paste', text })
  }

  // ---------------------------------------------------------------------------
  // Tabs and panes
  // ---------------------------------------------------------------------------

  private newTab(): void {
    const cmd = this.ui.settings.newPaneCommand
    this.dispatch({
      type: 'tab.new',
      cwd: this.home,
      home: this.home,
      autoColor: this.ui.settings.autoColorPanes,
      ...(cmd ? { commandText: cmd } : {}),
    })
  }

  /** `app.tsx:390-408`, with the full-tab refusal checked here so the toast uses this platform's chord. */
  private newPane(): void {
    const tab = this.activeTab()
    if (!tab) return
    if (Object.keys(tab.panes).length >= MAX_PANES_PER_TAB) {
      this.toast(`Tab is full (${MAX_PANES_PER_TAB} panes) - open a new tab (${chordLabel('Cmd+T', this.deps.platform)})`)
      return
    }
    const cmd = this.ui.settings.newPaneCommand
    this.dispatch({
      type: 'pane.new',
      home: this.home,
      autoColor: this.ui.settings.autoColorPanes,
      ...(cmd ? { command: 'cmd' as const, commandText: cmd } : { command: 'zsh' as const }),
    })
  }

  /** `app.tsx:415-432`: a terminal pane is reaped, never just forgotten. */
  private async closePane(paneId: string): Promise<void> {
    if (this.closing.has(paneId)) return
    const pane = this.activeTab()?.panes[paneId]
    if (!pane) return
    if (isTerm(pane)) {
      this.closing.add(paneId)
      try {
        const res = await this.deps.invoke<PtyKillResponse>('pty:kill', { paneId })
        if (res && !res.ok && res.survivors > 0) this.toast(`${res.survivors} process(es) could not be reaped`)
      } catch {
        /* the pane goes regardless; main's own sweep catches survivors */
      } finally {
        this.closing.delete(paneId)
      }
    }
    // The reducer closes panes in the active tab only. If the user switched tabs
    // while the kill ran, close it in its own tab and come back.
    const owner = this.s.tabs.find((t) => t.panes[paneId] !== undefined)
    if (!owner) return
    if (owner.id === this.s.activeTabId) {
      this.dispatch({ type: 'pane.close', paneId })
      return
    }
    const back = this.s.activeTabId
    let next = reducer(this.s, { type: 'tab.select', tabId: owner.id })
    next = reducer(next, { type: 'pane.close', paneId })
    if (next.tabs.some((t) => t.id === back)) next = reducer(next, { type: 'tab.select', tabId: back })
    this.s = next
    this.sync()
    this.emit()
  }

  /** `app.tsx:434-457`. */
  private async closeTab(tabId: string): Promise<void> {
    const tab = this.s.tabs.find((t) => t.id === tabId)
    if (!tab) return
    await Promise.all(
      Object.values(tab.panes)
        .filter(isTerm)
        .map(async (p) => {
          try {
            await this.deps.invoke<PtyKillResponse>('pty:kill', { paneId: p.id })
          } catch {
            /* as closePane */
          }
        })
    )
    if (this.renamingTabId === tabId) this.renamingTabId = null
    this.dispatch({ type: 'tab.close', tabId })
  }

  /**
   * `PaneView.tsx` onRestart via `app.tsx:1656`: the pane starts over in a
   * fresh grid. The old grid goes first, so the reducer's generation bump
   * makes `sync` create a new one and spawn again under the new key.
   */
  private restartPane(paneId: string): void {
    const pane = paneById(this.s, paneId)
    if (!pane || !isTerm(pane) || pane.status !== 'exited') return
    if (this.grids.delete(paneId)) this.grid({ paneId, op: 'dispose' })
    if (this.find.paneId === paneId) this.find = { ...this.find, count: null, miss: false }
    this.dispatch({ type: 'pane.restarting', paneId })
  }

  private setZoom(index: number): void {
    this.ui = { ...this.ui, zoomIndex: clampIndex(index) }
    this.saveUi()
    this.dispatch({ type: 'pane.clearTextZoom' })
  }

  private startRename(tab: TabState): void {
    this.renamingTabId = tab.id
    this.renameDraft = tab.name
    this.emit()
  }

  private commitRename(): void {
    const id = this.renamingTabId
    if (!id) return
    this.renamingTabId = null
    this.dispatch({ type: 'tab.rename', tabId: id, name: this.renameDraft, home: this.home })
  }

  private cancelRename(): void {
    if (!this.renamingTabId) return
    this.renamingTabId = null
    this.emit()
  }

  // ---------------------------------------------------------------------------
  // Find
  // ---------------------------------------------------------------------------

  private openFind(): void {
    const tab = this.activeTab()
    const pane = tab?.focusedPaneId ? tab.panes[tab.focusedPaneId] : undefined
    if (pane?.kind === 'web') {
      this.toast('Find is not available in a web preview')
      return
    }
    this.find = { ...this.find, open: true, paneId: pane && isTerm(pane) ? pane.id : null }
    this.emit()
  }

  /** Typing searches once the keys stop for 120 ms, incrementally from the current match. */
  private debounceFind(): void {
    this.findDebounce?.()
    this.findDebounce = this.deps.setTimer(() => {
      this.findDebounce = null
      this.sendFind('next', true)
    }, FIND_DEBOUNCE_MS)
  }

  private cancelFindDebounce(): void {
    this.findDebounce?.()
    this.findDebounce = null
  }

  private stepFind(direction: 'next' | 'prev'): void {
    this.cancelFindDebounce()
    if (!this.find.open) this.openFind()
    this.sendFind(direction, false)
    this.emit()
  }

  private sendFind(direction: 'next' | 'prev', incremental: boolean): void {
    const paneId = this.find.paneId
    if (!paneId || !this.grids.has(paneId)) return
    if (this.find.query === '') {
      this.grid({ paneId, op: 'findClear' })
      return
    }
    this.grid({
      paneId,
      op: 'find',
      query: this.find.query,
      direction,
      caseSensitive: this.find.caseSensitive,
      regex: this.find.regex,
      incremental,
    })
  }

  private closeFind(): void {
    this.cancelFindDebounce()
    if (!this.find.open) return
    const paneId = this.find.paneId
    if (paneId && this.grids.has(paneId)) this.grid({ paneId, op: 'findClear' })
    this.find = { ...emptyFind(), caseSensitive: this.find.caseSensitive, regex: this.find.regex }
    this.emit()
  }

  // ---------------------------------------------------------------------------
  // Event routing
  // ---------------------------------------------------------------------------

  private keyEvent(target: string, key: string): void {
    // Escape on the restore card is Start fresh (RestoreCard.tsx:19-31).
    if (this.restoreCandidate) {
      if (key === 'Escape') this.declineRestore()
      return
    }
    if (this.renamingTabId && target === `tab:${this.renamingTabId}:rename`) {
      if (key === 'Enter') this.commitRename()
      else if (key === 'Escape') this.cancelRename()
      return
    }
    if (target === 'find:query') {
      if (key === 'Enter') this.stepFind('next')
      else if (key === 'Shift+Enter') this.stepFind('prev')
    }
    if (key === 'Escape') this.closeFind()
  }

  private tabEvent(parts: string[], type: UiEvent['type']): void {
    if (parts[1] === 'new') {
      if (type === 'click') this.newTab()
      return
    }
    const id = parts[1]
    if (!id) return
    const tab = this.s.tabs.find((t) => t.id === id)
    if (!tab) return
    const sub = parts[2]
    if (sub === 'close') {
      if (type === 'click') void this.closeTab(id)
      return
    }
    if (sub === 'rename') return
    // A tab selects on press (app.tsx onMouseDown); a double-click renames it.
    if (type === 'down' || type === 'click') {
      if (this.renamingTabId && this.renamingTabId !== id) this.commitRename()
      if (this.s.activeTabId !== id) this.dispatch({ type: 'tab.select', tabId: id })
    } else if (type === 'dblclick') {
      this.startRename(tab)
    }
  }

  private paneEvent(parts: string[], type: UiEvent['type']): void {
    const id = parts[1]
    const sub = parts[2]
    if (!id || !this.activeTab()?.panes[id]) return
    if (sub === 'close') {
      if (type === 'click') void this.closePane(id)
      return
    }
    if (sub && PHASE2_TARGETS[sub]) {
      if (type === 'click') this.toast(`${PHASE2_TARGETS[sub]} arrives in phase 2`)
      return
    }
    if (sub === 'restart') {
      if (type === 'click') this.restartPane(id)
      return
    }
    if (type === 'down' || type === 'click') {
      if (this.activeTab()?.focusedPaneId !== id) this.dispatch({ type: 'pane.focus', paneId: id })
      if (sub === 'grid' && type === 'down') this.grid({ paneId: id, op: 'focus' })
    } else if (type === 'dblclick' && sub === 'title') {
      // Double-clicking a title bar fills the tab with that pane (PaneView.tsx:177-180).
      this.dispatch({ type: 'pane.zoom', paneId: id })
    }
  }

  private findEvent(what: string, type: UiEvent['type']): void {
    if (type !== 'click') return
    switch (what) {
      case 'next':
        this.stepFind('next')
        break
      case 'prev':
        this.stepFind('prev')
        break
      case 'close':
        this.closeFind()
        break
      case 'case':
        this.find = { ...this.find, caseSensitive: !this.find.caseSensitive, count: null, miss: false }
        this.sendFind('next', true)
        this.emit()
        break
      case 'regex':
        this.find = { ...this.find, regex: !this.find.regex, count: null, miss: false }
        this.sendFind('next', true)
        this.emit()
        break
      default:
        break
    }
  }

  private chromeClick(target: string): void {
    switch (target) {
      case 'zoom:badge':
        this.setZoom(DEFAULT_ZOOM_INDEX)
        break
      case 'sleep':
        this.ui = { ...this.ui, settings: { ...this.ui.settings, attentionGlow: !this.ui.settings.attentionGlow } }
        this.saveUi()
        this.emit()
        break
      case 'settings':
        this.command('app.settings')
        break
      case 'empty:newtab':
        this.newTab()
        break
      case 'pane:new':
        this.newPane()
        break
      case 'web:new':
        this.command('preview.web')
        break
      case 'restore:yes':
        this.acceptRestore()
        break
      case 'restore:fresh':
        this.declineRestore()
        break
      default:
        break
    }
  }

  /** Divider drag, `app.tsx:1219-1252`: the pointer is relative to the grid area. */
  private dividerEvent(id: string, e: Extract<UiEvent, { x: number }>): void {
    if (e.type === 'down') {
      const tab = this.activeTab()
      const area = this.area()
      const laid = this.laidActive()
      const spec = laid?.specs.get(id)
      if (!tab || !area || !spec || tab.zoomedPaneId) return
      this.drag = { tabId: tab.id, spec, area, cell: this.windowCell(), tree: tab.tree }
      return
    }
    const d = this.drag
    if (!d) return
    if (e.type === 'move' || e.type === 'up') {
      const pointer = d.spec.orientation === 'v' ? e.x - d.area.x : e.y - d.area.y
      const tree = applyDividerDrag(d.tree, d.spec, pointer, { width: d.area.w, height: d.area.h }, d.cell)
      d.tree = tree
      if (this.s.activeTabId === d.tabId) this.dispatch({ type: 'layout.setTree', tree, pristine: false })
    }
    if (e.type === 'up') this.drag = null
  }

  // ---------------------------------------------------------------------------
  // Restore card and the session snapshot
  // ---------------------------------------------------------------------------

  /** `app.tsx:1364-1379`: rebuild the saved tabs; nothing to reap, this is boot. */
  private acceptRestore(): void {
    const snap = this.restoreCandidate
    if (!snap) return
    this.restoreCandidate = null
    this.restoring = true
    this.emit()
    void restoreSavedTabs(snap.tabs, this.deps.invoke.bind(this.deps), uid)
      .catch(() => [] as TabState[])
      .then((restored) => {
        this.restoring = false
        if (restored.length === 0) this.newTab()
        else this.dispatch({ type: 'tabs.replace', tabs: restored })
      })
  }

  private declineRestore(): void {
    if (!this.restoreCandidate) return
    this.restoreCandidate = null
    void this.deps.invoke('session:clear', undefined).catch(() => undefined)
    this.newTab()
  }

  /** The 30 s snapshot clock (`app.tsx:624-634`), re-armed after every tick. */
  private armSnapshot(): void {
    if (this.snapshotArmed) return
    this.snapshotArmed = true
    const tick = (): void => {
      this.deps.setTimer(tick, SNAPSHOT_INTERVAL_MS)
      void this.snapshot(false)
    }
    this.deps.setTimer(tick, SNAPSHOT_INTERVAL_MS)
  }

  /**
   * `app.tsx:584-619`: write the window to the last-session file when it
   * changed, or clear the file when the window is not worth offering back.
   * `force` is the quit path and always answers. Never while the restore card
   * is up or a restore is landing: a snapshot of no tabs would clear the very
   * file the user is being offered.
   */
  private async snapshot(force: boolean): Promise<void> {
    if (this.restoreCandidate || this.restoring || this.s.tabs.length === 0) return
    const { lookup, proven } = await collectSaveLookup(this.s, this.deps.invoke.bind(this.deps))
    if (Object.keys(proven).length > 0) this.dispatch({ type: 'panes.sessionIds', ids: proven })
    const tabs = snapshotTabs(this.s, lookup)
    try {
      if (!shouldOfferRestore(tabs)) {
        if (force || this.lastSnapshot !== '') {
          this.lastSnapshot = ''
          await this.deps.invoke('session:clear', undefined)
        }
        return
      }
      const encoded = JSON.stringify(tabs)
      if (!force && encoded === this.lastSnapshot) return
      await this.deps.invoke('session:save', { tabs })
      this.lastSnapshot = encoded
    } catch {
      // Fires on a timer and at quit; the next write simply overwrites.
    }
  }

  /**
   * The renderer stops a `done` pulse on the first metrics tick after 9 s
   * (store.ts metrics case). The core also arms a timer so the pulse ends on
   * time when ticks are sparse; the reducer's own expiry still applies.
   */
  private armDoneExpiry(): void {
    for (const tab of this.s.tabs) {
      for (const p of Object.values(tab.panes)) {
        if (p.attention !== 'done') {
          const cancel = this.doneTimers.get(p.id)
          if (cancel) {
            cancel()
            this.doneTimers.delete(p.id)
          }
          continue
        }
        if (this.doneTimers.has(p.id)) continue
        const at = p.attentionAt
        this.doneTimers.set(
          p.id,
          this.deps.setTimer(() => {
            this.doneTimers.delete(p.id)
            const now = paneById(this.s, p.id)
            if (!now || now.attention !== 'done' || now.attentionAt !== at) return
            this.s = mapPane(this.s, p.id, (x) => ({ ...x, attention: undefined, attentionAt: undefined }))
            this.emit()
          }, DONE_ATTENTION_MS)
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // State plumbing
  // ---------------------------------------------------------------------------

  private dispatch(action: Action): void {
    const prevToast = this.s.toast
    this.s = reducer(this.s, action)
    if (this.s.toast !== prevToast) this.armToast()
    this.sync()
    this.emit()
  }

  private toast(message: string): void {
    this.s = reducer(this.s, { type: 'toast', message })
    this.armToast()
    this.emit()
  }

  /** `app.tsx:1255-1259`: each new toast restarts the 3.2 s clock. */
  private armToast(): void {
    this.toastCancel?.()
    this.toastCancel = null
    if (this.s.toast === null) return
    this.toastCancel = this.deps.setTimer(() => {
      this.toastCancel = null
      this.s = reducer(this.s, { type: 'toast', message: null })
      this.emit()
    }, TOAST_MS)
  }

  private saveUi(): void {
    if (this.uiFile) saveUiState(this.uiFile, this.ui)
  }

  private activeTab(): TabState | undefined {
    return this.s.tabs.find((t) => t.id === this.s.activeTabId)
  }

  private focusedTermId(): string | null {
    const tab = this.activeTab()
    const pane = tab?.focusedPaneId ? tab.panes[tab.focusedPaneId] : undefined
    return pane && isTerm(pane) && this.grids.has(pane.id) ? pane.id : null
  }

  private focusGrid(): void {
    const id = this.focusedTermId()
    if (id) this.grid({ paneId: id, op: 'focus' })
  }

  private grid(cmd: GridCmd): void {
    this.deps.toShell('grid:cmd', cmd)
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  private uiScale(): number {
    return levelAt(this.ui.zoomIndex).ui
  }

  /** The grid area in DIP: the client area below the tab strip and above the status bar. */
  private area(): Rect | null {
    const g = this.geo
    if (!g) return null
    const scale = g.dpi > 0 ? g.dpi / 96 : 1
    const ui = this.uiScale()
    const top = TAB_STRIP_PX * ui
    const w = g.clientW / scale
    const h = g.clientH / scale - top - STATUS_PX * ui
    return { x: 0, y: top, w: Math.max(0, w), h: Math.max(0, h) }
  }

  /** The cell at `fontPx`, scaled from the one the shell measured. */
  private cellAt(fontPx: number): CellSize {
    const g = this.geo
    const cellW = g && g.cellW > 0 ? g.cellW : 7.8
    const cellH = g && g.cellH > 0 ? g.cellH : 15
    const f = fontPx / this.geoFontPx
    return { cellW: cellW * f, cellH: cellH * f }
  }

  private windowCell(): CellSize {
    return this.cellAt(levelAt(this.ui.zoomIndex).font)
  }

  private paneFontPx(p: PaneState): number {
    return levelAt(p.zoomIndex ?? this.ui.zoomIndex).font
  }

  private layTab(tab: TabState, area: Rect): LaidOut {
    const ui = this.uiScale()
    const fontFor = (id: string): CellSize => {
      const p = tab.panes[id]
      return this.cellAt(p ? this.paneFontPx(p) : levelAt(this.ui.zoomIndex).font)
    }
    if (tab.zoomedPaneId && tab.panes[tab.zoomedPaneId]) {
      // The zoomed pane fills the area; the others keep their tiled size, as hidden panes do in the renderer.
      const tiled = layOut(tab.tree, area, this.windowCell(), ui, fontFor)
      const z = layOutZoomed(tab.zoomedPaneId, area, ui, fontFor(tab.zoomedPaneId))
      for (const [k, v] of z.rects) tiled.rects.set(k, v)
      for (const [k, v] of z.gridRects) tiled.gridRects.set(k, v)
      for (const [k, v] of z.cols) tiled.cols.set(k, v)
      for (const [k, v] of z.rows) tiled.rows.set(k, v)
      tiled.dividers = []
      tiled.specs = new Map()
      return tiled
    }
    return layOut(tab.tree, area, this.windowCell(), ui, fontFor)
  }

  private laidActive(): LaidOut | null {
    const tab = this.activeTab()
    const area = this.area()
    return tab && area ? this.layTab(tab, area) : null
  }

  /**
   * Brings the shell's grids in line with the state: a grid for every terminal
   * pane in every tab (background tabs keep their sessions, as their hidden
   * PaneViews do in the renderer), resized when its cells change, disposed
   * when its pane is gone.
   */
  private sync(): void {
    const area = this.area()
    if (!area) return
    const live = new Set<string>()
    for (const tab of this.s.tabs) {
      const laid = this.layTab(tab, area)
      for (const pane of Object.values(tab.panes)) {
        if (!isTerm(pane)) continue
        live.add(pane.id)
        const cols = laid.cols.get(pane.id)
        const rows = laid.rows.get(pane.id)
        if (cols === undefined || rows === undefined) continue
        const fontPx = this.paneFontPx(pane)
        const have = this.grids.get(pane.id)
        if (!have) {
          this.grids.set(pane.id, { cols, rows, fontPx })
          this.grid({ paneId: pane.id, op: 'create', cols, rows, fontPx, scrollback: SCROLLBACK })
          this.spawn(pane, cols, rows)
        } else if (have.cols !== cols || have.rows !== rows || have.fontPx !== fontPx) {
          this.grids.set(pane.id, { cols, rows, fontPx })
          this.grid({ paneId: pane.id, op: 'resize', cols, rows, fontPx })
          if (have.cols !== cols || have.rows !== rows) this.deps.send('pty:resize', { paneId: pane.id, cols, rows })
        }
      }
    }
    for (const id of [...this.grids.keys()]) {
      if (live.has(id)) continue
      this.grids.delete(id)
      for (const key of [...this.spawned]) if (key.startsWith(`${id}:`)) this.spawned.delete(key)
      if (this.find.paneId === id) this.find = { ...this.find, paneId: null, count: null }
      this.grid({ paneId: id, op: 'dispose' })
    }
  }

  /**
   * `PaneView.tsx:397-430`: spawn once the grid's size is known, so the child
   * never starts at a wrong size; then type the launch command 300 ms later.
   */
  private spawn(pane: PaneState, cols: number, rows: number): void {
    const key = `${pane.id}:${pane.generation ?? 0}`
    if (this.spawned.has(key)) return
    this.spawned.add(key)
    const file = this.paths?.defaultShell || '/bin/zsh'
    void this.deps
      .invoke<PtySpawnResponse>('pty:spawn', { paneId: pane.id, file, args: ['-l'], cwd: pane.cwd, cols, rows })
      .then((res) => {
        if (res && res.ok) {
          if (paneById(this.s, pane.id)) this.dispatch({ type: 'pane.spawned', paneId: pane.id, pid: res.pid })
          const text = launchCommandText(pane)
          if (text) {
            this.deps.setTimer(() => {
              if (paneById(this.s, pane.id)) this.deps.send('pty:write', { paneId: pane.id, data: `${text}\r` })
            }, LAUNCH_DELAY_MS)
          }
        } else {
          this.spawned.delete(key)
          const err = res && !res.ok ? `${res.code} - ${res.message}` : 'no reply'
          this.toast(`Failed to start shell: ${err}`)
        }
      })
      .catch((err: unknown) => {
        this.spawned.delete(key)
        this.toast(`Failed to start shell: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  // ---------------------------------------------------------------------------
  // The model
  // ---------------------------------------------------------------------------

  /** One `ui:model` per macrotask, however many mutations ran in it. */
  private emit(): void {
    if (this.emitQueued) {
      this.last = this.build()
      return
    }
    this.emitQueued = true
    this.last = this.build()
    queueMicrotask(() => {
      this.emitQueued = false
      this.last = this.build()
      this.deps.toShell('ui:model', this.last)
    })
  }

  private build(): UiModel {
    const level = levelAt(this.ui.zoomIndex)
    const ui = level.ui
    const tab = this.activeTab()
    const area = this.area()
    const laid = tab && area ? this.layTab(tab, area) : null
    const panesAreZoomed = this.s.tabs.some((t) => Object.values(t.panes).some((p) => p.zoomIndex !== undefined))
    const order = tab ? dfsPaneOrder(tab.tree) : []
    const panes: PaneModel[] = []
    if (tab && laid) {
      order.forEach((id, i) => {
        const p = tab.panes[id]
        const rect = laid.rects.get(id)
        const gridRect = laid.gridRects.get(id)
        if (!p || !rect || !gridRect) return
        panes.push(this.paneModel(p, i + 1, rect, gridRect, laid.cols.get(id) ?? 1, laid.rows.get(id) ?? 1, tab.focusedPaneId === id))
      })
    }
    const restore = this.restoreCandidate
    return {
      seq: ++this.seq,
      window: { title: 'SeaShell', uiScale: ui, fontPx: level.font, tabStripH: TAB_STRIP_PX * ui, statusH: STATUS_PX * ui },
      tabs: this.s.tabs.map((t) => ({ id: t.id, name: t.name, active: t.id === this.s.activeTabId, renaming: t.id === this.renamingTabId })),
      tabFull: tab ? Object.keys(tab.panes).length >= MAX_PANES_PER_TAB : false,
      sleep: !this.ui.settings.attentionGlow,
      zoomBadge:
        this.ui.zoomIndex !== DEFAULT_ZOOM_INDEX || panesAreZoomed
          ? `${zoomPercent(this.ui.zoomIndex)}%${panesAreZoomed ? '*' : ''}`
          : null,
      panes,
      dividers: laid?.dividers ?? [],
      zoomedPaneId: tab?.zoomedPaneId ?? null,
      emptyState: !this.booting && !this.restoring && this.s.tabs.length === 0 && restore === null,
      starting: this.booting || this.restoring,
      find: { ...this.find },
      restore: restore
        ? {
            tabs: restore.tabs.length,
            panes: restore.tabs.reduce((n, t) => n + Object.keys(t.panes).length, 0),
            savedAt: restore.savedAt,
          }
        : null,
      toast: this.s.toast,
      status: statusModel(tab, this.s.system, this.deps.platform),
      chords: this.opts.chords,
      tokens: {},
    }
  }

  private paneModel(p: PaneState, index: number, rect: Rect, gridRect: Rect, cols: number, rows: number, focused: boolean): PaneModel {
    // Title bar contents as PaneView.tsx:140-220 draws them.
    const bytes = p.metrics?.footprintBytes ?? 0
    const showMem = isTerm(p) && bytes >= 200 * 1024 * 1024
    const badge = p.kind === 'file' ? 'file' : p.kind === 'web' ? 'web' : p.metrics?.foregroundProcess || (p.command === 'zsh' ? 'zsh' : p.command)
    return {
      id: p.id,
      kind: p.kind,
      rect,
      gridRect,
      cols,
      rows,
      index,
      label: p.label,
      tooltip: p.filePath ?? p.url ?? p.cwd,
      badge,
      memBadge: showMem ? `~${mem(bytes)}` : null,
      memHigh: showMem && bytes > 1e9,
      zoomPercent: p.zoomIndex !== undefined ? zoomPercent(p.zoomIndex) : null,
      fontPx: this.paneFontPx(p),
      color: paneColorHex(p.color),
      focused,
      attention: p.attention ?? 'none',
      status: p.status,
      exit:
        p.status === 'exited' && p.exit
          ? {
              // Truthy, as PaneView.tsx:558: node-pty reports signal 0 for a plain exit.
              text: p.exit.signal ? `killed · signal ${p.exit.signal}` : `exited · code ${p.exit.code}`,
              failed: p.exit.code !== 0,
            }
          : null,
      linked: p.linkId !== undefined,
      linkEnabled: isTerm(p),
    }
  }
}

/** One pane replaced wherever it lives (store.ts mapPane, which is not exported). */
function mapPane(state: AppState, paneId: string, fn: (p: PaneState) => PaneState): AppState {
  let changed = false
  const tabs = state.tabs.map((t) => {
    const p = t.panes[paneId]
    if (!p) return t
    changed = true
    return { ...t, panes: { ...t.panes, [paneId]: fn(p) } }
  })
  return changed ? { ...state, tabs } : state
}

