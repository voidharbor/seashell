import type { PaneMetrics, SystemMetrics } from '../shared/ipc.js'
import type { RowNode } from './layout/types.js'
import { createInitialTree } from './layout/tree.js'
import { insertPane, rebalance } from './layout/auto-arrange.js'
import { dfsPaneOrder, removePane } from './layout/tree.js'
import { MAX_PANES_PER_TAB } from './layout/types.js'

/** What a pane was launched as. Panes are always rooted at `/bin/zsh -l`; this
 *  records what the user asked for so a restart reproduces it. */
export type PaneCommand = 'zsh' | 'claude' | 'cmd'

export interface PaneState {
  id: string
  cwd: string
  label: string
  labelIsCustom: boolean
  command: PaneCommand
  /** The literal text typed into the shell for a 'cmd' pane. */
  commandText?: string
  pid: number | null
  status: 'starting' | 'live' | 'exited'
  exit?: { code: number; signal: number | null }
  metrics?: PaneMetrics
}

export interface TabState {
  id: string
  name: string
  cwd: string
  tree: RowNode
  /** False once the user drags a divider; stops auto-arrange from stomping it. */
  pristine: boolean
  zoomedPaneId: string | null
  focusedPaneId: string | null
  panes: Record<string, PaneState>
}

export interface AppState {
  tabs: TabState[]
  activeTabId: string
  sidebarVisible: boolean
  explorerRoot: string
  /** Path revealed by a double-click in a terminal — highlighted in the tree. */
  revealPath: string | null
  viewerPath: string | null
  system: SystemMetrics | null
  toast: string | null
}

