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
 * strings in `status.ts`, the file explorer's tree in `explorer.ts`, the
 * Projects sheet's saves and opens in `projects.ts`, the tutorial's steps in
 * `tutorial-steps.ts`. The shell drawer (`DrawerShell.tsx`) is one more grid
 * per pane, here, and so is the update banner (`UpdateBanner.tsx`).
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
import { dfsPaneOrder, movePane, swapPanes } from '../../renderer/layout/tree.js'
import { applyDividerDrag, type DividerSpec } from '../../renderer/layout/dividers.js'
import { clampIndex, DEFAULT_ZOOM_INDEX, levelAt, zoomPercent } from '../../renderer/term/zoom.js'
import { isPaneColorKey, PANE_COLORS, paneColorHex } from '../../renderer/panes/colors.js'
import { canBrief, linkBriefing, newLinkId } from '../../renderer/panes/link.js'
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
  UpdateState,
} from '../../shared/ipc.js'
import {
  DRAWER_HEADER_DIP,
  drawerRects,
  layOut,
  layOutZoomed,
  splitBody,
  UPDATE_BANNER_DIP,
  windowBands,
  type BodySplit,
  type LaidOut,
} from './layout.js'
import { ExplorerState, FLASH_MS, type Listing } from './explorer.js'
import { defaultUiState, loadUiState, saveUiState, type UiState } from './ui-state.js'
import { collectSaveLookup, restoreSavedTabs, snapshotTabs, SNAPSHOT_INTERVAL_MS } from './session.js'
import { ChangesPanel, provenSessions } from './changes.js'
import { mem, statusModel } from './status.js'
import { colorizationToTokens, isColorization, resolveTheme, themeTokens, withAccent } from './colorization.js'
import { accentOptionId, cleanNewPaneCommand, closeTabSheet, paletteOverride, SETTINGS_CHECKS, settingsSheet, tabStripApplies, tutorialSheet } from './sheets.js'
import { STEPS, type TutorialStep } from './tutorial-steps.js'
import { Projects } from './projects.js'
import { ACCENTS, PALETTE_ORDER, type PaletteKey } from '../../renderer/theme/tokens.js'
import { NATIVE_THEME_ORDER, TAB_STRIP_ORDER, type NativeThemeKey, type TabStripMode } from '../../renderer/settings/settings.js'
import { isShellTimeout, SHELL_NO_ANSWER } from '../protocol.js'
import type {
  ChordModel,
  DrawerModel,
  FindModel,
  Geometry,
  GridCmd,
  Mods,
  PaneModel,
  PopoverItem,
  PopoverModel,
  Rect,
  ShellCmd,
  SidebarModel,
  TermEvent,
  UiEvent,
  UiModel,
  UpdateBannerModel,
  ViewEvent,
  SheetModel,
} from './model.js'

