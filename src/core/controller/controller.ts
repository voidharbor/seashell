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
 * strings in `status.ts`, the file explorer's tree in `explorer.ts`.
 * The shell drawer (`DrawerShell.tsx`) is one more grid per pane, here.
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
import { tokenizeLine } from '../../renderer/links/tokenizer.js'
import { resolvePathClick } from '../../renderer/links/resolve.js'
import { clampSidebar, SIDEBAR_DEFAULT, widthFromDrag } from '../../renderer/layout/sidebar.js'
import { openPath as routeOpen, type OpenDeps } from '../../renderer/explorer/open.js'
import { clampDrawer, drawerHeightFromDrag } from '../../renderer/layout/drawer.js'
import { cdCommandFor } from '../../renderer/drawer/cd.js'
import { DRAWER_PTY_PREFIX, drawerPtyId } from '../../renderer/drawer/id.js'
import { chordLabel } from '../../shared/keys.js'
import type {
  AppPaths,
  FsProbeResponse,
  LastSession,
  MetricsTickEvent,
  OpenPathResponse,
  PtyKillResponse,
  PtySpawnResponse,
} from '../../shared/ipc.js'
import { DRAWER_HEADER_DIP, drawerRects, layOut, layOutZoomed, splitBody, type BodySplit, type LaidOut } from './layout.js'
import { ExplorerState, FLASH_MS, type Listing } from './explorer.js'
import { defaultUiState, loadUiState, saveUiState, type UiState } from './ui-state.js'
import { collectSaveLookup, restoreSavedTabs, snapshotTabs, SNAPSHOT_INTERVAL_MS } from './session.js'
import { mem, statusModel } from './status.js'
import { colorizationToTokens, isColorization } from './colorization.js'
import type {
  ChordModel,
  DrawerModel,
  FindModel,
  Geometry,
  GridCmd,
  Mods,
  PaneModel,
  Rect,
  SidebarModel,
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
  /** One line to the core's log (stderr); optional so tests need not pass it. */
  log?(line: string): void
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
  'help.tutorial': 'The tutorial',
  'app.projects': 'Projects',
  'app.saveProject': 'Save project',
  'app.saveTab': 'Save tab as project',
  'app.settings': 'Settings',
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

/**
 * One pane's drawer shell (`DrawerShell.tsx`): its pty and its grid in the
 * shell, both under `drawer:<paneId>`. Never in a tab's state, never saved.
 */
interface DrawerShell {
  status: 'starting' | 'live' | 'exited'
  /** Its own OSC title and OSC 7 cwd, for the header and `showCd`. */
  title: string
  cwd: string
  /** The size the shell's grid has. */
  grid: GridInfo
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

/** The sidebar as the wire sends it when its rows are the ones the shell already has. */
function withoutRows(sb: SidebarModel): Omit<SidebarModel, 'rows'> {
  const { rows: _rows, ...rest } = sb
  return rest
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
  /** The Aero tokens from the shell's `shell:colorization`; the 6.2 table until it reports. */
  private tokens: Record<string, string> = { ...colorizationToTokens(null), composition: '1' }
  /** The file explorer while the sidebar shows; null while hidden, as the renderer unmounts it. */
  private explorer: ExplorerState | null = null
  /** The row context menu: the row it is for and where it opened. */
  private sbMenu: { path: string; isDir: boolean; x: number; y: number } | null = null
  private gripDrag = false
  private revealSeq = 0
  private revealRowId: string | null = null
  /** `SidebarModel.rowsSeq`, and the explorer and its `version` it last numbered. */
  private rowsSeq = 0
  private rowsOf: { x: ExplorerState | null; version: number } = { x: null, version: 0 }
  /** The `rowsSeq` of the last `ui:model` sent; -1 so the first one carries its rows. */
  private rowsSent = -1
  /** Bumped by every reveal and by hiding, so an older reveal still reading stops. */
  private revealToken = 0
  private flashCancel: (() => void) | null = null
  /** The shell drawer is open (runtime only, as `app.tsx:100-102`). */
  private drawerOpen = false
  /** The keyboard is in the drawer's grid rather than the pane's. */
  private drawerFocused = false
  /** Every pane that has a drawer shell, by pane id (`app.tsx:105-112`). */
  private readonly drawers = new Map<string, DrawerShell>()
  /** The pane whose drawer shows; a fresh show of an exited shell respawns it. */
  private drawerShown: string | null = null
  /** The grip drag: the grid area's bottom edge, measured at the press (`app.tsx:267-292`). */
  private drawerDrag: { bottom: number } | null = null
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
        const id = this.editTargetId()
        if (id) this.grid({ paneId: id, op: 'clear' })
        break
      }
      case 'layout.rebalance':
        this.dispatch({ type: 'layout.rebalance' })
        break
      case 'explorer.toggle':
        this.toggleSidebar()
        break
      // app.tsx:935-937: the hint, and the explorer opened (left as it is when already open).
      case 'preview.file':
        this.toast('Double-click a path in a pane, or a file in the explorer, to preview it')
        if (!this.sidebarOpen()) this.showSidebar(true)
        break
      case 'explorer.refresh':
        this.refreshExplorer()
        break
      case 'drawer.toggle':
        this.toggleDrawer()
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
        const id = this.editTargetId()
        if (id) this.grid({ paneId: id, op: 'copy' })
        break
      }
      case 'edit.paste':
        // The text arrives with the command from the shell (see push).
        break
      case 'edit.selectAll': {
        const id = this.editTargetId()
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
    // A press anywhere outside the explorer's menu closes it, and so does
    // Escape from anywhere (Explorer.tsx:61-84, capture-phase listeners).
    if (this.sbMenu && e.type === 'down' && t !== 'sidebar:menu' && !t.startsWith('sidebar:menu:')) this.closeMenu()
    if (this.sbMenu && e.type === 'key' && e.key === 'Escape') {
      this.closeMenu()
      return
    }
    if (t.startsWith('sidebar:')) {
      this.sidebarEvent(t.slice('sidebar:'.length), e)
      return
    }
    // A right or middle press reaches the core only to close the explorer's
    // menu: it starts no drag, selects no tab and focuses no pane.
    const sidePress = e.type === 'down' && e.button !== 0
    if (t.startsWith('divider:')) {
      if ((e.type === 'down' && !sidePress) || e.type === 'move' || e.type === 'up') this.dividerEvent(t.slice('divider:'.length), e)
      return
    }
    if (t.startsWith('drawer:')) {
      this.drawerEvent(t.slice('drawer:'.length), e)
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
    if (e.type === 'focus' || e.type === 'wheel' || e.type === 'drop' || e.type === 'up' || e.type === 'move' || sidePress) return

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
        if (e.paneId.startsWith(DRAWER_PTY_PREFIX)) {
          // The drawer's header shows its shell's title whatever the setting (DrawerShell.tsx onTitle).
          const d = this.drawerOf(e.paneId)
          if (d && typeof e.title === 'string') {
            d.title = e.title
            this.emit()
          }
          break
        }
        // app.tsx:1670-1673: the setting gates it; the reducer keeps a custom label.
        if (this.ui.settings.autoTitlePanes && typeof e.title === 'string') {
          this.dispatch({ type: 'pane.autoTitle', paneId: e.paneId, title: e.title })
        }
        break
      case 'cwd': {
        const cwd = this.trustedCwd(e.cwd)
        if (e.paneId.startsWith(DRAWER_PTY_PREFIX)) {
          // The drawer tracks its own cwd, for `showCd` and its path clicks.
          const d = this.drawerOf(e.paneId)
          if (d && cwd) {
            d.cwd = cwd
            this.emit()
          }
          break
        }
        if (cwd && paneById(this.s, e.paneId)) this.dispatch({ type: 'pane.cwd', paneId: e.paneId, cwd, home: this.home })
        break
      }
      case 'bell':
        // A drawer's bell is not a pane asking for attention.
        if (!e.paneId.startsWith(DRAWER_PTY_PREFIX)) this.dispatch({ type: 'pane.bell', paneId: e.paneId, at: this.deps.now() })
        break
      case 'pathclick':
        void this.pathClick(e.paneId, e.line, e.index, e.mods)
        break
      default:
        // Selections are the shell's own business.
        break
    }
  }

  /**
   * `PaneView.tsx:364-387` onDoubleClick over the shell's logical line: the
   * candidate under the clicked character, resolved against the pane's cwd (a
   * drawer's click against the drawer's own cwd). A hit is always revealed in
   * the explorer, whatever the modifiers; a directory stops there (the reveal
   * expands it). On a file, Ctrl opens it the way the explorer does (a file
   * pane for what main routes to the viewer) and Ctrl+Alt hands it to its
   * default app. A miss toasts its message; no candidate under the click
   * stays silent, as it does in the renderer.
   */
  private async pathClick(paneId: string, line: string, index: number, mods?: Mods): Promise<void> {
    const cwd = this.clickCwd(paneId)
    if (cwd === null || typeof line !== 'string' || !Number.isInteger(index)) return
    const cand = tokenizeLine(line).find((c) => index >= c.start && index < c.end)
    if (!cand) return
    const searchRoot = this.home
    try {
      const out = await resolvePathClick(
        {
          hit: { path: cand.path, start: cand.start, end: cand.end, absY: 0 },
          rows: { prevRow: null, nextRow: null, startCol: cand.start, endCol: cand.end, cols: line.length },
          cwd,
          searchRoot,
        },
        {
          statBatch: (req) => this.deps.invoke('fs:statBatch', req),
          findBySuffix: (req) => this.deps.invoke('fs:findBySuffix', req),
        }
      )
      if (out.kind === 'miss') {
        this.toast(out.message)
        return
      }
      const { resolved, isDir } = out.hit
      const shown = this.reveal(resolved, isDir)
      if (!isDir && mods?.ctrl) await this.openPath(resolved, mods.alt ? 'os' : undefined)
      await shown
    } catch (err) {
      this.deps.log?.(`pathclick failed: ${(err as Error).message}`)
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
        if (x.paneId.startsWith(DRAWER_PTY_PREFIX)) {
          // No pane has this id (the store would ignore it), and no overlay: the next show respawns.
          this.drawerExited(x.paneId)
          break
        }
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
      case 'shell:colorization': {
        // DwmGetColorizationColor and DwmIsCompositionEnabled, at start and on
        // WM_DWMCOLORIZATIONCOLORCHANGED / WM_DWMCOMPOSITIONCHANGED.
        const c = p as { argb?: unknown; opaque?: unknown; composition?: unknown } | null
        const argb = typeof c?.argb === 'string' ? c.argb : null
        // A missing or malformed colorization (DWM off, a remote session) paints
        // the opaque strip, as composition off does (Review Focus 5).
        const glass = c?.composition !== false && isColorization(argb)
        this.tokens = { ...colorizationToTokens(argb, c?.opaque === true), composition: glass ? '1' : '0' }
        this.emit()
        break
      }
      case 'session:requestSnapshot':
        // The quit path: always answer, changed or not (app.tsx:629).
        void this.snapshot(true)
        break
      case 'watch:changed': {
        // A watched directory changed: re-list it in place while it is open (Explorer.tsx:188-202).
        const dir = (p as { dir?: unknown } | null)?.dir
        const x = this.sidebarOpen()
        if (x && typeof dir === 'string' && x.expanded.has(dir)) void this.readDir(x, dir)
        break
      }
      case 'watch:lost': {
        // No UI and no resubscribe: the directory stops auto-refreshing until
        // it is collapsed and re-expanded; the refresh button still reads it.
        const dir = (p as { dir?: unknown } | null)?.dir
        if (typeof dir === 'string') this.explorer?.markLost(dir)
        break
      }
      default:
        // update:state belongs to Phase 2 (the update banner).
        break
    }
  }

  /**
   * `app.tsx:1018-1065`, for a terminal pane. The shell read the clipboard and
   * sends its text. Quoted `C:\` paths (Explorer's "Copy as path") paste as
   * quoted WSL paths; no text at all asks main for copied files, then for a
   * screenshot saved as a PNG. Ordinary text is untouched. The target is
   * resolved before anything awaits, so a focus change cannot redirect it;
   * it is the drawer while the drawer holds the keyboard.
   */
  private async paste(text: string): Promise<void> {
    const id = this.editTargetId()
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
      if (out && this.hasGrid(id)) this.grid({ paneId: id, op: 'paste', text: out })
      return
    }
    if (!text) {
      let image = ''
      try {
        image = await this.deps.invoke<string>('clipboard:image', undefined)
      } catch {
        image = ''
      }
      if (typeof image === 'string' && image && this.hasGrid(id)) {
        this.grid({ paneId: id, op: 'paste', text: dropText({ paths: [image] }, platform) })
      }
      return
    }
    if (this.hasGrid(id)) this.grid({ paneId: id, op: 'paste', text })
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
      if (sub === 'grid' || sub === 'title') this.blurDrawer()
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
  // The file explorer (Explorer.tsx; its tree lives in explorer.ts)
  // ---------------------------------------------------------------------------

  /**
   * Shows `p` in the explorer (`app.tsx:820-830`, then `Explorer.tsx:220-266`).
   * A path outside the root only toasts. Otherwise the sidebar opens, every
   * directory on the chain is re-read (the path was just found to exist, so it
   * is newer than any cached listing) and expanded, and the row is selected,
   * scrolled to the centre (`revealSeq`) and flashed for 2.5 s. Resolves once
   * the chain's reads have landed; a newer reveal, or hiding the sidebar,
   * abandons this one.
   */
  async reveal(p: string, isDir: boolean): Promise<void> {
    const root = this.s.explorerRoot
    if (!root || typeof p !== 'string' || p === '') return
    if (!(p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`))) {
      this.toast(`${p} is outside the file explorer`)
      return
    }
    const token = ++this.revealToken
    const shown = this.sidebarOpen()
    const x = shown ?? this.showSidebar(false)
    if (!x) return
    const chain = x.revealChain(p, isDir, x.root)
    if (!shown && !chain.includes(x.root)) void this.readDir(x, x.root)
    for (const dir of chain) {
      await this.readDir(x, dir)
      if (token !== this.revealToken || this.explorer !== x) return
    }
    for (const dir of chain) x.expand(dir)
    x.select(p)
    this.revealRowId = `row:${p}`
    this.revealSeq++
    this.flashRow(x, p)
    this.syncWatches()
    this.emit()
  }

  /** `explorer.toggle` (`app.tsx:952-954`). */
  private toggleSidebar(): void {
    if (this.sidebarOpen()) this.hideSidebar()
    else this.showSidebar(true)
  }

  private sidebarOpen(): ExplorerState | null {
    return this.s.sidebarVisible ? this.explorer : null
  }

  /**
   * Mounting `Explorer` (`app.tsx:1567-1580`, `Explorer.tsx:96-103`): a fresh
   * tree at the root with the root open, read here unless the caller reads it.
   */
  private showSidebar(read: boolean): ExplorerState | null {
    const root = this.s.explorerRoot
    if (!root) return null
    const x = new ExplorerState(root, this.home)
    x.expand(root)
    this.explorer = x
    if (!this.s.sidebarVisible) {
      this.dispatch({ type: 'explorer.toggle' })
    } else {
      this.sync()
      this.emit()
    }
    if (read) void this.readDir(x, root)
    this.syncWatches()
    return x
  }

  /** Unmounting it: every watch goes with the tree (`Explorer.tsx:180-186`). */
  private hideSidebar(): void {
    const x = this.explorer
    this.explorer = null
    this.sbMenu = null
    this.gripDrag = false
    this.revealRowId = null
    this.revealToken++
    this.flashCancel?.()
    this.flashCancel = null
    if (x) for (const dir of [...x.subscribed]) this.deps.send('watch:unsubscribe', { dir })
    if (this.s.sidebarVisible) this.dispatch({ type: 'explorer.toggle' })
    else this.emit()
  }

  /** `Explorer.tsx:86-94`; `respectGitignore` so ignored entries come back flagged, to dim. */
  private async readDir(x: ExplorerState, dir: string): Promise<void> {
    const seq = x.nextRead()
    let res: Listing
    try {
      res = await this.deps.invoke<Listing>('fs:readDir', { path: dir, respectGitignore: true })
    } catch (err) {
      this.deps.log?.(`readDir failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (this.explorer !== x || !x.applyListing(dir, res, seq)) return
    this.syncWatches()
    this.emit()
  }

  /**
   * Keeps main's watch pool on what is expanded (`Explorer.tsx:134-178`):
   * subscribe what became watchable, unsubscribe what stopped being, and when
   * the set changed touch the live ones so the pool evicts what nobody is
   * looking at. A directory is marked before its send, so a `watch:lost`
   * reported inside the send finds it subscribed and it is never asked twice.
   */
  private syncWatches(): void {
    const x = this.explorer
    if (!x) return
    const { subscribe, unsubscribe } = x.watchDiff(x.subscribed)
    if (subscribe.length === 0 && unsubscribe.length === 0) return
    for (const dir of subscribe) {
      x.subscribed.add(dir)
      this.deps.send('watch:subscribe', { dir })
    }
    for (const dir of unsubscribe) {
      x.subscribed.delete(dir)
      x.lost.delete(dir)
      this.deps.send('watch:unsubscribe', { dir })
    }
    for (const dir of [...x.subscribed]) if (!x.lost.has(dir)) this.deps.send('watch:touch', { dir })
  }

  /** The refresh command and the header's button: re-read every open directory (`Explorer.tsx:105-113`). */
  private refreshExplorer(): void {
    const x = this.sidebarOpen()
    if (!x) return
    for (const dir of [...x.expanded]) void this.readDir(x, dir)
  }

  /**
   * `Explorer.tsx:204-218`, except that opening re-reads a directory even
   * when a listing is cached: a shut directory is not watched, so the cache
   * may be stale. The cached rows show until the new ones land.
   */
  private toggleDir(x: ExplorerState, dir: string): void {
    if (x.toggle(dir)) void this.readDir(x, dir)
    this.syncWatches()
    this.emit()
  }

  /** The reveal highlight (`Explorer.tsx:259`); a newer reveal restarts it. */
  private flashRow(x: ExplorerState, p: string): void {
    this.flashCancel?.()
    x.flash = { path: p, until: this.deps.now() + FLASH_MS }
    this.flashCancel = this.deps.setTimer(() => {
      this.flashCancel = null
      if (this.explorer !== x || x.flash?.path !== p) return
      x.flash = null
      this.emit()
    }, FLASH_MS)
  }

  private closeMenu(): void {
    if (!this.sbMenu) return
    this.sbMenu = null
    this.emit()
  }

  private sidebarEvent(what: string, e: UiEvent): void {
    const x = this.sidebarOpen()
    if (!x) return
    if (what === 'grip') {
      this.gripEvent(e)
      return
    }
    if (e.type !== 'click' && e.type !== 'dblclick') return
    if (what.startsWith('row:')) {
      this.rowEvent(x, what.slice('row:'.length), e)
      return
    }
    if (e.type !== 'click' || e.button !== 0) return
    if (what.startsWith('twisty:')) this.twistyClick(x, what.slice('twisty:'.length))
    else if (what.startsWith('menu:')) this.menuItem(what.slice('menu:'.length))
    else if (what === 'refresh') this.refreshExplorer()
    else if (what === 'strip') this.copyStrip(x)
    // `sidebar:empty` and `sidebar:menu` have no action; a press there already closed the menu.
  }

  /** `Explorer.tsx:311-343` for an entry, `:384-401` for the root row. */
  private rowEvent(x: ExplorerState, p: string, e: Extract<UiEvent, { button: 0 | 1 | 2 }>): void {
    const row = x.rows().find((r) => r.path === p)
    if (!row) return
    if (e.type === 'dblclick') {
      if (e.button !== 0) return
      if (row.isDir) this.toggleDir(x, p)
      else void this.openPath(p)
      return
    }
    if (e.button === 2) {
      // The root row binds no context menu (Explorer.tsx:384-401).
      if (p === x.root) return
      x.select(p)
      this.sbMenu = { path: p, isDir: row.isDir, x: e.x, y: e.y }
      this.emit()
    } else if (e.button === 0) {
      x.select(p)
      this.emit()
    }
  }

  /**
   * Finder toggles from the triangle without selecting (`Explorer.tsx:330-340`);
   * a file's empty twisty lets the click through to its row, which selects.
   */
  private twistyClick(x: ExplorerState, p: string): void {
    const row = x.rows().find((r) => r.path === p)
    if (!row) return
    if (row.isDir) {
      this.toggleDir(x, p)
    } else {
      x.select(p)
      this.emit()
    }
  }

  private menuItem(id: string): void {
    const m = this.sbMenu
    if (!m) return
    if (id === 'reveal') {
      this.closeMenu()
      void this.deps.invoke('open:revealInFinder', { path: m.path }).catch(() => undefined)
    } else if (id === 'open-outside' && !m.isDir) {
      this.closeMenu()
      void this.openPath(m.path, 'os')
    }
  }

  /** The path strip (`Explorer.tsx:444-475`): a silent copy reads as a dead click, so it always says so. */
  private copyStrip(x: ExplorerState): void {
    const text = x.selected ?? x.root
    void this.deps.invokeShell<{ ok?: unknown } | null>('clip:write', { text }).then(
      (r) => this.toast(r?.ok === true ? 'Copied path' : 'Could not copy the path'),
      () => this.toast('Could not copy the path')
    )
  }

  /**
   * The grip (`app.tsx:295-320`, `:1581-1590`): the pointer's x is the column's
   * rendered width, stored as a base width; saved once on release, and a
   * double-click resets it.
   */
  private gripEvent(e: UiEvent): void {
    if (e.type === 'down' && e.button !== 0) return
    if (e.type === 'dblclick') {
      this.setSidebarWidth(SIDEBAR_DEFAULT, true)
    } else if (e.type === 'down') {
      this.gripDrag = e.button === 0
    } else if ((e.type === 'move' || e.type === 'up') && this.gripDrag) {
      this.setSidebarWidth(widthFromDrag(e.x, this.uiScale()), e.type === 'up')
      if (e.type === 'up') this.gripDrag = false
    }
  }

  private setSidebarWidth(width: number, save: boolean): void {
    const w = clampSidebar(width)
    if (w !== this.ui.sidebarWidth) {
      this.ui = { ...this.ui, sidebarWidth: w }
      this.sync()
      this.emit()
    }
    if (save) this.saveUi()
  }

  /**
   * `Explorer.tsx:273-282`, `app.tsx:1335-1349`: what `explorer/open.ts`
   * routes through. The two `open:` channels go to main's handlers, which
   * guard the target and reach the shell through the shim's `shell`.
   */
  private openDeps(): OpenDeps {
    return {
      probe: (req) => this.deps.invoke<FsProbeResponse>('fs:probe', req),
      withDefaultApp: (req) => this.deps.invoke<OpenPathResponse>('open:withDefaultApp', req),
      revealInFinder: (req) => this.deps.invoke<OpenPathResponse>('open:revealInFinder', req),
      onOpenInViewer: (p) => this.openInViewer(p),
      onToast: (m) => this.toast(m),
    }
  }

  /** `open.ts` openPath; `force: 'os'` hands the file to its default app whatever the route. */
  private async openPath(p: string, force?: 'os'): Promise<void> {
    try {
      await routeOpen(p, this.openDeps(), force)
    } catch (err) {
      this.deps.log?.(`open failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * `pane.newFile` in the active tab, focused: one file pane per tab,
   * retargeted when another file opens (`store.ts:434-473`). The full-tab
   * refusal is checked here so its toast uses this platform's chord.
   */
  private openInViewer(p: string): void {
    const tab = this.activeTab()
    if (!tab) return
    const existing = Object.values(tab.panes).some((q) => q.kind === 'file')
    if (!existing && Object.keys(tab.panes).length >= MAX_PANES_PER_TAB) {
      this.toast(`Tab is full (${MAX_PANES_PER_TAB} panes) - open a new tab (${chordLabel('Cmd+T', this.deps.platform)})`)
      return
    }
    this.dispatch({ type: 'pane.newFile', path: p, autoColor: this.ui.settings.autoColorPanes })
    const file = Object.values(this.activeTab()?.panes ?? {}).find((q) => q.kind === 'file')
    if (file) this.dispatch({ type: 'pane.focus', paneId: file.id })
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
          if (force) this.deps.log?.('[core] snapshot cleared: nothing worth restoring')
        }
        return
      }
      const encoded = JSON.stringify(tabs)
      if (!force && encoded === this.lastSnapshot) return
      await this.deps.invoke('session:save', { tabs })
      this.lastSnapshot = encoded
      if (force) this.deps.log?.('[core] snapshot saved')
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

  /** The keyboard goes to the focused pane's grid (and so out of the drawer). */
  private focusGrid(): void {
    this.blurDrawer()
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

  /** The window body in DIP: the client area below the tab strip and above the status bar. */
  private body(): Rect | null {
    const g = this.geo
    if (!g) return null
    const scale = g.dpi > 0 ? g.dpi / 96 : 1
    const ui = this.uiScale()
    const top = TAB_STRIP_PX * ui
    const w = g.clientW / scale
    const h = g.clientH / scale - top - STATUS_PX * ui
    return { x: 0, y: top, w: Math.max(0, w), h: Math.max(0, h) }
  }

  /** The body split into the explorer column, its grip and the grid (`app.tsx:1562-1586`). */
  private split(): BodySplit | null {
    const body = this.body()
    if (!body) return null
    return splitBody(body, this.sidebarOpen() ? this.ui.sidebarWidth * this.uiScale() : null)
  }

  /** The grid area in DIP: the body less the explorer column and its grip while they show. */
  private area(): Rect | null {
    return this.split()?.grid ?? null
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
    this.syncDrawer(area)
  }

  /**
   * `PaneView.tsx:397-430`: spawn once the grid's size is known, so the child
   * never starts at a wrong size; then type the launch command 300 ms later.
   */
  private spawn(pane: PaneState, cols: number, rows: number): void {
    const key = `${pane.id}:${pane.generation ?? 0}`
    if (this.spawned.has(key)) return
    this.spawned.add(key)
    void this.ptySpawn(pane.id, pane.cwd, cols, rows)
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

  /** `zsh -l` under `paneId` at the grid's size: every pane's shell and every drawer's. */
  private ptySpawn(paneId: string, cwd: string, cols: number, rows: number): Promise<PtySpawnResponse> {
    const file = this.paths?.defaultShell || '/bin/zsh'
    return this.deps.invoke<PtySpawnResponse>('pty:spawn', { paneId, file, args: ['-l'], cwd, cols, rows })
  }

  // ---------------------------------------------------------------------------
  // The shell drawer (DrawerShell.tsx; app.tsx:1261-1329)
  // ---------------------------------------------------------------------------

  /**
   * The pane the drawer belongs to: the focused pane, or when that is not a
   * terminal (or none is focused, `app.tsx:1286-1300`) the pane it already
   * shows while that is still a terminal in this tab, so a file pane taking
   * focus (a path click, an explorer double-click) leaves the shell and its
   * keys where they were; failing both, the tab's first terminal.
   */
  private drawerPaneId(): string | null {
    const tab = this.activeTab()
    if (!tab) return null
    const focused = tab.focusedPaneId ? tab.panes[tab.focusedPaneId] : undefined
    if (focused && isTerm(focused)) return focused.id
    const shown = this.drawerShown ? tab.panes[this.drawerShown] : undefined
    if (shown && isTerm(shown)) return shown.id
    for (const id of dfsPaneOrder(tab.tree)) {
      const p = tab.panes[id]
      if (p && isTerm(p)) return id
    }
    return null
  }

  /** `drawer.toggle`: opening puts the keyboard in the drawer; closing hands it back to the pane. */
  private toggleDrawer(): void {
    if (this.drawerOpen) {
      this.closeDrawer()
      return
    }
    if (!this.drawerPaneId()) {
      this.toast('No terminal pane to open a shell for')
      return
    }
    this.drawerOpen = true
    this.drawerFocused = true
    this.sync()
    this.emit()
  }

  /** `app.tsx:1261-1276`: the pane that had the keyboard gets it back. */
  private closeDrawer(): void {
    if (!this.drawerOpen) return
    this.drawerOpen = false
    this.drawerDrag = null
    this.sync()
    this.focusGrid()
    this.emit()
  }

  private blurDrawer(): void {
    if (!this.drawerFocused) return
    this.drawerFocused = false
    this.emit()
  }

  /** The live cwd a pane's drawer starts in and `cd to pane` goes to (`app.tsx:1727`). */
  private paneCwd(p: PaneState): string {
    return p.metrics?.cwd || p.cwd || this.home
  }

  /**
   * After every state change: reap the drawer shells whose pane is gone
   * (`app.tsx:1306-1329`, so every way a pane dies is covered), then give the
   * shown pane its shell. A pane's first show spawns one lazily; a show after
   * its shell exited starts a fresh grid and shell (`DrawerShell.tsx:154-178`);
   * only the shown shell is resized, as hidden ones are never refit.
   */
  private syncDrawer(area: Rect): void {
    const live = new Set(this.s.tabs.flatMap((t) => Object.keys(t.panes)))
    for (const id of [...this.drawers.keys()]) {
      if (live.has(id)) continue
      this.drawers.delete(id)
      const ptyId = drawerPtyId(id)
      void this.deps.invoke<PtyKillResponse>('pty:kill', { paneId: ptyId }).catch(() => undefined)
      this.grid({ paneId: ptyId, op: 'dispose' })
    }
    const id = this.drawerOpen ? this.drawerPaneId() : null
    if (this.drawerOpen && !id) {
      // Nothing left to open a shell for: the drawer closes rather than sit open on nothing.
      this.drawerOpen = false
      this.drawerFocused = false
      this.drawerDrag = null
    }
    const fresh = id !== this.drawerShown
    this.drawerShown = id
    const pane = id ? paneById(this.s, id) : undefined
    if (!id || !pane) return
    const size = this.drawerGrid(area)
    const have = this.drawers.get(id)
    if (!have || (fresh && have.status === 'exited')) {
      this.startDrawerShell(pane, size, have)
      return
    }
    const g = have.grid
    if (g.cols === size.cols && g.rows === size.rows && g.fontPx === size.fontPx) return
    have.grid = size
    const ptyId = drawerPtyId(id)
    this.grid({ paneId: ptyId, op: 'resize', cols: size.cols, rows: size.rows, fontPx: size.fontPx })
    if (g.cols !== size.cols || g.rows !== size.rows) this.deps.send('pty:resize', { paneId: ptyId, cols: size.cols, rows: size.rows })
  }

  /** The drawer's grid size: its rect below the header, in the window's cell. */
  private drawerGrid(area: Rect): GridInfo {
    const ui = this.uiScale()
    const { gridRect } = drawerRects(area, this.ui.drawerHeight * ui, DRAWER_HEADER_DIP * ui)
    const fontPx = levelAt(this.ui.zoomIndex).font
    const cell = this.cellAt(fontPx)
    return { cols: Math.max(1, Math.floor(gridRect.w / cell.cellW)), rows: Math.max(1, Math.floor(gridRect.h / cell.cellH)), fontPx }
  }

  /** A grid, then `zsh -l` at its size in the pane's live cwd (`DrawerShell.tsx:165-204`). */
  private startDrawerShell(pane: PaneState, size: GridInfo, old: DrawerShell | undefined): void {
    const ptyId = drawerPtyId(pane.id)
    if (old) this.grid({ paneId: ptyId, op: 'dispose' })
    // A fresh record each start: a late spawn reply for the shell it replaced finds a different one and changes nothing.
    const d: DrawerShell = { status: 'starting', title: '', cwd: '', grid: size }
    this.drawers.set(pane.id, d)
    this.grid({ paneId: ptyId, op: 'create', cols: size.cols, rows: size.rows, fontPx: size.fontPx, scrollback: SCROLLBACK })
    const failed = (why: string): void => {
      if (this.drawers.get(pane.id) !== d) return
      d.status = 'exited'
      this.toast(`Failed to start shell: ${why}`)
    }
    void this.ptySpawn(ptyId, this.paneCwd(pane), size.cols, size.rows)
      .then((res) => {
        if (res && res.ok) {
          if (this.drawers.get(pane.id) !== d || d.status !== 'starting') return
          d.status = 'live'
          this.emit()
        } else {
          failed(res && !res.ok ? `${res.code} - ${res.message}` : 'no reply')
        }
      })
      .catch((err: unknown) => failed(err instanceof Error ? err.message : String(err)))
    // One line per drawer shell started, so a reopen that spawned again shows in the core log.
    this.deps.log?.(`pty:spawn ${ptyId} ${size.cols}x${size.rows}`)
  }

  private drawerExited(ptyId: string): void {
    const d = this.drawerOf(ptyId)
    if (!d || d.status === 'exited') return
    d.status = 'exited'
    this.emit()
  }

  /** The drawer shell behind a `drawer:<paneId>` id. */
  private drawerOf(ptyId: string): DrawerShell | undefined {
    return this.drawers.get(ptyId.slice(DRAWER_PTY_PREFIX.length))
  }

  private drawerEvent(what: string, e: UiEvent): void {
    if (!this.drawerOpen || !this.drawerShown) return
    if (what === 'grip') {
      this.drawerGripEvent(e)
      return
    }
    if (what === 'grid') {
      // A press in the drawer's terminal gives it the keyboard.
      if ((e.type === 'down' || e.type === 'click') && !this.drawerFocused) {
        this.drawerFocused = true
        this.emit()
      }
      return
    }
    if (e.type !== 'click' || e.button !== 0) return
    if (what === 'cd') this.cdToPane(this.drawerShown)
    else if (what === 'close') this.closeDrawer()
  }

  /**
   * The bottom-anchored drag (`app.tsx:267-292`): the event's y is the drawer's
   * top edge, so the rendered height is the grid area's bottom less it; stored
   * as a base height and saved once on release.
   */
  private drawerGripEvent(e: UiEvent): void {
    if (e.type === 'down' && e.button !== 0) return
    if (e.type === 'down') {
      const area = this.area()
      this.drawerDrag = e.button === 0 && area ? { bottom: area.y + area.h } : null
    } else if ((e.type === 'move' || e.type === 'up') && this.drawerDrag) {
      this.setDrawerHeight(drawerHeightFromDrag(e.y, this.drawerDrag.bottom, this.uiScale()), e.type === 'up')
      if (e.type === 'up') this.drawerDrag = null
    }
  }

  private setDrawerHeight(height: number, save: boolean): void {
    const h = clampDrawer(height)
    if (h !== this.ui.drawerHeight) {
      this.ui = { ...this.ui, drawerHeight: h }
      this.sync()
      this.emit()
    }
    if (save) this.saveUi()
  }

  /**
   * `DrawerShell.tsx:214-223`: Ctrl+U first, so whatever sat on the prompt
   * line cannot turn the command into something else, then the quoted `cd`
   * and Enter, typed visibly into the drawer and never into the pane. A path
   * `cdCommandFor` refuses (a control character in it) types nothing.
   */
  private cdToPane(paneId: string): void {
    const pane = paneById(this.s, paneId)
    const cmd = pane ? cdCommandFor(this.paneCwd(pane)) : null
    if (!cmd) return
    this.deps.send('pty:write', { paneId: drawerPtyId(paneId), data: `\x15${cmd}\r` })
    if (!this.drawerFocused) {
      this.drawerFocused = true
      this.emit()
    }
  }

  /** The drawer's id while it holds the keyboard. */
  private drawerKeys(): string | null {
    const id = this.drawerOpen && this.drawerFocused ? this.drawerShown : null
    return id && this.drawers.has(id) ? drawerPtyId(id) : null
  }

  /**
   * The terminal an edit command acts on: the drawer while it holds the
   * keyboard, else the focused pane (`app.tsx:866-878`), so a paste or a clear
   * aimed at the drawer never lands in the agent's pane behind it.
   */
  private editTargetId(): string | null {
    return this.drawerKeys() ?? this.focusedTermId()
  }

  private hasGrid(id: string): boolean {
    return id.startsWith(DRAWER_PTY_PREFIX) ? this.drawerOf(id) !== undefined : this.grids.has(id)
  }

  /** The cwd a double-clicked path resolves against: the pane's, or for a drawer its own shell's, else its pane's. */
  private clickCwd(id: string): string | null {
    if (id.startsWith(DRAWER_PTY_PREFIX)) {
      const d = this.drawerOf(id)
      const pane = paneById(this.s, id.slice(DRAWER_PTY_PREFIX.length))
      return d && pane ? d.cwd || this.paneCwd(pane) : null
    }
    return paneById(this.s, id)?.cwd ?? null
  }

  private drawerModel(): DrawerModel {
    const zero = { x: 0, y: 0, w: 0, h: 0 }
    const id = this.drawerOpen ? this.drawerShown : null
    const pane = id ? paneById(this.s, id) : undefined
    const d = id ? this.drawers.get(id) : undefined
    const area = this.area()
    if (!id || !pane || !d || !area) {
      return {
        open: false,
        rect: zero,
        gripRect: zero,
        gridRect: zero,
        height: this.ui.drawerHeight,
        paneId: null,
        ptyId: null,
        cols: 0,
        rows: 0,
        fontPx: levelAt(this.ui.zoomIndex).font,
        header: { label: '', title: '', showCd: false },
        status: 'starting',
        focused: false,
      }
    }
    const ui = this.uiScale()
    const r = drawerRects(area, this.ui.drawerHeight * ui, DRAWER_HEADER_DIP * ui)
    const paneCwd = this.paneCwd(pane)
    return {
      open: true,
      rect: r.rect,
      gripRect: r.gripRect,
      gridRect: r.gridRect,
      height: this.ui.drawerHeight,
      paneId: id,
      ptyId: drawerPtyId(id),
      cols: d.grid.cols,
      rows: d.grid.rows,
      fontPx: d.grid.fontPx,
      // DrawerShell.tsx:238-255.
      header: { label: `Shell · ${pane.label}`, title: d.title || d.cwd || paneCwd, showCd: d.cwd !== '' && d.cwd !== paneCwd },
      status: d.status,
      focused: this.drawerFocused,
    }
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
      // The rows go only when they changed; the shell keeps the ones it has (`SidebarModel.rowsSeq`).
      const m = this.last
      const same = m.sidebar.rowsSeq === this.rowsSent
      this.rowsSent = m.sidebar.rowsSeq
      this.deps.toShell('ui:model', same ? { ...m, sidebar: withoutRows(m.sidebar) } : m)
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
      tokens: { ...this.tokens },
      sidebar: this.sidebarModel(),
      drawer: this.drawerModel(),
    }
  }

  private sidebarModel(): SidebarModel {
    const x = this.sidebarOpen()
    const split = x ? this.split() : null
    const m = x ? this.sbMenu : null
    const version = x ? x.version : 0
    if (x !== this.rowsOf.x || version !== this.rowsOf.version) {
      this.rowsOf = { x, version }
      this.rowsSeq++
    }
    return {
      visible: x !== null,
      rect: split?.column ?? { x: 0, y: 0, w: 0, h: 0 },
      gripRect: split?.grip ?? { x: 0, y: 0, w: 0, h: 0 },
      width: this.ui.sidebarWidth,
      rows: x ? x.rows() : [],
      rowsSeq: this.rowsSeq,
      revealSeq: this.revealSeq,
      revealRowId: x ? this.revealRowId : null,
      strip: x ? (x.selected ?? x.root) : '',
      menu: m
        ? {
            rowId: `row:${m.path}`,
            x: m.x,
            y: m.y,
            // Two verbs (Explorer.tsx:405-442); a directory cannot be opened outside.
            items: [
              { id: 'open-outside', label: 'Open Outside SeaShell', enabled: !m.isDir },
              { id: 'reveal', label: 'Reveal in Finder', enabled: true },
            ],
          }
        : null,
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

