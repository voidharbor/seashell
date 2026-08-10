import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { computeLayout } from './layout/resize.js'
import { dfsPaneOrder } from './layout/tree.js'
import { MAX_PANES_PER_TAB, type RowNode } from './layout/types.js'
import { applyDividerDrag, deriveDividers, type DividerSpec } from './layout/dividers.js'
import { MAX_TAB_NAME, paneById, reducer, uid, type AppState, type PaneCommand } from './store.js'
import {
  PaneView,
  forgetSpawn,
  refitVisibleTerminals,
  setHostname,
  terminals,
} from './panes/PaneView.js'
import { watchDevicePixelRatio } from './term/dpr.js'
import { applyTheme, themeVars } from './theme/apply.js'
import { setCurrentXtermTheme } from './theme/live.js'
import { xtermThemeFrom } from './term/palette.js'
import { Explorer } from './explorer/Explorer.js'
import { StatusBar } from './status/StatusBar.js'
import { loadTerminalFont } from './term/terminal.js'
import { editTargetId, isTextField, terminalOwningFocus } from './term/edit-target.js'
import { paneColorHex } from './panes/colors.js'
import {
  applyUiScale,
  clampIndex,
  DEFAULT_ZOOM_INDEX,
  levelAt,
  loadZoomIndex,
  saveZoomIndex,
  zoomPercent,
} from './term/zoom.js'
import {
  SIDEBAR_DEFAULT,
  loadSidebarWidth,
  saveSidebarWidth,
  widthFromDrag,
} from './layout/sidebar.js'
import { RAIL_DEFAULT, heightFromDrag, loadRailHeight, saveRailHeight } from './layout/rail.js'
import { drawerHeightFromDrag, loadDrawerHeight, saveDrawerHeight } from './layout/drawer.js'
import { DrawerShell } from './drawer/DrawerShell.js'
import { drawerPtyId } from './drawer/id.js'
import { Tutorial, hasSeenTutorial } from './tutorial/Tutorial.js'
import { playAttentionPing, unlockAudio } from './panes/ping.js'
import { SettingsPanel } from './settings/SettingsPanel.js'
import { ProjectsPanel, type SaveScope } from './projects/ProjectsPanel.js'
import { stateToTabs, tabToSaved, tabsFromSaved } from './projects/serialize.js'
import type { LookoutActionRequest, LookoutCard, Project } from '../shared/ipc.js'
import { loadSettings, saveSettings, type Settings } from './settings/settings.js'
import { dirtyPreviewPanes } from './viewer/FilePreview.js'
import { extractQuestion } from './lookout/extract.js'
import { changedQuestions, planDetections } from './lookout/detect.js'
import { readPaneTail } from './lookout/tail.js'
import { lookoutBadgeCount } from './lookout/badge.js'
import { CardStack } from './lookout/CardStack.js'
import { refusalMessage } from './lookout/refusal.js'
import type { DraftStore } from './lookout/drafts.js'

const CELL_FALLBACK = { cellW: 7.8, cellH: 15 }

