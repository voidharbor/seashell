import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { computeLayout } from './layout/resize.js'
import { dfsPaneOrder } from './layout/tree.js'
import { MAX_PANES_PER_TAB, type RowNode } from './layout/types.js'
import { applyDividerDrag, deriveDividers, type DividerSpec } from './layout/dividers.js'
import { reducer, type AppState, type PaneCommand } from './store.js'
import { PaneView, forgetSpawn, terminals } from './panes/PaneView.js'
import { Explorer } from './explorer/Explorer.js'
import { StatusBar } from './status/StatusBar.js'
import { Viewer } from './viewer/Viewer.js'
import { loadTerminalFont } from './term/terminal.js'

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
    viewerPath: null,
    system: null,
    toast: null,
  }))

  const gridRef = useRef<HTMLDivElement | null>(null)
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 })

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
        case 'layout.rebalance':
          dispatch({ type: 'layout.rebalance' })
          break
        case 'explorer.toggle':
          dispatch({ type: 'explorer.toggle' })
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
  }, [activeTab, home, newPane])

  // Panes must be killed, not just forgotten — an orphaned agent process is
  // exactly the problem this app is meant to prevent.
  const closePane = useCallback(async (paneId: string) => {
    const res = await window.seashell.pty.kill({ paneId })
    forgetSpawn(paneId)
    if (!res.ok && res.survivors > 0) {
      dispatch({ type: 'toast', message: `${res.survivors} process(es) could not be reaped` })
    }
    dispatch({ type: 'pane.close', paneId })
  }, [])

  const closeTab = useCallback(
    async (tabId: string) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      if (tab) {
        await Promise.all(
          Object.keys(tab.panes).map((paneId) => window.seashell.pty.kill({ paneId }))
        )
      }
      dispatch({ type: 'tab.close', tabId })
    },
    [state.tabs]
  )

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
    const first = activeTab ? Object.keys(activeTab.panes)[0] : undefined
    const t = first ? terminals.get(first) : undefined
    const core = t
      ? (t.term as unknown as {
          _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } }
        })._core?._renderService?.dimensions?.css?.cell
      : undefined
    return core ? { cellW: core.width, cellH: core.height } : CELL_FALLBACK
  }, [activeTab, gridSize])

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
      }
      document.body.style.cursor = divider.orientation === 'v' ? 'col-resize' : 'row-resize'
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
      </div>

      <div className="body">
        {state.sidebarVisible && state.explorerRoot && (
          <Explorer
            root={state.explorerRoot}
            home={home}
            revealPath={state.revealPath}
            onRevealHandled={() => dispatch({ type: 'explorer.reveal', path: null })}
            onOpenInViewer={(p) => dispatch({ type: 'viewer.open', path: p })}
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
              return (
                <PaneView
                  key={r.paneId}
                  pane={pane}
                  index={order.indexOf(r.paneId) + 1}
                  rect={rect}
                  focused={activeTab.focusedPaneId === r.paneId}
                  hidden={zoomed !== null && !isZoomTarget}
                  onFocus={() => dispatch({ type: 'pane.focus', paneId: r.paneId })}
                  onClose={() => void closePane(r.paneId)}
                  onZoom={() => dispatch({ type: 'pane.zoom', paneId: r.paneId })}
                  onReveal={(p) => dispatch({ type: 'explorer.reveal', path: p })}
                  onSpawned={(pid) => dispatch({ type: 'pane.spawned', paneId: r.paneId, pid })}
                  onRestart={() => dispatch({ type: 'pane.restarting', paneId: r.paneId })}
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

          {state.viewerPath && (
            <Viewer path={state.viewerPath} onClose={() => dispatch({ type: 'viewer.close' })} />
          )}

          {state.toast && <div className="toast">{state.toast}</div>}
        </div>
      </div>

      <StatusBar tab={activeTab} system={state.system} />
    </div>
  )
}
