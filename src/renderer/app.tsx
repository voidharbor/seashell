import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { computeLayout } from './layout/resize.js'
import { dfsPaneOrder } from './layout/tree.js'
import { MAX_PANES_PER_TAB, type RowNode } from './layout/types.js'
import { applyDividerDrag, deriveDividers, type DividerSpec } from './layout/dividers.js'
import { reducer, type AppState, type PaneCommand } from './store.js'
import { PaneView, forgetSpawn, terminals } from './panes/PaneView.js'
import { Explorer } from './explorer/Explorer.js'
import { StatusBar } from './status/StatusBar.js'
import { loadTerminalFont } from './term/terminal.js'
import { applyUiScale, clampIndex, levelAt, loadZoomIndex, saveZoomIndex } from './term/zoom.js'
import { Tutorial, hasSeenTutorial } from './tutorial/Tutorial.js'

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
  const [tutorialOpen, setTutorialOpen] = useState(() => !hasSeenTutorial())
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
      dispatch({ type: 'explorer.setRoot', root: paths.home })
      dispatch({ type: 'tab.new', cwd: paths.home, home: paths.home })
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

  const activeTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeTabId),
    [state.tabs, state.activeTabId]
  )

  const newPane = useCallback(
    (command: PaneCommand, commandText?: string) => {
      dispatch({ type: 'pane.new', home, command, ...(commandText ? { commandText } : {}) })
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

  /** Closes every preview pane in the active tab, leaving the terminals alone. */
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
          dispatch({ type: 'tab.new', cwd: home, home })
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
          dispatch({ type: 'pane.newWeb', url: '' })
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
        case 'ui.zoomIn':
          setZoomIndex((i) => clampIndex(i + 1))
          break
        case 'ui.zoomOut':
          setZoomIndex((i) => clampIndex(i - 1))
          break
        case 'ui.zoomReset':
          setZoomIndex(2)
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
          const id = activeTab?.focusedPaneId
          if (id) terminals.get(id)?.term.selectAll()
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
   * "Zoom in" has two physical spellings — ⌘= and ⌘+ (shifted) — and an
   * Electron menu item takes exactly one accelerator, so a menu binding leaves
   * whichever form the user actually presses dead. See the note in menu.ts.
   *
   * This is safe to do at the document level because xterm's key handler
   * returns false for every Cmd chord except Cmd+A without calling
   * preventDefault, so the event reaches here without ever reaching the PTY.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setZoomIndex((i) => clampIndex(i + 1))
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        setZoomIndex((i) => clampIndex(i - 1))
      } else if (e.key === '0') {
        e.preventDefault()
        setZoomIndex(2)
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

  const cell = useMemo(() => {
    // Measure from a terminal pane specifically — a preview pane has no cell
    // geometry, and the first pane in insertion order may well be one.
    const termId = activeTab
      ? Object.values(activeTab.panes).find((p) => p.kind === 'term')?.id
      : undefined
    const t = termId ? terminals.get(termId) : undefined
    const core = t
      ? (t.term as unknown as {
          _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } }
        })._core?._renderService?.dimensions?.css?.cell
      : undefined
    return core ? { cellW: core.width, cellH: core.height } : CELL_FALLBACK
  }, [activeTab, gridSize, zoomIndex])

  const rects = useMemo(() => {
    if (!activeTab || gridSize.width === 0) return []
    return computeLayout(activeTab.tree, gridSize, cell)
  }, [activeTab, gridSize, cell])

  const dividers = useMemo(() => {
    if (!activeTab || rects.length === 0 || activeTab.zoomedPaneId) return []
    return deriveDividers(activeTab.tree, rects, gridSize)
  }, [activeTab, rects, gridSize])

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

  return (
    <div className="app">
      <div className="tabbar">
        <div className="tabbar__tabs">
          {state.tabs.map((t) => (
            <div
              key={t.id}
              className={'tab' + (t.id === state.activeTabId ? ' tab--active' : '')}
              onMouseDown={() => dispatch({ type: 'tab.select', tabId: t.id })}
            >
              <span className="tab__name">{t.name}</span>
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
          onClick={() => dispatch({ type: 'tab.new', cwd: home, home })}
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
          title="New pane running claude"
          style={full ? { opacity: 0.4 } : undefined}
          onClick={() => !full && newPane('claude')}
        >
          ✻
        </div>
        <div
          className="tabbar__new"
          title="New web preview (⌘⇧U)"
          style={full ? { opacity: 0.4 } : undefined}
          onClick={() => !full && dispatch({ type: 'pane.newWeb', url: '' })}
        >
          ◍
        </div>
      </div>

      <div className="body">
        {state.sidebarVisible && state.explorerRoot && (
          <Explorer
            root={state.explorerRoot}
            home={home}
            revealPath={state.revealPath}
            refreshNonce={explorerNonce}
            onRevealHandled={() => dispatch({ type: 'explorer.reveal', path: null })}
            onOpenInViewer={(p) => dispatch({ type: 'pane.newFile', path: p })}
            onToast={(m) => dispatch({ type: 'toast', message: m })}
          />
        )}

        <div className="grid" ref={gridRef}>
          {activeTab &&
            rects.map((r) => {
              const pane = activeTab.panes[r.paneId]
              if (!pane) return null
              const zoomed = activeTab.zoomedPaneId
              const isZoomTarget = zoomed === r.paneId
              const rect = isZoomTarget
                ? { x: 0, y: 0, width: gridSize.width, height: gridSize.height }
                : r
              const isFocused = activeTab.focusedPaneId === r.paneId
              return (
                <PaneView
                  key={r.paneId}
                  pane={pane}
                  index={order.indexOf(r.paneId) + 1}
                  rect={rect}
                  focused={isFocused}
                  hidden={zoomed !== null && !isZoomTarget}
                  fontSize={fontSize}
                  findOpen={findOpen && isFocused}
                  findNonce={find.nonce}
                  findDirection={find.direction}
                  onCloseFind={() => setFindOpen(false)}
                  onFocus={() => dispatch({ type: 'pane.focus', paneId: r.paneId })}
                  onClose={() => void closePane(r.paneId)}
                  onZoom={() => dispatch({ type: 'pane.zoom', paneId: r.paneId })}
                  onReveal={(p) => dispatch({ type: 'explorer.reveal', path: p })}
                  onSpawned={(pid) => dispatch({ type: 'pane.spawned', paneId: r.paneId, pid })}
                  onRestart={() => dispatch({ type: 'pane.restarting', paneId: r.paneId })}
                  onUrlChange={(url) => dispatch({ type: 'pane.setUrl', paneId: r.paneId, url })}
                  onToggleRaw={(raw) =>
                    dispatch({ type: 'pane.setRawSource', paneId: r.paneId, raw })
                  }
                  onToast={(m) => dispatch({ type: 'toast', message: m })}
                />
              )
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
              <button className="btn" onClick={() => dispatch({ type: 'tab.new', cwd: home, home })}>
                New Tab (⌘T)
              </button>
            </div>
          )}

          {state.toast && <div className="toast">{state.toast}</div>}
        </div>
      </div>

      <StatusBar tab={activeTab} system={state.system} />

      {tutorialOpen && <Tutorial onClose={() => setTutorialOpen(false)} />}
    </div>
  )
}
