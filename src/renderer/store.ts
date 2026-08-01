import type { PaneMetrics, SystemMetrics } from '../shared/ipc.js'
import type { PaneColorKey } from './panes/colors.js'
import { cleanPaneTitle } from './panes/paneTitle.js'
import { doneExpired, nextAttention, type Attention } from './panes/attention.js'
import { FIRST_PANE_COLOR, nextAutoColor } from './panes/colors.js'
import type { RowNode } from './layout/types.js'
import { createInitialTree } from './layout/tree.js'
import { insertPane, rebalance } from './layout/auto-arrange.js'
import { dfsPaneOrder, removePane } from './layout/tree.js'
import { MAX_PANES_PER_TAB } from './layout/types.js'
import { clampIndex } from './term/zoom.js'

/** What a pane was launched as. Panes are always rooted at `/bin/zsh -l`; this
 *  records what the user asked for so a restart reproduces it. */
export type PaneCommand = 'zsh' | 'claude' | 'cmd'

/**
 * What a pane contains.
 *
 * Preview panes are real leaves in the layout tree, not overlays. That is the
 * whole point: an overlay has to invent its own sizing, its own close affordance
 * and its own stacking rules, and it cannot be tiled next to the terminal that
 * produced it. As tree leaves they inherit dividers, zoom, focus cycling,
 * auto-arrange and close for free, and "resize the preview" is just "drag the
 * divider" — the same gesture as everywhere else.
 *
 * - `term` a PTY-backed terminal
 * - `file` a read-only file preview (highlighted source, rendered markdown, image)
 * - `web`  a live URL, for watching a dev server next to the pane running it
 */
export type PaneKind = 'term' | 'file' | 'web'

export interface PaneState {
  id: string
  kind: PaneKind
  cwd: string
  label: string
  labelIsCustom: boolean
  command: PaneCommand
  /** The literal text typed into the shell for a 'cmd' pane. */
  commandText?: string
  /** kind 'file' — absolute path being previewed. */
  filePath?: string
  /** kind 'file' — render the source rather than the rich form (markdown/image). */
  rawSource?: boolean
  /** kind 'web' — the URL currently loaded. Empty until the user enters one. */
  url?: string
  /** Colour tag key from the pane palette. Undefined means untagged. */
  color?: PaneColorKey
  /**
   * Zoom rung for this pane's text alone, absolute rather than an offset.
   * Undefined means "follow the global level"; a global zoom clears it back to
   * undefined on every pane, which is what makes Reset mean all-panes-to-100%.
   */
  zoomIndex?: number
  pid: number | null
  status: 'starting' | 'live' | 'exited'
  exit?: { code: number; signal: number | null }
  metrics?: PaneMetrics
  /** Set when the pane wants attention: idle-waiting, or just finished. */
  attention?: Attention
  /** When `attention` became 'done', so the pulse can stop asking. */
  attentionAt?: number
  /**
   * When this pane's current unbroken run of stillness began. Undefined the
   * moment it does anything. Stillness only counts as a request for attention
   * once it has lasted; see attention.ts.
   */
  waitingSince?: number
  /**
   * Incremented on every restart. A restarted pane deliberately keeps its id —
   * so it holds its position, label and place in the layout tree — which means
   * the id alone cannot tell "restart this pane" apart from "this pane already
   * spawned". The generation is what distinguishes them.
   */
  generation?: number
}

/** Only terminal panes own a process, so only they can be spawned or reaped. */
export function isTerm(p: PaneState): boolean {
  return p.kind === 'term'
}

export interface TabState {
  id: string
  name: string
  /** Set once the user renames the tab by hand. Guards the name against being
   *  overwritten by anything that derives a label from the tab's cwd. */
  nameIsCustom?: boolean
  cwd: string
  tree: RowNode
  /** False once the user drags a divider; stops auto-arrange from stomping it. */
  pristine: boolean
  zoomedPaneId: string | null
  focusedPaneId: string | null
  panes: Record<string, PaneState>
}

/**
 * A path to reveal, and whether it is a directory.
 *
 * The kind travels with the path because the explorer cannot work it out for
 * itself — it has no stat, only what it was handed. `statBatch` has always
 * returned it and the renderer used to drop it one layer too early, which is
 * why revealing a folder selected the row but never opened it.
 */
export interface RevealTarget {
  path: string
  isDir: boolean
}

export interface AppState {
  tabs: TabState[]
  activeTabId: string
  sidebarVisible: boolean
  explorerRoot: string
  /** Path revealed by a double-click in a terminal — highlighted in the tree. */
  revealPath: RevealTarget | null
  system: SystemMetrics | null
  toast: string | null
}

/** Long enough for a real name, short enough that one tab cannot push every
 *  other tab off the bar. */
