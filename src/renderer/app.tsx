import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { computeLayout } from './layout/resize.js'
import { dfsPaneOrder } from './layout/tree.js'
import { MAX_PANES_PER_TAB, type RowNode } from './layout/types.js'
import { applyDividerDrag, deriveDividers, type DividerSpec } from './layout/dividers.js'
import { MAX_TAB_NAME, reducer, uid, type AppState, type PaneCommand } from './store.js'
import { PaneView, forgetSpawn, setHostname, terminals } from './panes/PaneView.js'
import { Explorer } from './explorer/Explorer.js'
import { StatusBar } from './status/StatusBar.js'
import { loadTerminalFont } from './term/terminal.js'
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
import { Tutorial, hasSeenTutorial } from './tutorial/Tutorial.js'
import { playAttentionPing, unlockAudio } from './panes/ping.js'
import { SettingsPanel } from './settings/SettingsPanel.js'
import { ProjectsPanel } from './projects/ProjectsPanel.js'
import { stateToTabs, tabsFromSaved } from './projects/serialize.js'
import type { LookoutActionRequest, LookoutCard, Project } from '../shared/ipc.js'
import { loadSettings, saveSettings, type Settings } from './settings/settings.js'
import { dirtyPreviewPanes } from './viewer/FilePreview.js'
import { extractQuestion } from './lookout/extract.js'
import { planDetections } from './lookout/detect.js'
import { readPaneTail } from './lookout/tail.js'
import { lookoutBadgeCount } from './lookout/badge.js'
import { CardStack } from './lookout/CardStack.js'

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
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [tutorialOpen, setTutorialOpen] = useState(() => !hasSeenTutorial())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [lookoutCards, setLookoutCards] = useState<LookoutCard[]>([])
  const [lookoutOpen, setLookoutOpen] = useState(false)
  const [lookoutPlugin, setLookoutPlugin] = useState(false)

  const updateSettings = useCallback((next: Settings) => {
    setSettings(next)
    saveSettings(next)
  }, [])

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

  const lookoutReported = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!settings.lookoutCards) {
      // Disabled means unwatched: drop the reported memory so re-enabling
      // re-arms every pane from scratch instead of trusting stale bookkeeping.
      lookoutReported.current = new Set()
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
    const plan = planDetections(panes, lookoutReported.current)
    lookoutReported.current = plan.nextReported
    for (const paneId of plan.toScan) {
      const lines = readPaneTail(paneId)
      if (!lines) continue
      const extraction = extractQuestion(lines)
      if (extraction) {
        window.seashell.lookout.detected({
          paneId,
          question: extraction.question,
          kind: extraction.kind,
        })
      }
    }
  }, [settings.lookoutCards, state.tabs, state.activeTabId])

  useEffect(() => {
    window.seashell.lookout.setEnabled(settings.lookoutCards)
  }, [settings.lookoutCards])

  // Live per-pane screen shape for the card stack's send-button gate — a
  // fresh xterm-buffer read on every call (render *and* click time), never a
  // cached value. See CardStack's doc comment for why click time re-reads.
  const lookoutScreenMode = useCallback((paneId: string): 'input' | 'selector' | null => {
    const lines = readPaneTail(paneId)
    return lines ? (extractQuestion(lines)?.kind ?? null) : null
  }, [])

  const lookoutGotoPane = useCallback(
    (paneId: string) => {
      const tab = state.tabs.find((t) => t.panes[paneId] !== undefined)
      if (!tab) return
      dispatch({ type: 'tab.select', tabId: tab.id })
      dispatch({ type: 'pane.focus', paneId })
    },
    [state.tabs]
  )

  const lookoutOnAction = useCallback((req: LookoutActionRequest) => {
    void window.seashell.lookout.action(req)
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
  const saveProject = useCallback(
    async (name: string, id?: string) => {
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
      const res = await window.seashell.projects.save({
        ...(id ? { id } : {}),
        name,
        tabs: stateToTabs(state, sessionIds),
      })
      if (!res.ok) {
        dispatch({ type: 'toast', message: `Could not save project (${res.code})` })
        return
      }
      setCurrentProject({ id: res.project.id, name: res.project.name })
      await refreshProjects()
      dispatch({ type: 'toast', message: `Saved project “${res.project.name}”` })
    },
    [state, refreshProjects]
  )

  /**
   * Opening a project replaces the window, so every pane currently open has to
   * be reaped first. Skipping that would leave the shells of the tabs being
   * replaced running with nothing on screen pointing at them — the exact
   * orphaned-process outcome this app exists to prevent, made worse by being
   * invisible.
   */
  const openProject = useCallback(
    async (project: Project) => {
      const restored = tabsFromSaved(project.tabs, uid)
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
    [state.tabs]
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

  // Menu accelerators arrive here regardless of DOM focus.
  useEffect(() => {
    const off = window.seashell.app.onCommand(({ command }) => {
      if (command.startsWith('tab.select.')) {
        dispatch({ type: 'tab.selectIndex', index: Number(command.split('.')[2]) })
        return
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
          const id = activeTab?.focusedPaneId
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
          const id = activeTab?.focusedPaneId
          const t = id ? terminals.get(id) : undefined
          const sel = t?.term.getSelection() ?? ''
          // No selection must be a no-op. Falling through to anything else here
          // is how a copy shortcut turns into an interrupt.
          if (sel) void navigator.clipboard.writeText(sel)
          break
        }
        case 'edit.paste': {
          const id = activeTab?.focusedPaneId
          if (!id) break
          void navigator.clipboard.readText().then((text) => {
            if (text) terminals.get(id)?.term.paste(text)
          })
          break
        }
        case 'edit.selectAll': {
          // Scoped to the line being typed, not the whole scrollback — see
          // inputline.ts. Selecting thousands of transcript lines is not what
          // anyone means by select-all in a pane running an agent.
          const id = activeTab?.focusedPaneId
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
  const lookoutCount = lookoutBadgeCount(lookoutCards)

  return (
    <div className="app">
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
        {state.sidebarVisible && state.explorerRoot && (
          <>
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
            <div
              className="sidebar__grip"
              title="Drag to resize · double-click to reset"
              onMouseDown={startSidebarDrag}
              onDoubleClick={() => {
                setSidebarWidth(SIDEBAR_DEFAULT)
                saveSidebarWidth(SIDEBAR_DEFAULT)
              }}
            />
          </>
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

          {state.toast && <div className="toast">{state.toast}</div>}
        </div>

        {/* Reserved space, not an overlay: the rail sits beside the panes so a
            card never covers terminal content. Hidden entirely via :empty when
            CardStack renders nothing — see .lookout-rail in styles.css. */}
        <aside className="lookout-rail">
          <CardStack
            cards={lookoutCards}
            suppressedPaneId={suppressedPaneId}
            pluginInstalled={lookoutPlugin}
            open={lookoutOpen}
            screenMode={lookoutScreenMode}
            onAction={lookoutOnAction}
            onGotoPane={lookoutGotoPane}
            onClose={() => setLookoutOpen(false)}
          />
        </aside>
      </div>

      <StatusBar
        tab={activeTab}
        system={state.system}
        lookoutCount={lookoutCount}
        onLookoutClick={() => setLookoutOpen((o) => !o)}
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
          currentProject={currentProject}
          onSave={(name) => void saveProject(name)}
          onSaveCurrent={() =>
            currentProject && void saveProject(currentProject.name, currentProject.id)
          }
          onOpen={(p) => void openProject(p)}
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