export interface ControllerDeps {
  /** shim.invokeLocal */
  invoke<T = unknown>(ch: string, p: unknown): Promise<T>
  /** shim.sendLocal */
  send(ch: string, p: unknown): void
  /** Write an `on` envelope to the shell. */
  toShell(ch: 'ui:model' | 'grid:cmd' | 'shell:cmd' | 'view:cmd', p: unknown): void
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

/** Commands owned by Phase 2. Each toasts `<name> arrives in phase 2`; none is left. */
const PHASE2_COMMANDS: Readonly<Record<string, string>> = {}

/**
 * The attention ping's rate limit, copied from `src/renderer/panes/ping.ts:15-28`
 * (`PING_MIN_GAP_MS`, `shouldPing`), which is not imported: it holds the
 * renderer's `AudioContext` and `window` code. The shell synthesises the sound
 * (`native/shell/src/audio.cpp`); the core only decides when.
 */
const PING_MIN_GAP_MS = 1800

function shouldPing(now: number, lastAt: number | null, minGapMs = PING_MIN_GAP_MS): boolean {
  if (lastAt === null) return true
  // A clock that jumped backwards must not silence the ping until it catches up.
  if (now < lastAt) return true
  return now - lastAt >= minGapMs
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
  /** The theme's tokens from the shell's `shell:colorization`; Aero's 6.2 table until it reports. */
  private tokens: Record<string, string> = { ...colorizationToTokens(null), composition: '1' }
  /** The last `shell:colorization` payload, kept so a theme or `tabStrip` change can rebuild the tokens; null until it reports. */
  private colorization: { argb: string | null; opaque: boolean; composition: boolean; appsDark: boolean } | null = null
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
  /** The open sheet (one at a time); null while none is up. */
  private sheetKind: 'settings' | 'projects' | 'tutorial' | 'closeTab' | null = null
  /** The tab the closeTab sheet asks about. */
  private closingTabId: string | null = null
  /** The tutorial's steps for this platform, its step shown and its check (Tutorial.tsx state). */
  private readonly steps: TutorialStep[]
  private tutorialStep = 0
  private tutorialDontShow = true
  /** The first-run tutorial was considered: it shows once per launch at most, after the restore card. */
  private firstRunDone = false
  /** The last `update:state` from main's updater (`app.tsx:121-122`). */
  private updateState: UpdateState = { phase: 'idle' }
  /** The version put off with Later this session; starts as the saved one (`app.tsx:123-130`). */
  private updateDismissed: string | null = null
  /** The Projects sheet's state and actions (projects.ts). */
  private readonly projects: Projects
  /** The changes column of a zoomed agent pane (changes.ts). */
  private readonly changes: ChangesPanel
  /** The open pane popover (`ColorPicker.tsx`, `LinkPicker.tsx`); its items are rebuilt from state on every model. */
  private popover: { kind: 'color' | 'link'; paneId: string } | null = null
  /** Each pane's attention as the last model saw it, for the ping on the way in (`app.tsx:216-233`). */
  private prevAttention = new Map<string, string>()
  private attentionTabs: AppState['tabs'] | null = null
  private lastPingAt: number | null = null
  private last: UiModel

  constructor(deps: ControllerDeps, opts: { home: string; version: string; chords: ChordModel[] }) {
    this.deps = deps
    this.opts = opts
    this.home = opts.home
    this.steps = STEPS(deps.platform)
    this.projects = new Projects({
      invoke: <T = unknown>(ch: string, p: unknown) => this.deps.invoke<T>(ch, p),
      state: () => this.s,
      dispatch: (action) => this.dispatch(action),
      toast: (message) => this.toast(message),
      closeSheet: () => {
        if (this.sheetKind === 'projects') this.closeSheet()
      },
      changed: () => {
        if (this.sheetKind === 'projects') this.emit()
      },
      mintId: uid,
      now: () => this.deps.now(),
    })
    this.changes = new ChangesPanel({
      invoke: <T = unknown>(ch: string, p: unknown) => this.deps.invoke<T>(ch, p),
      invokeShell: <T = unknown>(ch: string, p: unknown) => this.deps.invokeShell<T>(ch, p),
      state: () => this.s,
      now: () => this.deps.now(),
      setTimer: (fn, ms) => this.deps.setTimer(fn, ms),
      changed: () => this.emit(),
      relayout: () => {
        this.sync()
        this.emit()
      },
      toast: (message) => this.toast(message),
      viewCmd: (cmd) => this.deps.toShell('view:cmd', cmd),
      reveal: (p, isDir) => this.reveal(p, isDir),
      openWithDefaultApp: (p) => void this.openPath(p, 'os'),
      tokens: () => withAccent({ ...this.tokens }, this.ui.settings.accent),
      width: () => this.ui.changesWidth,
      setWidth: (w, save) => {
        if (w !== this.ui.changesWidth) {
          this.ui = { ...this.ui, changesWidth: w }
          this.sync()
          this.emit()
        }
        if (save) this.saveUi()
      },
    })
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
      this.updateDismissed = this.ui.dismissedUpdate
      // A saved theme or `Dark` tab strip paints before the shell's first colorization.
      this.rebuildTokens()
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
      this.firstRunTutorial()
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

  /** @internal for tests: the preferences as `ui-state.json` holds them. */
  uiState(): UiState {
    return this.ui
  }

  // ---------------------------------------------------------------------------
  // Commands (the app.tsx command switch, app.tsx:861-1090)
  // ---------------------------------------------------------------------------

  command(name: string): void {
    if (name.startsWith('tab.select.')) {
      this.dispatch({ type: 'tab.selectIndex', index: Number(name.split('.')[2]) })
      return
    }
    if (name === 'app.settings') {
      this.openSheet('settings')
      return
    }
    // app.tsx:961-973: Save Project lands on window scope, Save Tab as Project
    // on tab scope, and Projects on whichever was set last.
    if (name === 'app.projects' || name === 'app.saveProject' || name === 'app.saveTab') {
      if (this.openSheet('projects')) {
        this.projects.opened(name === 'app.saveTab' ? 'tab' : name === 'app.saveProject' ? 'window' : undefined)
      }
      return
    }
    if (name === 'help.tutorial') {
      this.openTutorial()
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
        if (tab) this.closeTab(tab.id)
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
      // The changes column of the focused pane: zooms it first when it is not.
      case 'changes.toggle': {
        const id = tab?.focusedPaneId
        if (!tab || !id || tab.panes[id]?.kind !== 'term') break
        this.changes.toggle(id)
        if (tab.zoomedPaneId !== id) this.dispatch({ type: 'pane.zoom', paneId: id })
        break
      }
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
      // Previews are out of this build (plan amendment 10/03): the explorer
      // still opens (left as it is when already open), as app.tsx:935-937.
      case 'preview.file':
        this.toast('File previews are not in this build')
        if (!this.sidebarOpen()) this.showSidebar(true)
        break
      case 'preview.web':
        this.toast('Web previews are not in this build')
        break
      case 'pane.closeAll':
        this.closeAllPreviews()
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
    if (e.type === 'drop') {
      this.drop(e.target, e.paths, e.text)
      return
    }
    const t = e.target
    // The pane popovers close on a press anywhere outside them, and on Escape
    // from anywhere (ColorPicker.tsx, LinkPicker.tsx: capture-phase listeners).
    if (this.popover && e.type === 'down' && t !== 'popover' && !t.startsWith('popover:')) this.closePopover()
    if (this.popover && e.type === 'key' && e.key === 'Escape') {
      this.closePopover()
      return
    }
    if (t === 'popover' || t.startsWith('popover:')) {
      if (e.type === 'click' && e.button === 0 && t.startsWith('popover:')) this.popoverPick(t.slice('popover:'.length))
      return
    }
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
    if (t === 'sheet:close' || t.startsWith('sheet:')) {
      this.sheetEvent(t, e)
      return
    }
    if (t.startsWith('update:')) {
      if (e.type === 'click' && e.button === 0) this.updateClick(t.slice('update:'.length))
      return
    }
    if (t.startsWith('changes:')) {
      if (e.type !== 'wheel' && e.type !== 'key' && e.type !== 'text' && e.type !== 'focus' && e.type !== 'blur') {
        this.changes.event(t.slice('changes:'.length), e, this.area())
      }
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
    if (e.type === 'focus' || e.type === 'wheel' || e.type === 'up' || e.type === 'move' || sidePress) return

    const parts = t.split(':')
    const head = parts[0]
    if (head === 'tab') this.tabEvent(parts, e.type)
    else if (head === 'pane') this.paneEvent(parts, e.type)
    else if (head === 'find') this.findEvent(parts[1] ?? '', e.type)
    else if (e.type === 'click') this.chromeClick(t)
    else if (e.type === 'dblclick' && t === 'strip:empty') this.newTab()
  }

  /** `view:event` from the shell: what the changes preview page reported. */
  view(e: ViewEvent): void {
    this.changes.view(e)
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
      case 'urlclick': {
        // terminal.ts:238-243 (WebLinksAddon): a click on a bare http(s) URL
        // opens it through main's guarded open:externalHttp.
        const url = typeof e.line === 'string' && Number.isInteger(e.index) ? webUrlAt(e.line, e.index) : null
        if (url) void this.deps.invoke('open:externalHttp', { url }).catch((err: unknown) => this.shellSilent(err))
        break
      }
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
   * expands it). On a file, Ctrl opens it the way the explorer does (the
   * default app for what main routes to the viewer, since this build has no
   * previews) and Ctrl+Alt hands it to its default app. A miss toasts its message; no candidate under the click
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
        // DwmGetColorizationColor, DwmIsCompositionEnabled and AppsUseLightTheme,
        // at start and on WM_DWMCOLORIZATIONCOLORCHANGED / WM_DWMCOMPOSITIONCHANGED /
        // WM_SETTINGCHANGE "ImmersiveColorSet".
        const c = p as { argb?: unknown; opaque?: unknown; composition?: unknown; appsDark?: unknown } | null
        this.colorization = {
          argb: typeof c?.argb === 'string' ? c.argb : null,
          opaque: c?.opaque === true,
          composition: c?.composition !== false,
          appsDark: c?.appsDark === true,
        }
        this.rebuildTokens()
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
      case 'update:state': {
        // main's updater (off on wslhost in this build; plan decision 6), or
        // a test:update the core maps here in test mode (src/core/index.ts).
        const next = coerceUpdateState(p)
        if (!next) break
        this.updateState = next
        // The body gains or loses the banner's band: the grids resize.
        this.sync()
        this.emit()
        break
      }
      default:
        break
    }
  }

  /**
   * A file or text drop (`PaneView.tsx:525-545`, inventory row J). Only a
   * terminal grid takes one: a pane's grid in the active tab or the open
   * drawer's; the explorer, the strip, a restored preview's placeholder and
   * anything under a sheet or the restore card refuse it. The shell sends the
   * Windows paths of a `CF_HDROP` and the text or URL; `dropText` quotes and
   * maps them. Text that is not a path is pasted as it is. Nothing is run:
   * the paste is the grid's bracketed paste. The grid then has the keyboard.
   */
  private drop(target: string, paths: string[], text: string | null): void {
    if (this.restoreCandidate || this.sheetKind !== null) return
    let gridId: string | null = null
    let paneId: string | null = null
    if (target === 'drawer:grid') {
      gridId = this.drawerOpen ? this.drawerKeysTarget() : null
    } else {
      const m = /^pane:(.+):grid$/.exec(target)
      const pane = m ? this.activeTab()?.panes[m[1]!] : undefined
      if (pane && isTerm(pane)) gridId = paneId = pane.id
    }
    if (!gridId || !this.hasGrid(gridId)) return
    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p !== '') : []
    const raw = typeof text === 'string' ? text : ''
    const out = dropText({ paths: list, ...(raw ? { text: raw } : {}) }, this.deps.platform) || (list.length ? '' : raw)
    if (!out) return
    this.grid({ paneId: gridId, op: 'paste', text: out })
    if (paneId) {
      this.blurDrawer()
      if (this.activeTab()?.focusedPaneId !== paneId) this.dispatch({ type: 'pane.focus', paneId })
      this.grid({ paneId, op: 'focus' })
    } else if (!this.drawerFocused) {
      this.drawerFocused = true
      this.emit()
    }
  }

  /** The open drawer's pty id, whether or not it holds the keyboard. */
  private drawerKeysTarget(): string | null {
    const id = this.drawerShown
    return id && this.drawers.has(id) ? drawerPtyId(id) : null
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
    const tab = this.activeTab()
    const pane = tab?.panes[paneId]
    if (!tab || !pane) return
    // The tab's last pane going is the tab going: it asks as tab.close does.
    if (Object.keys(tab.panes).length === 1 && isTerm(pane) && pane.status !== 'exited') {
      this.closeTab(tab.id)
      return
    }
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

  /**
   * `app.tsx:832-840`: every non-term pane in the active tab goes. Only a
   * restored file or web placeholder can be one in this build.
   */
  private closeAllPreviews(): void {
    const tab = this.activeTab()
    if (!tab) return
    const previews = Object.values(tab.panes).filter((p) => !isTerm(p))
    if (previews.length === 0) {
      this.toast('No preview panes open')
      return
    }
    for (const p of previews) this.dispatch({ type: 'pane.close', paneId: p.id })
  }

  /**
   * A tab with a live shell asks first (the closeTab sheet: Enter closes,
   * Escape keeps); one with nothing running closes at once.
   */
  private closeTab(tabId: string): void {
    const tab = this.s.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const live = Object.values(tab.panes).some((p) => isTerm(p) && p.status !== 'exited')
    if (!live) {
      void this.reapTab(tabId)
      return
    }
    this.closingTabId = tabId
    if (!this.openSheet('closeTab')) this.closingTabId = null
  }

  /** `app.tsx:434-457`. */
  private async reapTab(tabId: string): Promise<void> {
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
      if (type === 'click') this.closeTab(id)
      return
    }
    if (sub === 'move') {
      // The shell's tab drag: the tab takes slot parts[3] as the pointer crosses into it.
      if (type === 'click') this.dispatch({ type: 'tab.move', tabId: id, toIndex: Number(parts[3]) })
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
    // The colour dot and the link toggle open their popover on click; the
    // press focuses the pane like any other part of it (PaneView.tsx onMouseDown).
    if ((sub === 'color' || sub === 'link') && type === 'click') this.openPopover(sub, id)
    if (sub === 'restart') {
      if (type === 'click') this.restartPane(id)
      return
    }
    if (sub === 'changes') {
      if (type === 'click') this.changes.toggle(id)
      return
    }
    if (sub === 'moveTo') {
      if (type === 'click') this.dropPane(id, parts[3] ?? '', parts[4] ?? '')
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

  /**
   * A pane dragged by its title and dropped on another pane of the tab (the
   * shell's `pane:<id>:moveTo:<targetId>:<where>`): `swap` trades their places
   * and sizes; `left`, `right`, `top` or `bottom` docks it on that side of the
   * target. A docked layout is no longer the auto-arranged one, so the tab
   * stops being pristine (a close would otherwise re-run the arranger over it).
   */
  private dropPane(paneId: string, targetId: string, where: string): void {
    const tab = this.activeTab()
    if (!tab || paneId === targetId || !tab.panes[targetId] || tab.zoomedPaneId !== null) return
    let tree: RowNode
    if (where === 'swap') tree = swapPanes(tab.tree, paneId, targetId)
    else if (where === 'left' || where === 'right' || where === 'top' || where === 'bottom') tree = movePane(tab.tree, paneId, targetId, where)
    else return
    if (tree === tab.tree) return
    this.dispatch({ type: 'layout.setTree', tree, pristine: where === 'swap' && tab.pristine })
    if (this.activeTab()?.focusedPaneId !== paneId) this.dispatch({ type: 'pane.focus', paneId })
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
      void this.deps.invoke('open:revealInFinder', { path: m.path }).catch((err: unknown) => this.shellSilent(err))
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
      (err: unknown) => this.toast(isShellTimeout(err) ? SHELL_NO_ANSWER : 'Could not copy the path')
    )
  }

  /**
   * The catch of a user-visible invoke that reaches the shell: a reply the
   * shell never sent (`ETIMEOUT`, 10 s) says so; any other failure stays as
   * quiet as it was.
   */
  private shellSilent(err: unknown): void {
    if (isShellTimeout(err)) this.toast(SHELL_NO_ANSWER)
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
      // No viewer in this build (plan amendment 10/03): the 'os' route.
      onOpenInViewer: (p) => void this.openPath(p, 'os'),
      onToast: (m) => this.toast(m),
    }
  }

  /** `open.ts` openPath; `force: 'os'` hands the file to its default app whatever the route. */
  private async openPath(p: string, force?: 'os'): Promise<void> {
    try {
      await routeOpen(p, this.openDeps(), force)
    } catch (err) {
      this.deps.log?.(`open failed: ${err instanceof Error ? err.message : String(err)}`)
      this.shellSilent(err)
    }
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
        this.firstRunTutorial()
      })
  }

