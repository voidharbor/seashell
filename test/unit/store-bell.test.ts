import { describe, expect, it } from 'vitest'
import { reducer } from '../../src/renderer/store.js'
import type { AppState, PaneState, TabState } from '../../src/renderer/store.js'

/** Same fixture shape test/unit/link.test.ts uses: one tab, panes as given,
 *  the first pane focused. */
const pane = (id: string, over: Partial<PaneState> = {}): PaneState =>
  ({ id, kind: 'term', cwd: '/h', label: id, labelIsCustom: false, command: 'claude', pid: 1, status: 'live', ...over }) as PaneState

const state = (panes: PaneState[]): AppState =>
  ({
    tabs: [
      {
        id: 't1',
        name: 't',
        cwd: '/h',
        pristine: true,
        zoomedPaneId: null,
        focusedPaneId: panes[0]!.id,
        panes: Object.fromEntries(panes.map((p) => [p.id, p])),
        tree: {
          type: 'row',
          ratios: [1],
          children: [{ type: 'col', ratios: panes.map(() => 1 / panes.length), children: panes.map((p) => ({ type: 'pane', paneId: p.id })) }],
        },
      } as unknown as TabState,
    ],
    activeTabId: 't1',
    sidebarVisible: true,
    explorerRoot: '/h',
    revealPath: null,
    system: null,
    toast: null,
  }) as AppState

const twoPanes = (): AppState => state([pane('p1'), pane('p2')])
const paneIds = (s: AppState): string[] => Object.keys(s.tabs[0]!.panes)
const withMetrics = (s: AppState, id: string, state: 'PROMPT' | 'BUSY' | 'WAITING'): AppState =>
  reducer(s, {
    type: 'metrics',
    system: s.system as never,
    panes: [{ paneId: id, footprintBytes: 0, cpuFrac: 0, state, foregroundProcess: 'claude', procCount: 2, cwd: '/h' }],
  })

describe('pane.bell', () => {
  it('sets waiting on an unfocused pane whose program is not the shell', () => {
    let s = twoPanes()
    const [p1, p2] = paneIds(s)
    s = withMetrics(s, p2!, 'WAITING')
    s = reducer(s, { type: 'pane.bell', paneId: p2!, at: 5000 })
    expect(s.tabs[0]!.panes[p2!]!.attention).toBe('waiting')
    expect(s.tabs[0]!.panes[p2!]!.attentionAt).toBe(5000)
    expect(s.tabs[0]!.focusedPaneId).toBe(p1)
  })
  it('ignores a bell on the focused pane', () => {
    let s = twoPanes()
    const [p1] = paneIds(s)
    s = withMetrics(s, p1!, 'WAITING')
    s = reducer(s, { type: 'pane.bell', paneId: p1!, at: 5000 })
    expect(s.tabs[0]!.panes[p1!]!.attention).toBeUndefined()
  })
  it('ignores a bell from a bare shell prompt or before any metrics', () => {
    let s = twoPanes()
    const [, p2] = paneIds(s)
    s = reducer(s, { type: 'pane.bell', paneId: p2!, at: 1 })
    expect(s.tabs[0]!.panes[p2!]!.attention).toBeUndefined()
    s = withMetrics(s, p2!, 'PROMPT')
    s = reducer(s, { type: 'pane.bell', paneId: p2!, at: 2 })
    expect(s.tabs[0]!.panes[p2!]!.attention).toBeUndefined()
  })
  it('a later still tick keeps it, a busy tick clears it', () => {
    let s = twoPanes()
    const [, p2] = paneIds(s)
    s = withMetrics(s, p2!, 'WAITING')
    s = reducer(s, { type: 'pane.bell', paneId: p2!, at: 5000 })
    s = withMetrics(s, p2!, 'WAITING')
    expect(s.tabs[0]!.panes[p2!]!.attention).toBe('waiting')
    s = withMetrics(s, p2!, 'BUSY')
    expect(s.tabs[0]!.panes[p2!]!.attention).toBeUndefined()
  })
})