export const MAX_TAB_NAME = 40

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
    kind: 'term',
    cwd,
    label: baseLabel(cwd, home),
    labelIsCustom: false,
    command,
    ...(commandText === undefined ? {} : { commandText }),
    pid: null,
    status: 'starting',
  }
}

export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * A preview pane is `live` from birth. There is no process to wait on, and
 * leaving it `starting` would make the pane render an exit/restart affordance
 * that has nothing to restart.
 */
export function makeFilePane(path: string, cwd: string): PaneState {
  return {
    id: uid('pane'),
    kind: 'file',
    cwd,
    label: basename(path),
    labelIsCustom: false,
    command: 'zsh',
    filePath: path,
    pid: null,
    status: 'live',
  }
}

export function makeWebPane(url: string, cwd: string): PaneState {
  return {
    id: uid('pane'),
    kind: 'web',
    cwd,
    label: url ? hostLabel(url) : 'Web',
    labelIsCustom: false,
    command: 'zsh',
    url,
    pid: null,
    status: 'live',
  }
}

/** Tab-bar-sized label for a URL: host plus port, which is what distinguishes
 *  two dev servers from each other. A full URL would never fit. */
export function hostLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return url.slice(0, 24) || 'Web'
  }
}

export function makeTab(
  cwd: string,
  home: string,
  command: PaneCommand = 'zsh',
  autoColor = false
): TabState {
  const base = makePane(cwd, home, command)
  // A tab's first pane is created here, not through the pane.new path, so the
  // first-pane colour has to be applied at birth rather than by withAutoColor.
  const pane = autoColor ? { ...base, color: FIRST_PANE_COLOR } : base
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
  | { type: 'tab.new'; cwd: string; home: string; autoColor?: boolean }
  | { type: 'tab.close'; tabId: string }
  | { type: 'tab.select'; tabId: string }
  | { type: 'tab.selectIndex'; index: number }
  | { type: 'tab.cycle'; delta: number }
  | { type: 'tab.rename'; tabId: string; name: string; home: string }
  | { type: 'tabs.replace'; tabs: TabState[] }
  | { type: 'pane.new'; home: string; command: PaneCommand; commandText?: string; autoColor?: boolean }
  | { type: 'pane.newFile'; path: string; autoColor?: boolean }
  | { type: 'pane.newWeb'; url: string; autoColor?: boolean }
  | { type: 'pane.setUrl'; paneId: string; url: string }
  | { type: 'pane.setRawSource'; paneId: string; raw: boolean }
  | { type: 'pane.setColor'; paneId: string; color: PaneColorKey | null }
  | { type: 'pane.close'; paneId: string }
  | { type: 'pane.focus'; paneId: string }
  | { type: 'pane.cycle'; delta: number }
  | { type: 'pane.zoom'; paneId?: string }
  | { type: 'pane.zoomText'; delta: number; base: number; paneId?: string }
  | { type: 'pane.clearTextZoom' }
  | { type: 'pane.spawned'; paneId: string; pid: number }
  | { type: 'pane.exited'; paneId: string; code: number; signal: number | null }
  | { type: 'pane.restarting'; paneId: string }
  | { type: 'pane.label'; paneId: string; label: string }
  | { type: 'pane.autoTitle'; paneId: string; title: string }
  | { type: 'pane.cwd'; paneId: string; cwd: string; home: string }
  | { type: 'layout.setTree'; tree: RowNode; pristine?: boolean }
  | { type: 'layout.rebalance' }
  | { type: 'explorer.toggle' }
  | { type: 'explorer.setRoot'; root: string }
  | { type: 'explorer.reveal'; path: string | null; isDir?: boolean }
  | { type: 'metrics'; panes: PaneMetrics[]; system: SystemMetrics }
  | { type: 'toast'; message: string | null }

/**
 * Applies the automatic colour tag, if the setting is on.
 *
 * The tab's *existing* panes decide the choice, so a new pane avoids colours
 * already on screen. A tab's first pane has no existing panes to avoid and gets
 * the fixed first-pane colour, so every tab starts from the same place instead
 * of the default pane being the one odd untagged one.
 */
function withAutoColor(pane: PaneState, tab: TabState, enabled: boolean | undefined): PaneState {
  if (!enabled) return pane
  return { ...pane, color: nextAutoColor(Object.values(tab.panes).map((p) => p.color)) }
}

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
      const tab = makeTab(action.cwd, action.home, 'zsh', action.autoColor)
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

    /**
     * Opening a project replaces the whole window, not just adds to it — that is
     * what "open this project" means everywhere else. The caller is responsible
     * for reaping the panes being replaced; the reducer cannot, because killing
     * a process is asynchronous and a reducer must stay pure.
     */
    case 'tabs.replace': {
      if (action.tabs.length === 0) return state
      return { ...state, tabs: action.tabs, activeTabId: action.tabs[0]!.id }
    }

    case 'tab.select':
      return { ...state, activeTabId: action.tabId }

    /**
     * Renaming to blank reverts to the derived name rather than leaving a
     * nameless tab. An empty tab is unclickable in any practical sense — there
     * is nothing to aim at but the close button.
     */
    case 'tab.rename': {
      const name = action.name.trim().slice(0, MAX_TAB_NAME)
      return replaceTab(state, action.tabId, (t) =>
        name === ''
          ? { ...t, name: baseLabel(t.cwd, action.home), nameIsCustom: false }
          : { ...t, name, nameIsCustom: true }
      )
    }

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
      const pane = withAutoColor(
        makePane(tab.cwd, action.home, action.command, action.commandText),
        tab,
        action.autoColor
      )
      return replaceTab(state, tab.id, (t) => ({
        ...t,
        tree: insertPane(t.tree, pane.id, t.pristine),
        panes: { ...t.panes, [pane.id]: pane },
        focusedPaneId: pane.id,
        zoomedPaneId: null,
      }))
    }

    /**
     * Opening a file retargets an existing file preview instead of adding
     * another one. Six panes is the hard cap, and a tab that fills with preview
     * panes because the user clicked four files in the explorer is a worse
     * outcome than reusing the surface they are already looking at.
     */
    case 'pane.newFile': {
      const tab = activeTab(state)
      if (!tab) return state

      const existing = Object.values(tab.panes).find((p) => p.kind === 'file')
      if (existing) {
        return replaceTab(state, tab.id, (t) => ({
          ...t,
          focusedPaneId: existing.id,
          zoomedPaneId: null,
          panes: {
            ...t.panes,
            [existing.id]: {
              ...existing,
              filePath: action.path,
              rawSource: false,
              label: existing.labelIsCustom ? existing.label : basename(action.path),
            },
          },
        }))
      }

      if (Object.keys(tab.panes).length >= MAX_PANES_PER_TAB) {
        return { ...state, toast: `Tab is full (${MAX_PANES_PER_TAB} panes) — open a new tab (⌘T)` }
      }
      const pane = withAutoColor(makeFilePane(action.path, tab.cwd), tab, action.autoColor)
      return replaceTab(state, tab.id, (t) => ({
        ...t,
        tree: insertPane(t.tree, pane.id, t.pristine),
        panes: { ...t.panes, [pane.id]: pane },
        focusedPaneId: pane.id,
        zoomedPaneId: null,
      }))
    }

    case 'pane.newWeb': {
      const tab = activeTab(state)
      if (!tab) return state
      if (Object.keys(tab.panes).length >= MAX_PANES_PER_TAB) {
        return { ...state, toast: `Tab is full (${MAX_PANES_PER_TAB} panes) — open a new tab (⌘T)` }
      }
      const pane = withAutoColor(makeWebPane(action.url, tab.cwd), tab, action.autoColor)
      return replaceTab(state, tab.id, (t) => ({
        ...t,
        tree: insertPane(t.tree, pane.id, t.pristine),
        panes: { ...t.panes, [pane.id]: pane },
        focusedPaneId: pane.id,
        zoomedPaneId: null,
      }))
    }

    case 'pane.setUrl':
      return mapPane(state, action.paneId, (p) => ({
        ...p,
        url: action.url,
        label: p.labelIsCustom ? p.label : hostLabel(action.url),
      }))

    case 'pane.setRawSource':
      return mapPane(state, action.paneId, (p) => ({ ...p, rawSource: action.raw }))

    case 'pane.setColor':
      return mapPane(state, action.paneId, (p) => {
        // Clearing removes the key entirely rather than storing a sentinel, so
        // "untagged" has exactly one representation.
        if (action.color === null) {
          const { color: _cleared, ...rest } = p
          return rest
        }
        return { ...p, color: action.color }
      })

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
      // Focusing a pane acknowledges whatever it was trying to tell you.
      return replaceTab(state, tab.id, (t) => {
        const pane = t.panes[action.paneId]
        return {
          ...t,
          focusedPaneId: action.paneId,
          panes: pane
            ? {
                ...t.panes,
                [action.paneId]: { ...pane, attention: undefined, attentionAt: undefined },
              }
            : t.panes,
        }
      })
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

    /**
     * Text zoom for one pane. `base` is the current global rung, used when the
     * pane is still following it — so the first ⌘⇧+ steps up from what you can
     * actually see, not from the ladder default.
     */
    case 'pane.zoomText': {
      const tab = activeTab(state)
      if (!tab) return state
      const target = action.paneId ?? tab.focusedPaneId
      if (!target) return state
      return mapPane(state, target, (p) => ({
        ...p,
        zoomIndex: clampIndex((p.zoomIndex ?? action.base) + action.delta),
      }))
    }

    /** Global zoom owns every pane: clearing the overrides is what Reset means. */
    case 'pane.clearTextZoom':
      return {
        ...state,
        tabs: state.tabs.map((t) => ({
          ...t,
          panes: Object.fromEntries(
            Object.entries(t.panes).map(([id, p]) => [id, { ...p, zoomIndex: undefined }])
          ),
        })),
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
        return {
          ...rest,
          status: 'starting',
          pid: null,
          generation: (p.generation ?? 0) + 1,
        }
      })

    case 'pane.label':
      return mapPane(state, action.paneId, (p) => ({
        ...p,
        label: action.label,
        labelIsCustom: true,
      }))

    /**
     * A title announced by the running program. Never overrides a name the user
     * typed themselves, and a title that cleans down to nothing leaves the
     * existing label alone rather than blanking the pane — programs routinely
     * clear the title on exit.
     */
    case 'pane.autoTitle': {
      const title = cleanPaneTitle(action.title)
      if (title === null) return state
      return mapPane(state, action.paneId, (p) =>
        p.labelIsCustom ? p : { ...p, label: title }
      )
    }

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
      return {
        ...state,
        revealPath:
          action.path === null ? null : { path: action.path, isDir: action.isDir ?? false },
        sidebarVisible: true,
      }

    /**
     * Metrics arrive every few seconds forever, so this is the one reducer case
     * whose *identity* behaviour matters as much as its result. It used to
     * rebuild every tab and every pane object unconditionally, which changed
     * `activeTab`'s identity on every tick and made the whole window recompute
     * its layout for numbers that often had not moved. Panes, tabs and the tabs
     * array are now each returned unchanged when nothing about them changed.
     */
    case 'metrics': {
      const byId = new Map(action.panes.map((m) => [m.paneId, m]))
      const now = Date.now()

      let tabsChanged = false
      const tabs = state.tabs.map((t) => {
        let panesChanged = false
        const panes: Record<string, PaneState> = {}

        for (const [id, p] of Object.entries(t.panes)) {
          const m = byId.get(id)
          if (!m) {
            panes[id] = p
            continue
          }

          const focused = t.id === state.activeTabId && t.focusedPaneId === id
          const outcome = nextAttention({
            previous: p.metrics?.state,
            next: m.state,
            current: p.attention ?? null,
            focused,
            waitingSince: p.waitingSince,
            now,
          })

          let attention = outcome.attention
          // A finished pulse stops asking after a while; a waiting one does
          // not, because the pane is still waiting.
          if (attention === 'done' && p.attention === 'done' && doneExpired(p.attentionAt, now)) {
            attention = null
          }

          const changed = attention !== (p.attention ?? null)
          const attentionAt =
            attention === 'done' && changed ? now : attention === null ? undefined : p.attentionAt

          if (
            !changed &&
            attentionAt === p.attentionAt &&
            outcome.waitingSince === p.waitingSince &&
            sameMetrics(p.metrics, m)
          ) {
            panes[id] = p
            continue
          }

          panesChanged = true
          panes[id] = {
            ...p,
            metrics: m,
            ...(attention === null ? { attention: undefined } : { attention }),
            attentionAt,
            waitingSince: outcome.waitingSince,
          }
        }

        if (!panesChanged) return t
        tabsChanged = true
        return { ...t, panes }
      })

      // `system` genuinely changes every tick, so the root object always does.
      // The tabs array is what the layout memos hang off, and it must not.
      return { ...state, system: action.system, tabs: tabsChanged ? tabs : state.tabs }
    }

    case 'toast':
      return { ...state, toast: action.message }

    default:
      return state
  }
}

/**
 * Whether a fresh sample says anything new. Every field is a primitive, so a
 * field-by-field compare is both exact and cheaper than the re-render it saves.
 */
function sameMetrics(a: PaneMetrics | undefined, b: PaneMetrics): boolean {
  return (
    a !== undefined &&
    a.footprintBytes === b.footprintBytes &&
    a.cpuFrac === b.cpuFrac &&
    a.state === b.state &&
    a.foregroundProcess === b.foregroundProcess &&
    a.procCount === b.procCount &&
    a.cwd === b.cwd
  )
}

function mapPane(state: AppState, paneId: string, fn: (p: PaneState) => PaneState): AppState {
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.panes[paneId] ? { ...t, panes: { ...t.panes, [paneId]: fn(t.panes[paneId]) } } : t
    ),
  }
}