let counter = 0
export function uid(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}-${Math.floor(performance.now())}`
}

export function baseLabel(cwd: string, home: string): string {
  if (cwd === home) return '~'
  if (cwd === '/') return '/'
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

export function makePane(cwd: string, home: string, command: PaneCommand, commandText?: string): PaneState {
  return {
    id: uid('pane'),
    cwd,
    label: baseLabel(cwd, home),
    labelIsCustom: false,
    command,
    ...(commandText === undefined ? {} : { commandText }),
    pid: null,
    status: 'starting',
  }
}

export function makeTab(cwd: string, home: string, command: PaneCommand = 'zsh'): TabState {
  const pane = makePane(cwd, home, command)
  return {
    id: uid('tab'),
    name: baseLabel(cwd, home),
    cwd,
    tree: createInitialTree(pane.id),
    pristine: true,
    zoomedPaneId: null,
    focusedPaneId: pane.id,
    panes: { [pane.id]: pane },
  }
}

export type Action =
  | { type: 'tab.new'; cwd: string; home: string }
  | { type: 'tab.close'; tabId: string }
  | { type: 'tab.select'; tabId: string }
  | { type: 'tab.selectIndex'; index: number }
  | { type: 'tab.cycle'; delta: number }
  | { type: 'pane.new'; home: string; command: PaneCommand; commandText?: string }
  | { type: 'pane.close'; paneId: string }
  | { type: 'pane.focus'; paneId: string }
  | { type: 'pane.cycle'; delta: number }
  | { type: 'pane.zoom'; paneId?: string }
  | { type: 'pane.spawned'; paneId: string; pid: number }
  | { type: 'pane.exited'; paneId: string; code: number; signal: number | null }
  | { type: 'pane.restarting'; paneId: string }
  | { type: 'pane.label'; paneId: string; label: string }
  | { type: 'pane.cwd'; paneId: string; cwd: string; home: string }
  | { type: 'layout.setTree'; tree: RowNode; pristine?: boolean }
  | { type: 'layout.rebalance' }
  | { type: 'explorer.toggle' }
  | { type: 'explorer.setRoot'; root: string }
  | { type: 'explorer.reveal'; path: string | null }
  | { type: 'viewer.open'; path: string }
  | { type: 'viewer.close' }
  | { type: 'metrics'; panes: PaneMetrics[]; system: SystemMetrics }
  | { type: 'toast'; message: string | null }

function activeTab(s: AppState): TabState | undefined {
  return s.tabs.find((t) => t.id === s.activeTabId)
}

function replaceTab(s: AppState, tabId: string, fn: (t: TabState) => TabState): AppState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === tabId ? fn(t) : t)) }
}

/**
 * Chooses focus after a pane closes: next sibling in DFS order, else previous,
 * else the tab's first pane. Leaving focus dangling would silently send
 * keystrokes nowhere.
 */
function focusAfterClose(tree: RowNode, closedId: string, order: string[]): string | null {
  const idx = order.indexOf(closedId)
  const remaining = dfsPaneOrder(tree)
  if (remaining.length === 0) return null
  if (idx >= 0 && idx < remaining.length) return remaining[idx] ?? null
  return remaining[remaining.length - 1] ?? null
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'tab.new': {
      const tab = makeTab(action.cwd, action.home)
      return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id }
    }

    case 'tab.close': {
      const remaining = state.tabs.filter((t) => t.id !== action.tabId)
      if (remaining.length === state.tabs.length) return state
      const active =
        state.activeTabId === action.tabId
          ? (remaining[0]?.id ?? '')
          : state.activeTabId
      return { ...state, tabs: remaining, activeTabId: active }
    }

    case 'tab.select':
      return { ...state, activeTabId: action.tabId }

    case 'tab.selectIndex': {
      const t = state.tabs[action.index]
      return t ? { ...state, activeTabId: t.id } : state
    }

    case 'tab.cycle': {
      if (state.tabs.length < 2) return state
      const i = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const next = (i + action.delta + state.tabs.length) % state.tabs.length
      return { ...state, activeTabId: state.tabs[next]?.id ?? state.activeTabId }
    }

    case 'pane.new': {
      const tab = activeTab(state)
      if (!tab) return state
      if (Object.keys(tab.panes).length >= MAX_PANES_PER_TAB) {
        return { ...state, toast: `Tab is full (${MAX_PANES_PER_TAB} panes) — open a new tab (⌘T)` }
      }
      const pane = makePane(tab.cwd, action.home, action.command, action.commandText)
      return replaceTab(state, tab.id, (t) => ({
        ...t,
        tree: insertPane(t.tree, pane.id, t.pristine),
        panes: { ...t.panes, [pane.id]: pane },
        focusedPaneId: pane.id,
        zoomedPaneId: null,
      }))
    }

    case 'pane.close': {
      const tab = activeTab(state)
      if (!tab || !tab.panes[action.paneId]) return state
      const order = dfsPaneOrder(tab.tree)
      const rest = { ...tab.panes }
      delete rest[action.paneId]

      if (Object.keys(rest).length === 0) {
        return reducer(state, { type: 'tab.close', tabId: tab.id })
      }

      let tree = removePane(tab.tree, action.paneId)
      if (tab.pristine) {
        // A pristine tab re-runs the canonical arranger so closes stay tidy.
        tree = rebalance(tree)
      }
      return replaceTab(state, tab.id, (t) => ({
        ...t,
        tree,
        panes: rest,
        focusedPaneId: focusAfterClose(tree, action.paneId, order),
        zoomedPaneId: t.zoomedPaneId === action.paneId ? null : t.zoomedPaneId,
      }))
    }

    case 'pane.focus': {
      const tab = activeTab(state)
      if (!tab) return state
      return replaceTab(state, tab.id, (t) => ({ ...t, focusedPaneId: action.paneId }))
    }

    case 'pane.cycle': {
      const tab = activeTab(state)
      if (!tab) return state
      const order = dfsPaneOrder(tab.tree)
      if (order.length < 2) return state
      const i = order.indexOf(tab.focusedPaneId ?? '')
      const next = (i + action.delta + order.length) % order.length
      return replaceTab(state, tab.id, (t) => ({ ...t, focusedPaneId: order[next] ?? t.focusedPaneId }))
    }

    case 'pane.zoom': {
      const tab = activeTab(state)
      if (!tab) return state
      const target = action.paneId ?? tab.focusedPaneId
      if (!target) return state
      return replaceTab(state, tab.id, (t) => ({
        ...t,
        zoomedPaneId: t.zoomedPaneId === target ? null : target,
      }))
    }

    case 'pane.spawned':
      return mapPane(state, action.paneId, (p) => ({ ...p, pid: action.pid, status: 'live' }))

    case 'pane.exited':
      return mapPane(state, action.paneId, (p) => ({
        ...p,
        status: 'exited',
        exit: { code: action.code, signal: action.signal },
      }))

    case 'pane.restarting':
      return mapPane(state, action.paneId, (p) => {
        const { exit: _drop, ...rest } = p
        return { ...rest, status: 'starting', pid: null }
      })

    case 'pane.label':
      return mapPane(state, action.paneId, (p) => ({
        ...p,
        label: action.label,
        labelIsCustom: true,
      }))

    case 'pane.cwd':
      return mapPane(state, action.paneId, (p) => ({
        ...p,
        cwd: action.cwd,
        label: p.labelIsCustom ? p.label : baseLabel(action.cwd, action.home),
      }))

    case 'layout.setTree': {
      const tab = activeTab(state)
      if (!tab) return state
      return replaceTab(state, tab.id, (t) => ({
        ...t,
        tree: action.tree,
        pristine: action.pristine ?? false,
      }))
    }

    case 'layout.rebalance': {
      const tab = activeTab(state)
      if (!tab) return state
      return replaceTab(state, tab.id, (t) => ({ ...t, tree: rebalance(t.tree), pristine: true }))
    }

    case 'explorer.toggle':
      return { ...state, sidebarVisible: !state.sidebarVisible }

    case 'explorer.setRoot':
      return { ...state, explorerRoot: action.root }

    case 'explorer.reveal':
      return { ...state, revealPath: action.path, sidebarVisible: true }

    case 'viewer.open':
      return { ...state, viewerPath: action.path }

    case 'viewer.close':
      return { ...state, viewerPath: null }

    case 'metrics': {
      const byId = new Map(action.panes.map((m) => [m.paneId, m]))
      return {
        ...state,
        system: action.system,
        tabs: state.tabs.map((t) => ({
          ...t,
          panes: Object.fromEntries(
            Object.entries(t.panes).map(([id, p]) => {
              const m = byId.get(id)
              return [id, m ? { ...p, metrics: m } : p]
            })
          ),
        })),
      }
    }

    case 'toast':
      return { ...state, toast: action.message }

    default:
      return state
  }
}

function mapPane(state: AppState, paneId: string, fn: (p: PaneState) => PaneState): AppState {
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.panes[paneId] ? { ...t, panes: { ...t.panes, [paneId]: fn(t.panes[paneId]) } } : t
    ),
  }
}