export function App(): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [home, setHome] = useState('')
  const [state, dispatch] = useReducer(reducer, null, (): AppState => ({
    tabs: [],
    activeTabId: '',
    sidebarVisible: true,
    explorerRoot: '',
    revealPath: null,
    system: null,
    toast: null,
  }))

  const [zoomIndex, setZoomIndex] = useState(loadZoomIndex)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [railHeight, setRailHeight] = useState(loadRailHeight)
  /** Lookout hidden by the user (Cmd+Shift+B). Runtime-only on purpose: cards
   *  are process-lifetime anyway, and a hidden Lookout that survived a restart
   *  would look like the feature had broken. The status-bar badge still
   *  counts while hidden, so nothing waiting goes unannounced. */
  const [lookoutHidden, setLookoutHidden] = useState(false)
  const railRef = useRef<HTMLElement | null>(null)
  /** Shell drawer (⌘J): open state is runtime-only — a scratch shell that
   *  reopened itself on launch would be presuming; height persists. */
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerHeight, setDrawerHeight] = useState(loadDrawerHeight)
  /**
   * Panes that have a drawer shell, in the order they first opened one.
   *
   * The drawer is one shell PER PANE, so this is the mount list: every id here
   * gets a DrawerShell instance, and all but the focused one render hidden so
   * their session, history and scrollback survive switching panes. Grown
   * lazily — a pane that never opens the drawer never costs a shell.
   */
  const [drawerPanes, setDrawerPanes] = useState<string[]>([])
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [tutorialOpen, setTutorialOpen] = useState(() => !hasSeenTutorial())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  /** Which scope the projects panel opens on. The panel is mounted only while
   *  open, so it reads this once per open rather than tracking it. */
  const [projectsScope, setProjectsScope] = useState<SaveScope>('window')
  const [projects, setProjects] = useState<Project[]>([])
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [lookoutCards, setLookoutCards] = useState<LookoutCard[]>([])
  const [lookoutPlugin, setLookoutPlugin] = useState(false)

  const updateSettings = useCallback((next: Settings) => {
    setSettings(next)
    saveSettings(next)
  }, [])

  /**
   * Appearance, applied whenever it changes.
   *
   * Two halves, because CSS custom properties only ever reach the chrome. The
   * tokens go on the root element; the terminal palette has to be handed to
   * xterm separately, which paints from its own colour table. Setting
   * `options.theme` re-renders existing scrollback in the new colours without
   * reflowing, so nothing is lost and no terminal is rebuilt.
   *
   * main.tsx applies the same thing once before React renders, so the first
   * paint is already in the right theme; this is only for changes after that.
   */
  useEffect(() => {
    const choice = {
      theme: settings.theme,
      paneStyle: settings.paneStyle,
      palette: settings.palette,
      crt: settings.crt,
      accent: settings.accent,
    }
    applyTheme(document.documentElement, choice)

    const xterm = xtermThemeFrom(themeVars(choice))
    setCurrentXtermTheme(xterm)
    for (const t of terminals.values()) t.setTheme(xterm)
  }, [
    settings.theme,
    settings.paneStyle,
    settings.palette,
    settings.crt,
    settings.accent,
  ])

  useEffect(() => unlockAudio(), [])

  const refreshProjects = useCallback(async () => {
    const res = await window.seashell.projects.list()
    setProjects(res.projects)
  }, [])

  useEffect(() => {
    if (projectsOpen) void refreshProjects()
  }, [projectsOpen, refreshProjects])

  /**
   * Read through a ref so `newPane` and the menu-command handler do not have to
   * list settings as a dependency. Both are rebuilt on every change to their
   * deps, and the command handler re-subscribes to the IPC channel when it is —
   * churning that on a checkbox is needless.
   */
  const autoColorRef = useRef(false)
  autoColorRef.current = settings.autoColorPanes


  /**
   * Pings on the *transition* into attention, never on the state.
   *
   * Attention is recomputed on every metrics tick, so reacting to "this pane
   * wants attention" would re-fire every few seconds for as long as an agent
   * sat waiting. What is worth hearing is the moment it starts asking.
   *
   * Sleep gates the sound as well as the glow — `attentionGlow` is what the
   * moon in the tab bar toggles, and a ping that survived it would defeat the
   * point of the control.
   */
  const prevAttention = useRef(new Map<string, string>())
  useEffect(() => {
    const seen = new Map<string, string>()
    let started = false

    for (const tab of state.tabs) {
      for (const pane of Object.values(tab.panes)) {
        const now = pane.attention ?? ''
        seen.set(pane.id, now)
        if (now !== '' && (prevAttention.current.get(pane.id) ?? '') === '') started = true
      }
    }
    prevAttention.current = seen

    if (started && settings.attentionGlow && settings.attentionSound) {
      playAttentionPing()
    }
  }, [state.tabs, settings.attentionGlow, settings.attentionSound])
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState<{ nonce: number; direction: 'next' | 'prev' }>({
    nonce: 0,
    direction: 'next',
  })

  const gridRef = useRef<HTMLDivElement | null>(null)
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 })

  // Chrome scale is a CSS variable, so it must be published before first paint —
  // a layout effect, not an effect, or the first frame renders at the wrong size.
  useLayoutEffect(() => {
    applyUiScale(zoomIndex)
    saveZoomIndex(zoomIndex)
  }, [zoomIndex])

  // The zoom key listener is bound once and must read the live global rung.
  const zoomIndexRef = useRef(zoomIndex)
  zoomIndexRef.current = zoomIndex

  // Same reasoning as the zoom scale: the sidebar width is a CSS variable, so
  // it has to be published before paint or the first frame is the wrong width.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidebar-base', String(sidebarWidth))
  }, [sidebarWidth])

  /**
   * Sidebar resize drag.
   *
   * The pointer's x position is the rendered width directly, since the sidebar
   * is pinned to the window's left edge. It is divided back out by the current
   * zoom scale before storing, so width and zoom stay independent settings.
   */
  /** Bottom-anchored member of the drag family: the drawer's top edge moves,
   *  its bottom edge (the grid's bottom, measured at drag start) stays put. */
  const startDrawerDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const scale = levelAt(zoomIndex).ui
      const bottom = gridRef.current?.getBoundingClientRect().bottom ?? window.innerHeight
      let latest = drawerHeight

      const move = (ev: MouseEvent): void => {
        latest = drawerHeightFromDrag(ev.clientY, bottom, scale)
        setDrawerHeight(latest)
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.classList.remove('dragging')
        saveDrawerHeight(latest)
      }
      document.body.style.cursor = 'row-resize'
      document.body.classList.add('dragging')
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [drawerHeight, zoomIndex]
  )

  /** Vertical twin of startSidebarDrag: trades height between the card rail
   *  and the file explorer below it. The rail's own top is measured at drag
   *  start rather than assumed, so the tab bar's height is never hardcoded. */
  const startRailDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const scale = levelAt(zoomIndex).ui
      const railTop = railRef.current?.getBoundingClientRect().top ?? 0
      let latest = railHeight

      const move = (ev: MouseEvent): void => {
        latest = heightFromDrag(ev.clientY, railTop, scale)
        setRailHeight(latest)
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.classList.remove('dragging')
        saveRailHeight(latest)
      }
      document.body.style.cursor = 'row-resize'
      document.body.classList.add('dragging')
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [railHeight, zoomIndex]
  )

  const startSidebarDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const scale = levelAt(zoomIndex).ui
      let latest = sidebarWidth

      const move = (ev: MouseEvent): void => {
        latest = widthFromDrag(ev.clientX, scale)
        setSidebarWidth(latest)
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.classList.remove('dragging')
        // Persist once on release rather than on every mousemove — a drag emits
        // dozens of events and localStorage writes are synchronous.
        saveSidebarWidth(latest)
      }
      document.body.style.cursor = 'col-resize'
      document.body.classList.add('dragging')
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [sidebarWidth, zoomIndex]
  )

  // Boot: font first, then the initial tab. The font has to be registered
  // before any terminal is opened or the first pane measures the wrong cell.
  //
  // The ref guard is load-bearing: StrictMode intentionally double-invokes
  // effects, and without it boot runs twice and you get two tabs.
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    void (async () => {
      await loadTerminalFont()
      const paths = await window.seashell.app.getPaths()
      setHome(paths.home)
      setHostname(paths.hostname)
      // Dragging the window between screens of different density changes the
      // CSS cell size under a grid nobody re-measures. One watcher for every
      // terminal, started once — see term/dpr.ts.
      watchDevicePixelRatio({ onChange: refitVisibleTerminals })
      dispatch({ type: 'explorer.setRoot', root: paths.home })
      dispatch({
        type: 'tab.new',
        cwd: paths.home,
        home: paths.home,
        autoColor: autoColorRef.current,
      })
      setReady(true)
    })()
  }, [])

  // Route batched PTY output to the right terminal.
  useEffect(() => {
    const offData = window.seashell.pty.onData((e) => {
      for (const b of e.batches) terminals.get(b.paneId)?.write(b.data)
    })
    const offExit = window.seashell.pty.onExit((e) => {
      dispatch({ type: 'pane.exited', paneId: e.paneId, code: e.exitCode, signal: e.signal })
    })
    const offMetrics = window.seashell.metrics.onTick((e) => {
      dispatch({ type: 'metrics', panes: e.panes, system: e.system })
    })
    return () => {
      offData()
      offExit()
      offMetrics()
    }
  }, [])

  // Subscribed once: the card list is pushed whenever it changes, and the
  // plugin flag only needs a single read at boot (Task 7 does not poll it).
  useEffect(() => {
    const off = window.seashell.lookout.onCards((e) => setLookoutCards(e.cards))
    void window.seashell.lookout.getState().then((s) => setLookoutPlugin(s.pluginInstalled))
    return off
  }, [])

  /** paneId -> the last question actually reported for it, so a re-read that
   *  found the same question costs nothing and a new one cards immediately. */
  const lookoutReported = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    if (!settings.lookoutCards) {
      // Disabled means unwatched: drop the last-sent memory so re-enabling
      // reports every pane from scratch instead of trusting stale bookkeeping.
      lookoutReported.current = new Map()
      return
    }
    const panes = state.tabs.flatMap((t) =>
      Object.values(t.panes)
        .filter((p) => p.kind === 'term')
        .map((p) => ({
          paneId: p.id,
          attention: p.attention ?? null,
          focused: t.id === state.activeTabId && t.focusedPaneId === p.id,
        }))
    )
    // Read every waiting pane every pass; only the readings that actually
    // changed cross the IPC boundary. See detect.ts for why re-reading is the
    // cheap half and re-reporting was the expensive half.
    const readings = []
    for (const paneId of planDetections(panes).toScan) {
      const lines = readPaneTail(paneId)
      if (!lines) continue
      const extraction = extractQuestion(lines)
      if (extraction) {
        readings.push({ paneId, question: extraction.question, kind: extraction.kind })
      }
    }
    const { toSend, nextSent } = changedQuestions(readings, lookoutReported.current)
    lookoutReported.current = nextSent
    for (const reading of toSend) window.seashell.lookout.detected(reading)
  }, [settings.lookoutCards, state.tabs, state.activeTabId])

  useEffect(() => {
    window.seashell.lookout.setEnabled(settings.lookoutCards)
  }, [settings.lookoutCards])

  /** Edits in progress, kept across a card unmounting — see lookout/drafts.ts.
   *  A ref, not state: it is written on every keystroke in a draft box, and
   *  nothing outside that box reads it. */
  const lookoutDrafts = useRef<DraftStore>(new Map())

  /**
   * Clock for card ages, ticked once a minute and ONLY while cards exist.
   *
   * Armed off the card list rather than left running, for the same reason
   * main's sweep timer is: this app has spent real work on costing nothing
   * while idle, and a timer that re-renders the tree every minute forever —
   * to update a label on cards that are not there — would give some of that
   * back. `ageLabel` is minute-granular, so a minute is the fastest tick that
   * can change anything on screen.
   */
  const [lookoutNow, setLookoutNow] = useState(() => Date.now())
  const hasCards = lookoutCards.length > 0
  useEffect(() => {
    if (!hasCards) return
    // Stamped immediately as well as on the interval: a card raised 50s after
    // the last tick would otherwise read "now" for its first ten seconds.
    setLookoutNow(Date.now())
    const timer = setInterval(() => setLookoutNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [hasCards])

  // Live per-pane screen shape for the card stack's send-button gate — a
  // fresh xterm-buffer read on every call (render *and* click time), never a
  // cached value. See CardStack's doc comment for why click time re-reads.
  const lookoutScreenMode = useCallback((paneId: string): 'input' | 'selector' | null => {
    const lines = readPaneTail(paneId)
    return lines ? (extractQuestion(lines)?.kind ?? null) : null
  }, [])

  /**
   * What a card should call a pane: the same "N · label" the pane's own header
   * shows, so a card is identifiable at a glance with several agents running.
   * `label` is already whatever is most specific — the user's custom name when
   * they set one, otherwise the claude session title. Falls back to the raw id
   * only when the pane is gone, which is the one case where the id is the only
   * true thing left to say.
   */
  const lookoutPaneName = useCallback(
    (paneId: string): string => {
      for (const tab of state.tabs) {
        const order = dfsPaneOrder(tab.tree)
        const index = order.indexOf(paneId)
        const pane = tab.panes[paneId]
        if (!pane) continue
        const name = pane.label.trim()
        const numbered = index >= 0 ? `${index + 1} · ` : ''
        return name ? `${numbered}${name}` : paneId
      }
      return paneId
    },
    [state.tabs]
  )

  /** The pane's colour tag as hex, so a card carries the same identity the
   *  pane header and tab strip use. Null for an untagged pane. */
  const lookoutPaneColor = useCallback(
    (paneId: string): string | null => {
      for (const tab of state.tabs) {
        const pane = tab.panes[paneId]
        if (pane) return paneColorHex(pane.color)
      }
      return null
    },
    [state.tabs]
  )

  const lookoutGotoPane = useCallback(
    (paneId: string) => {
      const tab = state.tabs.find((t) => t.panes[paneId] !== undefined)
      if (!tab) return
      dispatch({ type: 'tab.select', tabId: tab.id })
      dispatch({ type: 'pane.focus', paneId })
      // Maximize it on arrival: the point of the button is to deal with this
      // pane, and pane.zoom toggles, so only zoom when it is not already the
      // zoomed one — otherwise arriving from a card would un-maximize it.
      if (tab.zoomedPaneId !== paneId) dispatch({ type: 'pane.zoom', paneId })
    },
    [state.tabs]
  )

  const lookoutOnAction = useCallback((req: LookoutActionRequest) => {
    // The response was discarded, which made every refusal indistinguishable
    // from a success: click Approve, nothing happens, card still there. Main
    // refuses for good reasons — a picker painted, the pane exited, the draft
    // grew a line break — and each of them is actionable once said out loud.
    void window.seashell.lookout.action(req).then((res) => {
      if (!res.ok) dispatch({ type: 'toast', message: refusalMessage(res.code) })
    })
  }, [])

  const activeTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeTabId),
    [state.tabs, state.activeTabId]
  )

  const newPane = useCallback(
    (command: PaneCommand, commandText?: string) => {
      dispatch({
        type: 'pane.new',
        home,
        command,
        autoColor: autoColorRef.current,
        ...(commandText ? { commandText } : {}),
      })
    },
    [home]
  )

  /**
   * Panes must be killed, not just forgotten — an orphaned agent process is
   * exactly the problem this app is meant to prevent. Preview panes own no
   * process, so reaping one would be a pointless round trip through the ladder.
   */
  const closePane = useCallback(
    async (paneId: string) => {
      // An editable preview with unsaved edits must not vanish silently.
      if (dirtyPreviewPanes.has(paneId) && !window.confirm('Discard unsaved changes in this file?')) {
        return
      }
      const pane = activeTab?.panes[paneId]
      if (pane && pane.kind === 'term') {
        const res = await window.seashell.pty.kill({ paneId })
        forgetSpawn(paneId)
        if (!res.ok && res.survivors > 0) {
          dispatch({ type: 'toast', message: `${res.survivors} process(es) could not be reaped` })
        }
      }
      dispatch({ type: 'pane.close', paneId })
    },
    [activeTab]
  )

  const closeTab = useCallback(
    async (tabId: string) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      if (
        tab &&
        Object.keys(tab.panes).some((id) => dirtyPreviewPanes.has(id)) &&
        !window.confirm('This tab has a file with unsaved changes. Discard them?')
      ) {
        return
      }
      if (tab) {
        await Promise.all(
          Object.values(tab.panes)
            .filter((p) => p.kind === 'term')
            .map(async (p) => {
              await window.seashell.pty.kill({ paneId: p.id })
              forgetSpawn(p.id)
            })
        )
      }
      dispatch({ type: 'tab.close', tabId })
    },
    [state.tabs]
  )

  /**
   * The project this window came from (opened or last saved-as), so Save can
   * update it in place. Runtime-only: a fresh window belongs to no project
   * until the user says so.
   */
  const [currentProject, setCurrentProject] = useState<{ id: string; name: string } | null>(null)

  /** Closes every preview pane in the active tab, leaving the terminals alone. */
  /**
   * Saves the window, or just the active tab.
   *
   * Tab scope is the "project" level people ask for by name: a tab is already
   * a named group of panes, so saving one is saving a project you can bring
   * into any window later. Window scope stays what it always was — the whole
   * arrangement, which is the workspace.
   *
   * A tab-scope save deliberately does NOT adopt the project as this window's
   * `currentProject`. The in-place Save button writes the whole window, so
   * adopting one would arm a button that silently overwrites a one-tab project
   * with every tab open. Re-saving a tab project is done by name, which the
   * store upserts and the panel confirms.
   */
  const saveProject = useCallback(
    async (name: string, id?: string, scope: 'window' | 'tab' = 'window') => {
      // Capture the claude session ids live in these panes right now — a
      // restarted claude has a new id, and saving must record the current
      // one, not the one from when the project was first created.
      const livePanes = state.tabs.flatMap((t) =>
        Object.values(t.panes)
          .filter((p) => p.kind === 'term')
          .map((p) => ({ paneId: p.id, cwd: p.cwd }))
      )
      let sessionIds: ReadonlyMap<string, string> | undefined
      try {
        const res = await window.seashell.projects.sessionIds({ panes: livePanes.slice(0, 64) })
        sessionIds = new Map(Object.entries(res.ids))
      } catch {
        sessionIds = undefined // registry unavailable: panes save as plain claude
      }
      const tabs =
        scope === 'tab'
          ? activeTab
            ? [tabToSaved(activeTab, sessionIds)]
            : []
          : stateToTabs(state, sessionIds)
      if (tabs.length === 0) {
        dispatch({ type: 'toast', message: 'Nothing to save' })
        return
      }

      const res = await window.seashell.projects.save({
        ...(id ? { id } : {}),
        name,
        tabs,
      })
      if (!res.ok) {
        dispatch({ type: 'toast', message: `Could not save project (${res.code})` })
        return
      }
      if (scope === 'window') setCurrentProject({ id: res.project.id, name: res.project.name })
      await refreshProjects()
      dispatch({
        type: 'toast',
        message:
          scope === 'tab'
            ? `Saved tab as “${res.project.name}”`
            : `Saved project “${res.project.name}”`,
      })
    },
    [state, activeTab, refreshProjects]
  )

  /**
   * Opening a project replaces the window, so every pane currently open has to
   * be reaped first. Skipping that would leave the shells of the tabs being
   * replaced running with nothing on screen pointing at them — the exact
   * orphaned-process outcome this app exists to prevent, made worse by being
   * invisible.
   */
  /**
   * A project's saved tabs, rebuilt with fresh ids and their claude sessions
   * resolved. Shared by opening a project (which replaces the window) and
   * adding one (which does not), so the two can never drift on the part that
   * decides whether a restored agent pane resumes its session or starts cold.
   */
  const restoreProjectTabs = useCallback(async (project: Project) => {
    const restored = tabsFromSaved(project.tabs, uid)
    if (restored.length === 0) return []

    // A project saved before its panes could be matched to sessions carries no
    // ids at all, and re-saving it is not something the user should have to
    // know to do. Any claude pane still missing one gets resolved here, from
    // the newest transcript for its own directory.
    const needIds = restored.flatMap((t) =>
      Object.values(t.panes)
        .filter((p) => p.kind === 'term' && p.command === 'claude' && !p.claudeSessionId)
        .map((p) => ({ paneId: p.id, cwd: p.cwd }))
    )
    if (needIds.length > 0) {
      try {
        const res = await window.seashell.projects.sessionIds({ panes: needIds.slice(0, 64) })
        for (const tab of restored) {
          for (const pane of Object.values(tab.panes)) {
            const sid = res.ids[pane.id]
            if (sid) pane.claudeSessionId = sid
          }
        }
      } catch {
        /* unresolved panes just open as a fresh claude, the old behaviour */
      }
    }
    return restored
  }, [])

  /**
   * Adds a project's tabs to this window, leaving everything already open
   * alone — the counterpart to Open, and the reason saving a single tab is
   * useful. Nothing is reaped here precisely because nothing is being
   * replaced.
   */
  const addProject = useCallback(
    async (project: Project) => {
      const restored = await restoreProjectTabs(project)
      if (restored.length === 0) {
        dispatch({ type: 'toast', message: 'That project has nothing to add' })
        return
      }
      dispatch({ type: 'tabs.append', tabs: restored })
      setProjectsOpen(false)
      dispatch({
        type: 'toast',
        message:
          restored.length === 1
            ? `Added “${project.name}”`
            : `Added “${project.name}” (${restored.length} tabs)`,
      })
    },
    [restoreProjectTabs]
  )

  const openProject = useCallback(
    async (project: Project) => {
      const restored = await restoreProjectTabs(project)
      if (restored.length === 0) {
        dispatch({ type: 'toast', message: 'That project has nothing to open' })
        return
      }

      const live = state.tabs.flatMap((t) =>
        Object.values(t.panes).filter((p) => p.kind === 'term')
      )
      await Promise.all(
        live.map(async (p) => {
          await window.seashell.pty.kill({ paneId: p.id })
          forgetSpawn(p.id)
        })
      )

      dispatch({ type: 'tabs.replace', tabs: restored })
      setCurrentProject({ id: project.id, name: project.name })
      setProjectsOpen(false)
      dispatch({ type: 'toast', message: `Opened “${project.name}”` })
    },
    [state.tabs, restoreProjectTabs]
  )

  const deleteProject = useCallback(
    async (project: Project) => {
      await window.seashell.projects.remove({ id: project.id })
      setCurrentProject((cur) => (cur?.id === project.id ? null : cur))
      await refreshProjects()
    },
    [refreshProjects]
  )

  /**
   * Reveals a resolved path in the explorer.
   *
   * The tree can only expand to something beneath its root, so a real file
   * outside it — /tmp, /opt, another volume — would expand nothing and select
   * nothing. That is indistinguishable from a broken double-click, so it says
   * so instead of failing quietly.
   */
  const revealPath = useCallback(
    (p: string, isDir: boolean) => {
      const root = state.explorerRoot
      if (root && !(p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`))) {
        dispatch({ type: 'toast', message: `${p} is outside the file explorer` })
        return
      }
      dispatch({ type: 'explorer.reveal', path: p, isDir })
    },
    [state.explorerRoot]
  )

  const closeAllPreviews = useCallback(() => {
    if (!activeTab) return
    const previews = Object.values(activeTab.panes).filter((p) => p.kind !== 'term')
    if (previews.length === 0) {
      dispatch({ type: 'toast', message: 'No preview panes open' })
      return
    }
    for (const p of previews) dispatch({ type: 'pane.close', paneId: p.id })
  }, [activeTab])

  const openFind = useCallback(() => {
    const pane = activeTab?.focusedPaneId ? activeTab.panes[activeTab.focusedPaneId] : undefined
    // A web preview hosts its own page with its own find; there is nothing here
    // to search that this bar could reach.
    if (pane?.kind === 'web') {
      dispatch({ type: 'toast', message: 'Find is not available in a web preview' })
      return
    }
    setFindOpen(true)
  }, [activeTab])

  const stepFind = useCallback((direction: 'next' | 'prev') => {
    setFindOpen(true)
    setFind((f) => ({ nonce: f.nonce + 1, direction }))
  }, [])

  // Menu accelerators arrive here regardless of DOM focus — which is exactly
  // why the Edit commands have to work out their own target (see below).
  useEffect(() => {
    const off = window.seashell.app.onCommand(({ command }) => {
      if (command.startsWith('tab.select.')) {
        dispatch({ type: 'tab.selectIndex', index: Number(command.split('.')[2]) })
        return
      }
      /**
       * The terminal an Edit command acts on: whichever one actually holds the
       * keyboard, falling back to the focused pane when focus is elsewhere.
       *
       * NOT `focusedPaneId` on its own. The ⌘J drawer is a terminal that is
       * deliberately not a pane, so while the user typed in the drawer these
       * commands still resolved to the pane behind it — ⌘V pasted the
       * clipboard into an agent's pty (submitting itself if it ended in a
       * newline), ⌘K cleared that agent's pane, ⌘C copied its selection.
       * See term/edit-target.ts.
       */
      const editTarget = (): string | null =>
        editTargetId(terminals, document.activeElement, activeTab?.focusedPaneId ?? null)

      /**
       * Focus in an ordinary text field — a card's draft box, the find bar, a
       * project name — where the edit belongs to the field, not to any pane.
       *
       * These menu items are deliberately not `role:'paste'` (a role would
       * swallow the chord before a focused terminal saw it), so the browser's
       * own paste never runs and the command has to do the work itself. Asked
       * only AFTER the terminal check, because xterm's keystroke sink is
       * itself a <textarea>. See term/edit-target.ts.
       */
      const textField = (): HTMLElement | null => {
        const el = document.activeElement
        if (terminalOwningFocus(terminals, el)) return null
        return isTextField(el) ? (el as HTMLElement) : null
      }
      switch (command) {
        case 'tab.new':
          dispatch({ type: 'tab.new', cwd: home, home, autoColor: autoColorRef.current })
          break
        case 'tab.close':
          if (activeTab) void closeTab(activeTab.id)
          break
        case 'tab.next':
          dispatch({ type: 'tab.cycle', delta: 1 })
          break
        case 'tab.prev':
          dispatch({ type: 'tab.cycle', delta: -1 })
          break
        case 'pane.new':
          newPane('zsh')
          break
        case 'pane.close':
          if (activeTab?.focusedPaneId) void closePane(activeTab.focusedPaneId)
          break
        case 'pane.closeAll':
          closeAllPreviews()
          break
        case 'pane.next':
          dispatch({ type: 'pane.cycle', delta: 1 })
          break
        case 'pane.prev':
          dispatch({ type: 'pane.cycle', delta: -1 })
          break
        case 'pane.zoom':
          dispatch({ type: 'pane.zoom' })
          break
        case 'pane.clear': {
          // Nothing to clear in a text box, and clearing the pane behind it is
          // not what ⌘K in a draft box could possibly mean — throwing away a
          // pane's scrollback as a side effect of a keystroke aimed at a form.
          if (textField()) break
          const id = editTarget()
          if (id) terminals.get(id)?.term.clear()
          break
        }
        case 'preview.file':
          dispatch({ type: 'toast', message: 'Double-click a file in the explorer to preview it' })
          dispatch({ type: 'explorer.reveal', path: null })
          break
        case 'preview.web':
          dispatch({ type: 'pane.newWeb', url: '', autoColor: autoColorRef.current })
          break
        case 'layout.rebalance':
          dispatch({ type: 'layout.rebalance' })
          break
        case 'lookout.toggle':
          setLookoutHidden((h) => !h)
          break
        case 'drawer.toggle':
          setDrawerOpen((o) => !o)
          break
        case 'tab.rename':
          // Opens the same inline field the tab's double-click opens.
          if (activeTab) setRenamingTabId(activeTab.id)
          break
        case 'explorer.toggle':
          dispatch({ type: 'explorer.toggle' })
          break
        case 'explorer.refresh':
          setExplorerNonce((n) => n + 1)
          break
        case 'help.tutorial':
          setTutorialOpen(true)
          break
        case 'app.projects':
          setProjectsOpen(true)
          break
        case 'app.saveProject':
          // Saving needs a name, and the panel is where names are entered.
          setProjectsScope('window')
          setProjectsOpen(true)
          break
        case 'app.saveTab':
          // Same panel, landing on the scope the menu item promised.
          setProjectsScope('tab')
          setProjectsOpen(true)
          break
        case 'app.settings':
          setSettingsOpen(true)
          break
        // The menu's zoom items are global, so they also clear per-pane
        // overrides — otherwise a pane that had been zoomed would ignore them.
        case 'ui.zoomIn':
          setZoomIndex((i) => clampIndex(i + 1))
          dispatch({ type: 'pane.clearTextZoom' })
          break
        case 'ui.zoomOut':
          setZoomIndex((i) => clampIndex(i - 1))
          dispatch({ type: 'pane.clearTextZoom' })
          break
        case 'ui.zoomReset':
          setZoomIndex(DEFAULT_ZOOM_INDEX)
          dispatch({ type: 'pane.clearTextZoom' })
          break
        case 'edit.find':
          openFind()
          break
        case 'edit.findNext':
          stepFind('next')
          break
        case 'edit.findPrev':
          stepFind('prev')
          break
        case 'edit.copy': {
          const field = textField()
          if (field) {
            // The field's own selection, not the pane's. Copying a terminal's
            // selection while the user has text highlighted in a draft box is
            // simply the wrong text.
            const sel = window.getSelection()?.toString() ?? ''
            if (sel) void navigator.clipboard.writeText(sel)
            break
          }
          const id = editTarget()
          const t = id ? terminals.get(id) : undefined
          const sel = t?.term.getSelection() ?? ''
          // No selection must be a no-op. Falling through to anything else here
          // is how a copy shortcut turns into an interrupt.
          if (sel) void navigator.clipboard.writeText(sel)
          break
        }
        case 'edit.paste': {
          // Both targets are resolved BEFORE the await: the clipboard read is
          // async, and reading focus after it would let a focus change land
          // the paste somewhere the user was no longer looking when they hit
          // ⌘V — including, in the worst case, an agent's pty.
          const field = textField()
          const id = field ? null : editTarget()
          if (!field && !id) break
          void navigator.clipboard.readText().then((text) => {
            if (!text) return
            if (field) {
              // insertText rather than assigning .value: it goes in at the
              // caret, replaces the selection, keeps the field's native undo
              // stack, and emits the input event React needs to see for a
              // controlled component (the card's draft box is one — assigning
              // .value directly would be silently reverted on the next
              // render).
              field.focus()
              document.execCommand('insertText', false, text)
              return
            }
            if (id) terminals.get(id)?.term.paste(text)
          })
          break
        }
        case 'edit.selectAll': {
          // Scoped to the line being typed, not the whole scrollback — see
          // inputline.ts. Selecting thousands of transcript lines is not what
          // anyone means by select-all in a pane running an agent.
          const field = textField()
          if (field) {
            // ⌘A in a text box selects that box. It used to arm the pane's
            // input-line selection instead, which leaves the pane primed to
            // kill its line on the next keystroke — a ⌘A aimed at a draft box
            // could wipe what the user had typed at an agent's prompt.
            ;(field as HTMLInputElement | HTMLTextAreaElement).select?.()
            break
          }
          const id = editTarget()
          if (id) terminals.get(id)?.selectInputLine()
          break
        }
        default:
          break
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, home, newPane, closePane, closeTab, closeAllPreviews, openFind, stepFind])

  /**
   * Zoom keys are bound here rather than as menu accelerators.
   *
   * An Electron menu item takes exactly one accelerator, and these chords come
   * in shifted/unshifted pairs that must behave differently, so a menu binding
   * would leave one form of each dead. See the note in menu.ts.
   *
   * SHIFT IS THE WHOLE DISTINCTION, and it is not optional punctuation: on a US
   * layout `+` *is* Shift+`=` and `_` *is* Shift+`-`, so these are four separate
   * `e.key` values off two physical keys.
   *
   *   ⌘=  → global zoom in      ⌘+  (⌘⇧=) → focused pane only
   *   ⌘-  → global zoom out     ⌘_  (⌘⇧-) → focused pane only
   *
   * Consequence worth knowing: global zoom-in is ⌘= and NOT ⌘+, because ⌘+
   * cannot be typed without Shift and Shift now means "this pane". Every label
   * in the UI says ⌘= for that reason.
   *
   * This is safe to do at the document level because xterm's key handler
   * returns false for every Cmd chord except Cmd+A without calling
   * preventDefault, so the event reaches here without ever reaching the PTY.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return
      // Read through a ref: this listener is bound once, and a stale closure
      // would make every pane zoom step from the level at mount.
      const base = zoomIndexRef.current
      if (e.key === '=') {
        e.preventDefault()
        setZoomIndex((i) => clampIndex(i + 1))
        dispatch({ type: 'pane.clearTextZoom' })
      } else if (e.key === '-') {
        e.preventDefault()
        setZoomIndex((i) => clampIndex(i - 1))
        dispatch({ type: 'pane.clearTextZoom' })
      } else if (e.key === '+') {
        e.preventDefault()
        dispatch({ type: 'pane.zoomText', delta: 1, base })
      } else if (e.key === '_') {
        e.preventDefault()
        dispatch({ type: 'pane.zoomText', delta: -1, base })
      } else if (e.key === '0') {
        e.preventDefault()
        setZoomIndex(DEFAULT_ZOOM_INDEX)
        dispatch({ type: 'pane.clearTextZoom' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Escape closes the find bar from anywhere, including a focused terminal.
  useEffect(() => {
    if (!findOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const id = activeTab?.focusedPaneId
        if (id) terminals.get(id)?.clearSearch()
        setFindOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findOpen, activeTab])

  const [explorerNonce, setExplorerNonce] = useState(0)

  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setGridSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    setGridSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [ready])

  /**
   * Geometry depends on the *shape* of the active tab, never on its numbers.
   *
   * These three memos used to list `activeTab` itself, which changes identity
   * on every metrics tick — so a pane's memory reading ticking over made the
   * window recompute its entire layout, several times a minute, forever. The
   * reducer now holds a tab's identity steady when nothing about it changed,
   * but that alone cannot help here: RSS and CPU genuinely do move every sweep.
   * Depending on what is actually read is what makes the layout independent of
   * numbers that were never an input to it.
   */
  const tree = activeTab?.tree
  const zoomedPaneId = activeTab?.zoomedPaneId ?? null
  // A plain find over at most six entries — cheaper than the re-render it
  // avoids, and it reduces to a stable string the memo below can depend on.
  const termPaneId = activeTab
    ? Object.values(activeTab.panes).find((p) => p.kind === 'term')?.id
    : undefined

  const cell = useMemo(() => {
    // Measure from a terminal pane specifically — a preview pane has no cell
    // geometry, and the first pane in insertion order may well be one.
    const t = termPaneId ? terminals.get(termPaneId) : undefined
    const core = t
      ? (t.term as unknown as {
          _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } }
        })._core?._renderService?.dimensions?.css?.cell
      : undefined
    return core ? { cellW: core.width, cellH: core.height } : CELL_FALLBACK
  }, [termPaneId, gridSize, zoomIndex])

  const rects = useMemo(() => {
    if (!tree || gridSize.width === 0) return []
    return computeLayout(tree, gridSize, cell)
  }, [tree, gridSize, cell])

  const dividers = useMemo(() => {
    if (!tree || rects.length === 0 || zoomedPaneId) return []
    return deriveDividers(tree, rects, gridSize)
  }, [tree, rects, gridSize, zoomedPaneId])

  /**
   * Divider drag. Dragging marks the tab non-pristine, which stops auto-arrange
   * from silently undoing the user's sizing on the next pane close.
   */
  const startDrag = useCallback(
    (divider: DividerSpec, e: React.MouseEvent) => {
      e.preventDefault()
      const grid = gridRef.current
      const tab = activeTab
      if (!grid || !tab) return
      const box = grid.getBoundingClientRect()

      let tree: RowNode = tab.tree
      const move = (ev: MouseEvent): void => {
        const pointer =
          divider.orientation === 'v' ? ev.clientX - box.left : ev.clientY - box.top
        tree = applyDividerDrag(tree, divider, pointer, gridSize, cell)
        dispatch({ type: 'layout.setTree', tree, pristine: false })
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.classList.remove('dragging')
      }
      document.body.style.cursor = divider.orientation === 'v' ? 'col-resize' : 'row-resize'
      // Suppresses pointer events inside webview panes for the duration of the
      // drag. Without it the guest page swallows mousemove the moment the
      // pointer crosses into it and the divider stops following the cursor.
      document.body.classList.add('dragging')
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [activeTab, gridSize, cell]
  )

  useEffect(() => {
    if (!state.toast) return
    const id = setTimeout(() => dispatch({ type: 'toast', message: null }), 3200)
    return () => clearTimeout(id)
  }, [state.toast])

  // Closing the drawer hands the keyboard back to the pane that had it. The
  // ref skips the mount pass, which would otherwise steal focus at boot.
  // ⚠️ Hooks stop being legal at the `!ready` return below — anything with a
  // hook in it goes ABOVE this comment. (Learned the hard way: this pair
  // started out further down and took the whole first paint with it, React
  // #310.)
  const drawerWasOpen = useRef(false)
  useEffect(() => {
    if (drawerWasOpen.current && !drawerOpen) {
      const id = activeTab?.focusedPaneId
      if (id) terminals.get(id)?.term.focus()
    }
    drawerWasOpen.current = drawerOpen
    // Reacts to the toggle alone; the focused pane is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen])

  /**
   * Give the focused pane a drawer shell the first time it needs one.
   *
   * Lazy on purpose: mounting a DrawerShell spawns a login shell, so doing it
   * for every pane up front would cost six shells nobody asked for. Runs while
   * the drawer is open, which also covers switching panes with it open.
   */
  /**
   * Which pane the drawer belongs to right now.
   *
   * Falls back to the first pane in the tab rather than trusting
   * `focusedPaneId`, which is legitimately null — `focusAfterClose` returns
   * null once the last pane in a tab goes, and a restored project can land the
   * same way. With one shared drawer that never mattered because it was always
   * mounted; now the mount list is keyed by pane, so a null here would mean
   * ⌘J opens nothing at all, which reads as the feature being broken rather
   * than as "no pane is focused".
   */
  const drawerPaneId = useMemo(() => {
    if (!activeTab) return null
    return activeTab.focusedPaneId ?? Object.keys(activeTab.panes)[0] ?? null
  }, [activeTab])

  useEffect(() => {
    if (!drawerOpen || !drawerPaneId) return
    setDrawerPanes((ids) => (ids.includes(drawerPaneId) ? ids : [...ids, drawerPaneId]))
  }, [drawerOpen, drawerPaneId])

  /**
   * Reap a drawer shell whose pane is gone.
   *
   * Derived from live state rather than hooked into each of the several paths
   * that destroy a pane — closing one, closing a tab, opening a project (which
   * reaps every pane at once). Any of those that was missed would leave a
   * login shell running with no way to reach it, and the app's one promise is
   * that nothing it started outlives it.
   *
   * Unmounting alone is not enough: the component's cleanup disposes the
   * terminal but a pty is main's, so it is killed explicitly here.
   */
  const livePaneIds = useMemo(
    () => new Set(state.tabs.flatMap((t) => Object.keys(t.panes))),
    [state.tabs]
  )
  useEffect(() => {
    const orphans = drawerPanes.filter((id) => !livePaneIds.has(id))
    if (orphans.length === 0) return
    setDrawerPanes((ids) => ids.filter((id) => livePaneIds.has(id)))
    for (const id of orphans) {
      void window.seashell.pty.kill({ paneId: drawerPtyId(id) })
    }
  }, [drawerPanes, livePaneIds])

  if (!ready) return <div className="empty">Starting SeaShell…</div>

  const order = activeTab ? dfsPaneOrder(activeTab.tree) : []
  const full = activeTab ? Object.keys(activeTab.panes).length >= MAX_PANES_PER_TAB : false
  const fontSize = levelAt(zoomIndex).font
  // Any pane anywhere overriding the global level — drives the "*" and keeps the
  // reset control reachable even when the overall level is already 100%.
  const panesAreZoomed = state.tabs.some((t) =>
    Object.values(t.panes).some((p) => p.zoomIndex !== undefined)
  )
  // Suppression (hiding the focused pane's card from the stack, below) is a
  // visibility rule only — the badge counts every active card regardless of
  // pane, so it does not move just because focus does.
  const suppressedPaneId = activeTab?.focusedPaneId ?? null
  /**
   * Zeroed the instant Lookout is switched off, without waiting for main to
   * clear the store and push an empty list back. That round trip is short, but
   * it is long enough to paint one frame of "cards are off" next to a status
   * bar badge reading 3 — and a count of things the user just turned off is
   * exactly the kind of small lie that makes a switch look untrustworthy.
   */
  const lookoutCount = settings.lookoutCards ? lookoutBadgeCount(lookoutCards) : 0

  /** Mirrors CardStack's own "is there anything to show" rule — a card for the
   *  focused pane is suppressed, so it does not make the rail appear. */
  /**
   * Lookout is a DEDICATED section, not a popup: it is there whenever the user
   * has not hidden it, empty or not. An earlier version showed it only while
   * cards existed, which meant a fresh launch — cards are process-lifetime, so
   * every launch starts with none — looked exactly like a build with no Lookout
   * in it at all. A section you cannot find when it is idle is not a section.
   */
  const railVisible = !lookoutHidden

  return (
    <div className="app">
      {/* The desktop behind the glass. Aero is the only theme that paints it,
          and it is what the translucent chrome above is translucent *against*
          — without it, backdrop-filter has nothing to blur and the frosted
          surfaces read as flat pale blue. Every other theme leaves --deskImg
          unset, so this is a zero-opacity empty layer. */}
      <div className="app__desk" aria-hidden="true" />

      <div className="tabbar">
        <div className="tabbar__tabs">
          {state.tabs.map((t) => (
            <div
              key={t.id}
              className={'tab' + (t.id === state.activeTabId ? ' tab--active' : '')}
              onMouseDown={() => dispatch({ type: 'tab.select', tabId: t.id })}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest('.tab__close')) return
                setRenamingTabId(t.id)
              }}
            >
              {renamingTabId === t.id ? (
                <TabNameInput
                  initial={t.name}
                  onCommit={(name) => {
                    dispatch({ type: 'tab.rename', tabId: t.id, name, home })
                    setRenamingTabId(null)
                  }}
                  onCancel={() => setRenamingTabId(null)}
                />
              ) : (
                <span className="tab__name" title="Double-click to rename">
                  {t.name}
                </span>
              )}
              <span
                className="tab__close"
                title="Close tab (⌘⇧W)"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(t.id)
                }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
        <div
          className="tabbar__new"
          title="New tab (⌘T)"
          onClick={() =>
            dispatch({ type: 'tab.new', cwd: home, home, autoColor: settings.autoColorPanes })
          }
        >
          +
        </div>
        <div
          className="tabbar__new"
          title={full ? `Tab is full (${MAX_PANES_PER_TAB} panes)` : 'New pane (⌘D)'}
          style={full ? { opacity: 0.4 } : undefined}
          onClick={() => !full && newPane('zsh')}
        >
          ⊞
        </div>
        <div
          className="tabbar__new"
          title="New web preview (⌘⇧U)"
          style={full ? { opacity: 0.4 } : undefined}
          onClick={() =>
            !full && dispatch({ type: 'pane.newWeb', url: '', autoColor: settings.autoColorPanes })
          }
        >
          ◍
        </div>

        {/* Pushes sleep and settings to the right-hand end of the bar. */}
        <span className="tabbar__gap" />

        {/*
          The overall level, and the way back from any combination of per-pane
          zooms. Shown only when something is off-default: at 100% with no pane
          overrides there is nothing to say and nothing to reset.
        */}
        {(zoomIndex !== DEFAULT_ZOOM_INDEX || panesAreZoomed) && (
          <div
            className="tabbar__zoom"
            title="Overall zoom (⌘= / ⌘-). Click to reset every pane to 100%."
            onClick={() => {
              setZoomIndex(DEFAULT_ZOOM_INDEX)
              dispatch({ type: 'pane.clearTextZoom' })
            }}
          >
            {zoomPercent(zoomIndex)}%{panesAreZoomed && <span className="tabbar__zoom-mixed">*</span>}
          </div>
        )}

        {/*
          Sleep is the same preference the settings panel exposes, surfaced as
          one click. The glow exists to interrupt you, so the control that stops
          it interrupting has to be reachable without opening a panel and
          reading a list — by the time you have done that, you have already been
          interrupted.
        */}
        <div
          className={'tabbar__new tabbar__sleep' + (settings.attentionGlow ? '' : ' tabbar__sleep--on')}
          title={
            settings.attentionGlow
              ? 'Sleep — stop panes flashing for attention'
              : 'Asleep — panes will not flash. Click to wake.'
          }
          onClick={() => updateSettings({ ...settings, attentionGlow: !settings.attentionGlow })}
        >
          {settings.attentionGlow ? '☾' : '☽'}
        </div>

        <div
          className="tabbar__new"
          title="Settings (⌘,)"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </div>
      </div>

      <div className="body">
        {/* Reserved space, not an overlay: the rail is a column above the file
            explorer, so a card never covers terminal content and never covers
            the tree either — the explorer gives up height, the panes give up
            nothing. Hidden entirely via :empty when CardStack renders nothing,
            so an empty rail costs the explorer no height at all. Cards stack
            here and stay until answered; see .lookout-rail in styles.css. */}
        <div className="sidebar-col">
          {railVisible && (
            <div className={'lookout-head' + (settings.lookoutCards ? '' : ' lookout-head--off')}>
              <span className="lookout-head__title">Lookout</span>
              {lookoutCount > 0 && <span className="lookout-head__count">{lookoutCount}</span>}
              {/* The actual off switch. Distinct from ✕ on purpose: ✕ (and
                  ⇧⌘B) hide the section while detection carries on behind it,
                  which is what you want for a panel and not what you want when
                  cards are in your way. This one stops the watching and clears
                  what is showing, and it is the same setting the Settings panel
                  writes — one truth, two places to reach it. */}
              <button
                className={
                  'lookout-head__power' +
                  (settings.lookoutCards ? '' : ' lookout-head__power--off')
                }
                title={
                  settings.lookoutCards
                    ? 'Turn cards off — stops watching panes and clears the rail'
                    : 'Cards are off. Click to start watching panes again.'
                }
                aria-pressed={!settings.lookoutCards}
                onClick={() =>
                  updateSettings({ ...settings, lookoutCards: !settings.lookoutCards })
                }
              >
                {settings.lookoutCards ? '◉' : '○'}
              </button>
              <button
                className="lookout-head__hide"
                title="Hide Lookout (⇧⌘B)"
                onClick={() => setLookoutHidden(true)}
              >
                ✕
              </button>
            </div>
          )}
          {/* Gated on railVisible like the header and the grip. It was not,
              which made "Hide Lookout" hide the word Lookout and nothing else:
              ⇧⌘B, the ✕ and the status-bar badge all left every card sitting
              in the sidebar, send buttons and all, with the header that
              explained them gone. The cards ARE the section — hiding the label
              while leaving them on screen is the one reading of the command
              nobody wants. */}
          {railVisible && (
            <aside
              className="lookout-rail"
              ref={railRef}
              style={{ height: `calc(${railHeight}px * var(--ui-scale))` }}
            >
              <CardStack
                cards={lookoutCards}
                suppressedPaneId={suppressedPaneId}
                pluginInstalled={lookoutPlugin}
                enabled={settings.lookoutCards}
                paneName={lookoutPaneName}
                paneColor={lookoutPaneColor}
                screenMode={lookoutScreenMode}
                nowMs={lookoutNow}
                drafts={lookoutDrafts.current}
                onAction={lookoutOnAction}
                onGotoPane={lookoutGotoPane}
              />
            </aside>
          )}
          {/* Only draggable when there is something to drag: with no cards the
              rail is display:none and the grip would resize an invisible box. */}
          {railVisible && state.sidebarVisible && state.explorerRoot && (
            <div
              className="rail__grip"
              title="Drag to resize · double-click to reset"
              onMouseDown={startRailDrag}
              onDoubleClick={() => {
                setRailHeight(RAIL_DEFAULT)
                saveRailHeight(RAIL_DEFAULT)
              }}
            />
          )}
          {state.sidebarVisible && state.explorerRoot && (
            <Explorer
              root={state.explorerRoot}
              home={home}
              revealPath={state.revealPath}
              refreshNonce={explorerNonce}
              onRevealHandled={() => dispatch({ type: 'explorer.reveal', path: null })}
              onOpenInViewer={(p) =>
                dispatch({ type: 'pane.newFile', path: p, autoColor: settings.autoColorPanes })
              }
              onToast={(m) => dispatch({ type: 'toast', message: m })}
            />
          )}
        </div>
        {state.sidebarVisible && state.explorerRoot && (
          <div
            className="sidebar__grip"
            title="Drag to resize · double-click to reset"
            onMouseDown={startSidebarDrag}
            onDoubleClick={() => {
              setSidebarWidth(SIDEBAR_DEFAULT)
              saveSidebarWidth(SIDEBAR_DEFAULT)
            }}
          />
        )}

        <div className="grid" ref={gridRef}>
          {/*
            Every pane of every tab stays mounted; only the active tab's are laid
            out and visible.

            Rendering just the active tab is the obvious thing and it silently
            destroys work: React unmounts the panes whose keys disappeared, the
            pane effect's cleanup disposes their terminals, and main keeps no
            history to replay — so switching tabs threw away the scrollback of the
            tab you left, permanently. The PTY survived, which is what made it
            look like a rendering glitch rather than data loss.

            Hidden panes cost almost nothing to keep: `display: none` stops them
            painting, the refit effect skips them so no SIGWINCH is sent for a
            size nobody can see, and their WebGL context is released while hidden
            (see TerminalBody) so mounting several tabs cannot walk into
            Chromium's per-page context limit.
          */}
          {state.tabs.map((tab) => {
            const isActive = tab.id === state.activeTabId
            // Only the active tab has computed geometry. An inactive tab's panes
            // are display:none, so their rect is never used for anything.
            const tabRects = isActive
              ? rects
              : dfsPaneOrder(tab.tree).map((paneId) => ({
                  paneId,
                  x: 0,
                  y: 0,
                  width: 0,
                  height: 0,
                }))
            const tabOrder = isActive ? order : dfsPaneOrder(tab.tree)

            return tabRects.map((r) => {
              const pane = tab.panes[r.paneId]
              if (!pane) return null
              const zoomed = tab.zoomedPaneId
              const isZoomTarget = zoomed === r.paneId
              const rect =
                isActive && isZoomTarget
                  ? { x: 0, y: 0, width: gridSize.width, height: gridSize.height }
                  : r
              // A background tab's panes must never take focus or answer a find.
              const isFocused = isActive && tab.focusedPaneId === r.paneId
              const isHidden = !isActive || (zoomed !== null && !isZoomTarget)
              return (
                <PaneView
                  key={r.paneId}
                  pane={pane}
                  index={tabOrder.indexOf(r.paneId) + 1}
                  rect={rect}
                  focused={isFocused}
                  hidden={isHidden}
                  fontSize={pane.zoomIndex === undefined ? fontSize : levelAt(pane.zoomIndex).font}
                  zoomIndex={pane.zoomIndex}
                  findOpen={findOpen && isFocused}
                  findNonce={find.nonce}
                  findDirection={find.direction}
                  onCloseFind={() => setFindOpen(false)}
                  onFocus={() => dispatch({ type: 'pane.focus', paneId: r.paneId })}
                  onClose={() => void closePane(r.paneId)}
                  onZoom={() => dispatch({ type: 'pane.zoom', paneId: r.paneId })}
                  onReveal={(p, isDir) => revealPath(p, isDir)}
                  onSpawned={(pid) => dispatch({ type: 'pane.spawned', paneId: r.paneId, pid })}
                  onRestart={() => dispatch({ type: 'pane.restarting', paneId: r.paneId })}
                  onUrlChange={(url) => dispatch({ type: 'pane.setUrl', paneId: r.paneId, url })}
                  onToggleRaw={(raw) =>
                    dispatch({ type: 'pane.setRawSource', paneId: r.paneId, raw })
                  }
                  onSetColor={(color) =>
                    dispatch({ type: 'pane.setColor', paneId: r.paneId, color })
                  }
                  onCwd={(cwd) =>
                    dispatch({ type: 'pane.cwd', paneId: r.paneId, cwd, home })
                  }
                  onTitle={(title) => {
                    if (!settings.autoTitlePanes) return
                    dispatch({ type: 'pane.autoTitle', paneId: r.paneId, title })
                  }}
                  glow={settings.attentionGlow}
                  onToast={(m) => dispatch({ type: 'toast', message: m })}
                />
              )
            })
          })}

          {dividers.map((d) => (
            <div
              key={d.id}
              className={'divider divider--' + d.orientation}
              style={{ left: d.x, top: d.y, width: d.width, height: d.height }}
              onMouseDown={(e) => startDrag(d, e)}
            >
              <div
                className="divider__line"
                style={
                  d.orientation === 'v'
                    ? { left: Math.floor(d.width / 2), top: 0, width: 1, height: '100%' }
                    : { top: Math.floor(d.height / 2), left: 0, height: 1, width: '100%' }
                }
              />
            </div>
          ))}

          {!activeTab && (
            <div className="empty">
              <div>No tabs open</div>
              <button
                className="btn"
                onClick={() =>
                  dispatch({ type: 'tab.new', cwd: home, home, autoColor: settings.autoColorPanes })
                }
              >
                New Tab (⌘T)
              </button>
            </div>
          )}

          {/* The shell drawer overlays the grid only — never the sidebar. One
              instance per pane that has opened it, all mounted so their
              sessions survive, and only the focused pane's is visible. */}
          {drawerPanes.map((id) => {
            const p = paneById(state, id)
            return (
              <DrawerShell
                key={id}
                paneId={id}
                paneLabel={p?.label ?? 'pane'}
                open={drawerOpen && id === drawerPaneId}
                height={drawerHeight}
                fontSize={fontSize}
                focusCwd={p?.metrics?.cwd || p?.cwd || home}
                gridWidth={gridSize.width}
                onReveal={(path, isDir) => revealPath(path, isDir)}
                onClose={() => setDrawerOpen(false)}
                onDragStart={startDrawerDrag}
              />
            )
          })}

          {state.toast && <div className="toast">{state.toast}</div>}
        </div>

      </div>

      <StatusBar
        tab={activeTab}
        system={state.system}
        lookoutCount={lookoutCount}
        onLookoutClick={() => setLookoutHidden((h) => !h)}
      />

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={updateSettings}
          onShowTutorial={() => {
            setSettingsOpen(false)
            setTutorialOpen(true)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {projectsOpen && (
        <ProjectsPanel
          projects={projects}
          tabCount={state.tabs.length}
          paneCount={state.tabs.reduce((n, t) => n + Object.keys(t.panes).length, 0)}
          defaultScope={projectsScope}
          activeTabName={activeTab?.name ?? ''}
          activeTabPaneCount={activeTab ? Object.keys(activeTab.panes).length : 0}
          currentProject={currentProject}
          onSave={(name, scope) => void saveProject(name, undefined, scope)}
          onSaveCurrent={() =>
            currentProject && void saveProject(currentProject.name, currentProject.id)
          }
          onOpen={(p) => void openProject(p)}
          onAdd={(p) => void addProject(p)}
          onDelete={(p) => void deleteProject(p)}
          onClose={() => setProjectsOpen(false)}
        />
      )}

      {tutorialOpen && <Tutorial onClose={() => setTutorialOpen(false)} />}
    </div>
  )
}

/**
 * Inline tab rename field.
 *
 * Its own component so the input is genuinely uncontrolled while editing. Held
 * in App state instead, every keystroke would re-render the whole window —
 * including every terminal pane — to type one character into the tab bar.
 *
 * Blur commits rather than cancels: clicking away from a rename you have
 * finished typing should keep it. Escape is the explicit discard.
 */
function TabNameInput(props: {
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
      className="tab__rename"
      defaultValue={props.initial}
      maxLength={MAX_TAB_NAME}
      spellCheck={false}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (cancelled.current) return
        props.onCommit(e.target.value)
      }}
      onKeyDown={(e) => {
        // Every key here is for the field. Without this, a rename containing
        // "d" or "w" would also reach the app's command handling.
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          props.onCommit(e.currentTarget.value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancelled.current = true
          props.onCancel()
        }
      }}
    />
  )
}