  private declineRestore(): void {
    if (!this.restoreCandidate) return
    this.restoreCandidate = null
    void this.deps.invoke('session:clear', undefined).catch(() => undefined)
    this.newTab()
    this.firstRunTutorial()
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
    const { lookup, proven, provenAgents } = await collectSaveLookup(this.s, this.deps.invoke.bind(this.deps))
    if (Object.keys(proven).length > 0) this.dispatch({ type: 'panes.sessionIds', ids: proven })
    if (Object.keys(provenAgents).length > 0) this.dispatch({ type: 'panes.agents', agents: provenAgents })
    // Every agent session seen running starts being watched: its baseline is
    // the folder as it stood now, when SeaShell first saw it.
    for (const w of provenSessions(this.s, proven, provenAgents)) void this.deps.invoke('changes:watch', w).catch(() => undefined)
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
    // A popover whose pane closed or left the active tab goes with it.
    if (this.popover && !this.activeTab()?.panes[this.popover.paneId]) this.popover = null
    this.changes.follow()
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

  /**
   * The client area in DIP under the tab strip: the body, then the update
   * banner's band while it shows, then the status bar (layout.ts windowBands).
   */
  private bands(): { body: Rect; banner: Rect | null } | null {
    const g = this.geo
    if (!g) return null
    const scale = g.dpi > 0 ? g.dpi / 96 : 1
    const ui = this.uiScale()
    const bannerH = this.bannerState() ? UPDATE_BANNER_DIP * ui : 0
    return windowBands(g.clientW / scale, g.clientH / scale, TAB_STRIP_PX * ui, STATUS_PX * ui, bannerH)
  }

  /** The window body in DIP: the client area below the tab strip and above the banner and the status bar. */
  private body(): Rect | null {
    return this.bands()?.body ?? null
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
      // The changes column, when it shows, takes the right of the area.
      const own = tab.id === this.s.activeTabId && tab.zoomedPaneId === this.changes.agentPane()
      const zArea = (own ? this.changes.split(area, ui)?.pane : undefined) ?? area
      const z = layOutZoomed(tab.zoomedPaneId, zArea, ui, fontFor(tab.zoomedPaneId))
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
  // Pane popovers (ColorPicker.tsx, LinkPicker.tsx, app.tsx:766-801) and the
  // attention ping (app.tsx:216-233)
  // ---------------------------------------------------------------------------

  /** The dot or the link toggle: the popover opens (again) for that pane, never over a modal. */
  private openPopover(kind: 'color' | 'link', paneId: string): void {
    if (this.restoreCandidate || this.sheetKind !== null) return
    const pane = this.activeTab()?.panes[paneId]
    if (!pane || (kind === 'link' && !isTerm(pane))) return
    this.sbMenu = null
    this.popover = { kind, paneId }
    this.emit()
  }

  private closePopover(): void {
    if (this.popover === null) return
    this.popover = null
    this.emit()
  }

  /**
   * `popover:<id>`. A colour key tags the pane, the current one clears it,
   * `none` clears it (ColorPicker.tsx). Another pane's id links the two,
   * `unlink` takes this pane out of its group (LinkPicker.tsx, store.ts
   * `pane.unlink`). A disabled item does nothing and leaves the popover open,
   * as a disabled button does.
   */
  private popoverPick(id: string): void {
    const pop = this.popover
    const pane = pop ? this.activeTab()?.panes[pop.paneId] : undefined
    if (!pop || !pane) return
    const item = this.popoverItems(pop.kind, pane).find((x) => x.id === id)
    if (!item || item.disabled) return
    this.popover = null
    if (pop.kind === 'color') {
      const color = id === 'none' || !isPaneColorKey(id) || pane.color === id ? null : id
      this.dispatch({ type: 'pane.setColor', paneId: pane.id, color })
    } else if (id === 'unlink') {
      this.dispatch({ type: 'pane.unlink', paneId: pane.id })
    } else {
      this.emit()
      void this.linkPanes(pane.id, id)
    }
  }

  /**
   * `app.tsx:766-801`: two panes on one shared notes file. main creates the
   * notes, and each pane not already on that file gets the briefing typed
   * after a Ctrl+U and submitted. Refused for a pane not running an agent: an
   * English sentence at a shell prompt is a command line.
   */
  private async linkPanes(paneId: string, otherPaneId: string): Promise<void> {
    const a = paneById(this.s, paneId)
    const b = paneById(this.s, otherPaneId)
    if (!a || !b) return
    if (!canBrief(a.metrics?.foregroundProcess) || !canBrief(b.metrics?.foregroundProcess)) {
      this.toast('Both panes need to be running an agent to link')
      return
    }
    // Joining an existing group keeps its notes; otherwise mint one.
    const linkId = a.linkId ?? b.linkId ?? newLinkId(() => uid('link'))
    let notes: string | null = null
    try {
      const res = await this.deps.invoke<{ path?: unknown }>('links:ensure', { linkId })
      notes = typeof res?.path === 'string' ? res.path : null
    } catch (err) {
      this.deps.log?.(`links:ensure failed: ${(err as Error).message}`)
    }
    if (!notes) {
      this.toast('Could not create the shared notes file')
      return
    }
    const briefing = linkBriefing(notes)
    if (!briefing) {
      this.toast('That notes path cannot be typed safely')
      return
    }
    for (const id of [paneId, otherPaneId]) {
      const pane = paneById(this.s, id)
      if (!pane || pane.linkId === linkId) continue // gone, or already briefed on this file
      this.dispatch({ type: 'pane.link', paneId: id, linkId })
      // Ctrl+U first, as the drawer's cd does: the prompt may hold half-typed input.
      this.deps.send('pty:write', { paneId: id, data: `\x15${briefing.text}\r` })
    }
    this.toast('Panes are sharing notes')
  }

  /**
   * The rows, rebuilt from state every time so a metrics tick that starts or
   * stops an agent updates `no agent` while the popover is open. The link
   * list is the other terminal panes of the tab in on-screen order, numbered
   * as their title bars are (app.tsx:1404-1416, LinkPicker.tsx).
   */
  private popoverItems(kind: 'color' | 'link', pane: PaneState): PopoverItem[] {
    if (kind === 'color') {
      const current = isPaneColorKey(pane.color) ? pane.color : null
      return [
        ...PANE_COLORS.map((c) => ({ id: c.key, label: c.label, swatch: c.hex, selected: current === c.key, disabled: false, note: null })),
        { id: 'none', label: 'No colour', swatch: null, selected: current === null, disabled: false, note: null },
      ]
    }
    const tab = this.activeTab()
    const items: PopoverItem[] = []
    if (tab) {
      dfsPaneOrder(tab.tree).forEach((id, i) => {
        const other = tab.panes[id]
        if (!other || id === pane.id || !isTerm(other)) return
        const already = pane.linkId !== undefined && other.linkId === pane.linkId
        const agents = canBrief(pane.metrics?.foregroundProcess) && canBrief(other.metrics?.foregroundProcess)
        items.push({
          id,
          label: `${i + 1} ${other.label}`,
          swatch: null,
          selected: already,
          disabled: already || !agents,
          note: already ? 'linked' : agents ? null : 'no agent',
        })
      })
    }
    if (items.length === 0) {
      items.push({ id: 'empty', label: 'No other terminal pane in this tab.', swatch: null, selected: false, disabled: true, note: null })
    }
    if (pane.linkId !== undefined) items.push({ id: 'unlink', label: 'Stop sharing', swatch: null, selected: false, disabled: false, note: null })
    return items
  }

  /** The open popover against the panes just laid out; null when its pane is not on screen. */
  private popoverModel(panes: PaneModel[], ui: number): PopoverModel | null {
    const pop = this.popover
    if (!pop || this.sheetKind !== null || this.restoreCandidate) return null
    const tab = this.activeTab()
    const pane = tab?.panes[pop.paneId]
    const pm = panes.find((p) => p.id === pop.paneId)
    if (!tab || !pane || !pm || (tab.zoomedPaneId && tab.zoomedPaneId !== pane.id)) return null
    const titleH = Math.max(0, pm.gridRect.y - pm.rect.y)
    // The dot sits after the 6 DIP inset, the 10 DIP index and a 4 DIP gap (panes.cpp); the link list
    // opens at the title bar's left, 8 DIP in, as `.linkpick` does.
    const anchor: Rect =
      pop.kind === 'color'
        ? { x: pm.rect.x + 20 * ui, y: pm.rect.y, w: 16 * ui, h: titleH }
        : { x: pm.rect.x + 8 * ui, y: pm.rect.y, w: 0, h: titleH }
    return {
      kind: pop.kind,
      paneId: pop.paneId,
      anchor,
      title: pop.kind === 'link' ? 'Share notes with' : null,
      items: this.popoverItems(pop.kind, pane),
    }
  }

  /**
   * `app.tsx:216-233`: a ping on the transition into attention, never on the
   * state, so a pane left waiting does not re-ping every tick. Glow gates the
   * sound as well as the border (the moon), and one ping per 1.8 s covers six
   * panes finishing together. Runs on every model, before it is built.
   */
  private attentionPing(): void {
    if (this.s.tabs === this.attentionTabs) return
    this.attentionTabs = this.s.tabs
    const seen = new Map<string, string>()
    let started = false
    for (const tab of this.s.tabs) {
      for (const p of Object.values(tab.panes)) {
        const now = p.attention ?? ''
        seen.set(p.id, now)
        if (now !== '' && (this.prevAttention.get(p.id) ?? '') === '') started = true
      }
    }
    this.prevAttention = seen
    const { attentionGlow, attentionSound } = this.ui.settings
    if (!started || !attentionGlow || !attentionSound) return
    const now = this.deps.now()
    if (!shouldPing(now, this.lastPingAt)) return
    this.lastPingAt = now
    const cmd: ShellCmd = { op: 'ping' }
    this.deps.toShell('shell:cmd', cmd)
  }

  // ---------------------------------------------------------------------------
  // Sheets (sheets.ts; SettingsPanel.tsx for Settings)
  // ---------------------------------------------------------------------------

  /** False when the restore card is up: it is modal and answers first (app.tsx shows no sheet over it). */
  private openSheet(kind: 'settings' | 'projects' | 'tutorial' | 'closeTab'): boolean {
    if (this.restoreCandidate) return false
    if (this.sbMenu) this.sbMenu = null
    this.popover = null
    if (kind !== 'closeTab') this.closingTabId = null
    this.sheetKind = kind
    this.emit()
    return true
  }

  private closeSheet(): void {
    if (this.sheetKind === null) return
    this.sheetKind = null
    this.closingTabId = null
    this.emit()
  }

  /** The closeTab sheet's model; the sheet goes if its tab went first (a pane exit, a restore). */
  private closeTabModel(uiScale: number): SheetModel | null {
    const tab = this.s.tabs.find((t) => t.id === this.closingTabId)
    if (!tab) {
      this.sheetKind = null
      this.closingTabId = null
      return null
    }
    return closeTabSheet(tab.name, Object.keys(tab.panes).length, uiScale)
  }

  /** One preference changed from the sheet: saved and drawn at once (SettingsPanel.tsx `set`). */
  private setSetting<K extends keyof UiState['settings']>(key: K, value: UiState['settings'][K]): void {
    if (this.ui.settings[key] === value) return
    this.ui = { ...this.ui, settings: { ...this.ui.settings, [key]: value } }
    if (key === 'tabStrip' || key === 'nativeTheme') this.rebuildTokens()
    if (key === 'accent') this.changes.themeChanged()
    this.saveUi()
    this.emit()
  }

  /**
   * The token table from the last colorization, the `nativeTheme` setting
   * (`System` is Aero or Aero Dark by Windows' app theme, so it flips live on
   * ImmersiveColorSet) and, for Aero, the `tabStrip` setting (plan amendment
   * 10/03 05:40): `System` follows Windows' app theme, `Light` and `Dark` pin
   * it. The accent override rides on top in `build()`, so it survives every
   * rebuild.
   */
  private rebuildTokens(): void {
    const c = this.colorization
    const appsDark = c?.appsDark === true
    const theme = resolveTheme(this.ui.settings.nativeTheme, appsDark)
    const mode = this.ui.settings.tabStrip
    const darkStrip = mode === 'dark' || (mode === 'system' && appsDark)
    if (c === null) {
      // The shell has not reported: the theme's table on glass, as at construction.
      const tokens = themeTokens(theme, null, darkStrip)
      this.tokens = { ...tokens, composition: tokens.flatFrame === '1' ? '0' : '1' }
      return
    }
    // A missing or malformed colorization (DWM off, a remote session) paints
    // the opaque strip, as composition off does (Review Focus 5).
    const tokens = themeTokens(theme, c.argb, darkStrip)
    // Graphite (flatFrame) has no glass even where DWM could draw it.
    const glass = c.composition && isColorization(c.argb) && tokens.flatFrame !== '1'
    this.tokens = { ...tokens, composition: glass ? '1' : '0' }
    this.changes.themeChanged()
  }

  private sheetEvent(t: string, e: UiEvent): void {
    if (this.sheetKind === null) return
    if (this.sheetKind === 'tutorial') {
      this.tutorialEvent(t, e)
      return
    }
    if (this.sheetKind === 'closeTab') {
      const base = 'sheet:closeTab'
      if (e.type === 'key') {
        if (e.key === 'Escape' && (t === base || t.startsWith(`${base}:`))) this.closeSheet()
        return
      }
      if (e.type !== 'click') return
      if (t === `${base}:btn:close`) {
        const id = this.closingTabId
        this.closeSheet()
        if (id !== null) void this.reapTab(id)
      } else if (t === 'sheet:close' || t === `${base}:btn:keep`) {
        this.closeSheet()
      }
      return
    }
    const base = `sheet:${this.sheetKind}`
    if (e.type === 'key' && e.key === 'Escape') {
      if (t === base || t.startsWith(`${base}:`)) this.closeSheet()
      return
    }
    if (e.type === 'click' && (t === 'sheet:close' || t === `${base}:btn:done`)) {
      this.closeSheet()
      return
    }
    if (this.sheetKind === 'projects') {
      if (t.startsWith(`${base}:`)) this.projects.event(t.slice(base.length + 1), e)
      return
    }
    if (e.type === 'key') return
    if (e.type === 'text') {
      if (t === `${base}:newPaneCommand`) this.setSetting('newPaneCommand', cleanNewPaneCommand(e.text))
      return
    }
    if (e.type !== 'click') return
    if (!t.startsWith(`${base}:`)) return
    const [field, option] = t.slice(base.length + 1).split(':')
    if (field === undefined) return
    if (option === undefined) {
      if (SETTINGS_CHECKS.includes(field)) {
        const key = field as 'attentionGlow' | 'attentionSound' | 'autoColorPanes' | 'autoTitlePanes'
        this.setSetting(key, !this.ui.settings[key])
      } else if (field === 'tutorial') {
        // SettingsPanel's onShowTutorial: the sheet closes, the tutorial opens.
        this.closeSheet()
        this.command('help.tutorial')
      }
      return
    }
    if (field === 'accent') {
      if (option === 'default') this.setSetting('accent', null)
      else {
        const a = ACCENTS.find((x) => accentOptionId(x.key) === option)
        if (a) this.setSetting('accent', a.key)
      }
    } else if (field === 'palette') {
      if ((PALETTE_ORDER as readonly string[]).includes(option)) this.setSetting('palette', option as PaletteKey)
    } else if (field === 'theme') {
      if ((NATIVE_THEME_ORDER as readonly string[]).includes(option)) this.setSetting('nativeTheme', option as NativeThemeKey)
    } else if (field === 'tabStrip') {
      if (tabStripApplies(this.ui.settings.nativeTheme) && (TAB_STRIP_ORDER as readonly string[]).includes(option))
        this.setSetting('tabStrip', option as TabStripMode)
    }
    // Pane frame and CRT glass are greyed: nothing to apply.
  }

  // ---------------------------------------------------------------------------
  // The tutorial (Tutorial.tsx; app.tsx:114, 958-959, 1775-1777, 1803)
  // ---------------------------------------------------------------------------

  /**
   * Once per launch, after boot and after the restore card was answered when
   * one was up: the tutorial opens unless it was seen. With no userData to
   * remember it in, it counts as seen (Tutorial.tsx:20-28: showing it on every
   * launch would be far worse than never showing it).
   */
  private firstRunTutorial(): void {
    if (this.firstRunDone) return
    this.firstRunDone = true
    if (this.uiFile !== null && !this.ui.tutorialSeen) this.openTutorial()
  }

  /** A fresh mount: the first step, the check ticked (Tutorial.tsx:240-249). */
  private openTutorial(): void {
    if (this.restoreCandidate) return
    this.tutorialStep = 0
    this.tutorialDontShow = true
    this.openSheet('tutorial')
  }

  /** Tutorial.tsx `close`: the check ticked marks it seen; unticked leaves the flag as it was. */
  private closeTutorial(): void {
    if (this.tutorialDontShow && !this.ui.tutorialSeen) {
      this.ui = { ...this.ui, tutorialSeen: true }
      this.saveUi()
    }
    this.closeSheet()
  }

  private setTutorialStep(step: number): void {
    const next = Math.max(0, Math.min(this.steps.length - 1, step))
    if (next === this.tutorialStep) return
    this.tutorialStep = next
    this.emit()
  }

  /**
   * The sheet's keys (Tutorial.tsx:273-291: Escape closes, the arrows step and
   * stop at either end; the shell's sheet holds the keyboard, so a terminal
   * never sees them) and its clicks: a dot, the check, Skip, Back and Next.
   */
  private tutorialEvent(t: string, e: UiEvent): void {
    const base = 'sheet:tutorial'
    if (t !== 'sheet:close' && t !== base && !t.startsWith(`${base}:`)) return
    if (e.type === 'key') {
      if (e.key === 'Escape') this.closeTutorial()
      else if (e.key === 'ArrowLeft') this.setTutorialStep(this.tutorialStep - 1)
      else if (e.key === 'ArrowRight') this.setTutorialStep(this.tutorialStep + 1)
      return
    }
    if (e.type !== 'click') return
    if (t === 'sheet:close' || t === `${base}:btn:skip`) {
      this.closeTutorial()
    } else if (t === `${base}:btn:back`) {
      this.setTutorialStep(this.tutorialStep - 1)
    } else if (t === `${base}:btn:next`) {
      if (this.tutorialStep >= this.steps.length - 1) this.closeTutorial()
      else this.setTutorialStep(this.tutorialStep + 1)
    } else if (t === `${base}:dontShow`) {
      this.tutorialDontShow = !this.tutorialDontShow
      this.emit()
    } else if (t.startsWith(`${base}:step:`)) {
      const n = Number(t.slice(`${base}:step:`.length))
      if (Number.isInteger(n) && n >= 0 && n < this.steps.length) this.setTutorialStep(n)
    }
  }

  // ---------------------------------------------------------------------------
  // The update banner (UpdateBanner.tsx; app.tsx:1385-1398, 1744-1764)
  // ---------------------------------------------------------------------------

  /**
   * What the banner shows (app.tsx:1390-1398): nothing while idle, and an
   * offer already refused is not an offer, so an `available` for the version
   * put off with Later stays hidden. A download, a ready install or an error
   * is always shown through.
   */
  private bannerState(): Exclude<UpdateState, { phase: 'idle' }> | null {
    const s = this.updateState
    if (s.phase === 'idle') return null
    if (s.phase === 'available' && s.version === this.updateDismissed) return null
    return s
  }

  /** The banner's text and buttons, UpdateBanner.tsx:17-80 verbatim. */
  private updateModel(): UpdateBannerModel | null {
    const s = this.bannerState()
    const rect = this.bands()?.banner
    if (!s || !rect) return null
    switch (s.phase) {
      case 'available':
        return {
          phase: 'available',
          text: `SeaShell ${s.version} is available.`,
          buttons: [s.canInstall ? { id: 'download', label: 'Download' } : { id: 'page', label: 'Release page' }, { id: 'later', label: 'Later' }],
          progress: null,
          rect,
        }
      case 'downloading':
        return {
          phase: 'downloading',
          text: `Downloading ${s.version}: ${s.total > 0 ? `${Math.floor((s.received / s.total) * 100)}%` : `${Math.floor(s.received / 1024 / 1024)} MB`}`,
          buttons: [],
          progress: s.total > 0 ? Math.max(0, Math.min(1, s.received / s.total)) : null,
          rect,
        }
      case 'ready':
        return {
          phase: 'ready',
          text: `SeaShell ${s.version} is ready. Installing closes every pane and relaunches.`,
          buttons: [
            { id: 'install', label: 'Install and Relaunch' },
            { id: 'later', label: 'Later' },
          ],
          progress: null,
          rect,
        }
      case 'error':
        return {
          phase: 'error',
          text: `Update ${s.version} failed: ${s.message}`,
          // A failure is usually a blip, so the first button is another go.
          buttons: [
            { id: 'retry', label: 'Try again' },
            { id: 'dismiss', label: 'Dismiss' },
          ],
          progress: null,
          rect,
        }
    }
  }

  /**
   * A banner button, only while the banner shows it. Download and Try again
   * ask main's updater to download, Install and Relaunch to install; the
   * release page goes to main's guarded `open:externalHttp` (never a raw
   * open). Later and Dismiss hide the banner and remember the version for the
   * session; Later also saves it, a failure is not a refusal (app.tsx:1748-1762).
   */
  private updateClick(id: string): void {
    const s = this.bannerState()
    if (!s || !this.updateModel()?.buttons.some((b) => b.id === id)) return
    switch (id) {
      case 'download':
      case 'retry':
        this.deps.send('update:download', undefined)
        break
      case 'install':
        this.deps.send('update:install', undefined)
        break
      case 'page':
        if (s.phase === 'available') void this.deps.invoke('open:externalHttp', { url: s.pageUrl }).catch((err: unknown) => this.shellSilent(err))
        break
      case 'later':
      case 'dismiss':
        this.updateDismissed = s.version
        if (s.phase !== 'error') {
          this.ui = { ...this.ui, dismissedUpdate: s.version }
          this.saveUi()
        }
        this.updateState = { phase: 'idle' }
        this.sync()
        this.emit()
        break
      default:
        break
    }
  }

  // ---------------------------------------------------------------------------
  // The model
  // ---------------------------------------------------------------------------

  /** One `ui:model` per macrotask, however many mutations ran in it. */
  private emit(): void {
    this.attentionPing()
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
      window: {
        title: 'SeaShell',
        uiScale: ui,
        fontPx: level.font,
        tabStripH: TAB_STRIP_PX * ui,
        statusH: STATUS_PX * ui,
        palette: paletteOverride(this.ui.settings.palette),
      },
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
      tokens: withAccent({ ...this.tokens }, this.ui.settings.accent),
      sidebar: this.sidebarModel(),
      drawer: this.drawerModel(),
      sheet:
        this.sheetKind === 'settings'
          ? settingsSheet(this.ui.settings, this.deps.platform, ui, this.colorization?.appsDark === true)
          : this.sheetKind === 'projects'
            ? this.projects.sheet(ui)
            : this.sheetKind === 'tutorial'
              ? tutorialSheet(this.steps, this.tutorialStep, this.tutorialDontShow, ui)
              : this.sheetKind === 'closeTab'
                ? this.closeTabModel(ui)
                : null,
      update: this.updateModel(),
      popover: this.popoverModel(panes, ui),
      changes: this.changes.model(area, ui),
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
      changes: p.id === this.changes.agentPane() ? (this.changes.visible() ? 'on' : 'off') : 'none',
    }
  }
}

/**
 * `update:state` as main's updater sends it (`UpdateState`, src/shared/ipc.ts);
 * null for anything malformed, which leaves the banner as it was.
 */
function coerceUpdateState(p: unknown): UpdateState | null {
  const s = p as Record<string, unknown> | null
  if (typeof s !== 'object' || s === null) return null
  const version = typeof s['version'] === 'string' ? s['version'] : null
  const num = (k: string): number | null => (typeof s[k] === 'number' && Number.isFinite(s[k]) ? (s[k] as number) : null)
  switch (s['phase']) {
    case 'idle':
      return { phase: 'idle' }
    case 'available':
      return version !== null && typeof s['pageUrl'] === 'string'
        ? { phase: 'available', version, pageUrl: s['pageUrl'], canInstall: s['canInstall'] === true }
        : null
    case 'downloading': {
      const received = num('received')
      const total = num('total')
      return version !== null && received !== null && total !== null ? { phase: 'downloading', version, received, total } : null
    }
    case 'ready':
      return version !== null ? { phase: 'ready', version } : null
    case 'error':
      return version !== null && typeof s['message'] === 'string' ? { phase: 'error', version, message: s['message'] } : null
    default:
      return null
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

/**
 * The bare http or https URL covering `index` of a logical line, as
 * WebLinksAddon finds them: no whitespace, quotes or angle brackets, with
 * trailing sentence punctuation left off. Null when the click is not on one.
 */
export function webUrlAt(line: string, index: number): string | null {
  for (const m of line.matchAll(/https?:\/\/[^\s"'<>`]+/g)) {
    const url = m[0].replace(/[.,;:!?)\]}]+$/, '')
    const start = m.index ?? 0
    if (url.length > 'https://'.length - 1 && index >= start && index < start + url.length) return url
  }
  return null
}
