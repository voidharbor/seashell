import { describe, expect, it } from 'vitest'
import {
  paneToSaved,
  planRestore,
  saveLookupFrom,
  savedCommandFor,
  stateToTabs,
  tabToSaved,
} from '../../src/renderer/projects/serialize.js'
import { reducer } from '../../src/renderer/store.js'
import type { AppState, PaneState, TabState } from '../../src/renderer/store.js'
import type { PaneMetrics, ProjectsSessionIdsResponse } from '../../src/shared/ipc.js'

/**
 * What every save (named project, tab scope, periodic and quit snapshot) must
 * write for a claude pane. All of them go through stateToTabs / tabToSaved
 * with the lookup collectSessionIds hands back, so these pin that pipeline.
 *
 * The incident behind them: a build once re-saved a whole project
 * with every pane as bare zsh and every session id gone, because a sweep that
 * saw no claude was read as proof that no claude was there.
 */

const HOME = '/Users/joshwald'
const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'

function tick(paneId: string, foregroundProcess: string, procCount = foregroundProcess === 'zsh' ? 1 : 2): PaneMetrics {
  return { paneId, footprintBytes: 1, cpuFrac: 0, state: 'WAITING', foregroundProcess, procCount, cwd: '' }
}

function pane(id: string, extra: Partial<PaneState> = {}): PaneState {
  return {
    id,
    kind: 'term',
    cwd: HOME,
    label: id,
    labelIsCustom: false,
    command: 'zsh',
    pid: 100,
    status: 'live',
    ...extra,
  }
}

function tab(id: string, panes: PaneState[]): TabState {
  return {
    id,
    name: id,
    cwd: HOME,
    pristine: true,
    zoomedPaneId: null,
    focusedPaneId: panes[0]!.id,
    tree: {
      type: 'row',
      ratios: [1],
      children: [{ type: 'col', ratios: panes.map(() => 1 / panes.length), children: panes.map((p) => ({ type: 'pane', paneId: p.id })) }],
    },
    panes: Object.fromEntries(panes.map((p) => [p.id, p])),
  } as TabState
}

function state(tabs: TabState[]): AppState {
  return { tabs, activeTabId: tabs[0]!.id } as unknown as AppState
}

function response(
  ids: Record<string, string>,
  sources: Record<string, ProjectsSessionIdsResponse['sources'][string]>
): ProjectsSessionIdsResponse {
  return { ids, sources }
}

const termPanes = (s: AppState): PaneState[] =>
  s.tabs.flatMap((t) => Object.values(t.panes).filter((p) => p.kind === 'term'))

describe('(a) a claude pane with an id saves as claude with that id', () => {
  const s = state([tab('t1', [pane('p1', { claudeSessionId: A, metrics: tick('p1', 'claude') })])])
  const lookup = saveLookupFrom(termPanes(s), 1, response({ p1: A }, { p1: 'process' }))

  it('in project form', () => {
    const saved = tabToSaved(s.tabs[0]!, lookup?.ids, lookup?.running)
    expect(saved.panes['p1']).toMatchObject({ command: 'claude', claudeSessionId: A })
    expect(saved.sessionIdsVerified).toBe(true)
  })

  it('in snapshot form', () => {
    const tabs = stateToTabs(s, lookup?.ids, lookup?.running)
    expect(tabs[0]!.panes['p1']).toMatchObject({ command: 'claude', claudeSessionId: A })
  })

  it('a hand-typed claude proven only by the process lane is never written as zsh', () => {
    const bare = state([tab('t1', [pane('p1')])]) // no tick ever arrived
    const l = saveLookupFrom(termPanes(bare), 1, response({ p1: B }, { p1: 'process' }))
    expect(stateToTabs(bare, l?.ids, l?.running)[0]!.panes['p1']).toMatchObject({
      command: 'claude',
      claudeSessionId: B,
    })
  })

  it('a pane restored as claude saves as claude with its id before its first tick', () => {
    const restored = pane('p1', { command: 'claude', claudeSessionId: A, status: 'starting' })
    const l = saveLookupFrom([restored], 1, response({ p1: A }, { p1: 'carried' }))
    expect(paneToSaved(restored, l?.ids.get('p1'), l?.running.has('p1'))).toMatchObject({
      command: 'claude',
      claudeSessionId: A,
    })
  })

  it('round-trips: the saved pane plans a resume of the same session', () => {
    const tabs = stateToTabs(s, lookup?.ids, lookup?.running)
    let n = 0
    const plan = planRestore(tabs, (p) => `${p}-${++n}`)
    expect(plan.lookup).toEqual([
      expect.objectContaining({ knownSid: A, knownVerified: true, claude: true }),
    ])
  })
})

describe('(b) a sweep that sees no claude never downgrades a verified pane', () => {
  // A shell pane only carries an id because a proof put it there.
  const handTyped = pane('p1', { claudeSessionId: A, metrics: tick('p1', 'claude') })
  // A restored pane that has been seen running.
  const restoredSeen = pane('p2', { command: 'claude', claudeSessionId: B, claudeSeen: true, metrics: tick('p2', 'claude') })

  const unknownTicks: Array<[string, PaneMetrics | undefined]> = [
    ['no tick at all', undefined],
    ['sweep did not find the shell (reported as zsh, nothing counted)', tick('x', 'zsh', 0)],
    ['empty foreground', tick('x', '', 2)],
  ]

  for (const [what, m] of unknownTicks) {
    it(`keeps claude and the id: ${what}`, () => {
      for (const p of [handTyped, restoredSeen]) {
        const cur = { ...p, metrics: m ? { ...m, paneId: p.id } : undefined }
        expect(savedCommandFor(cur)).toBe('claude')
        // ps failed too, so main's process lane is empty; the carried lane answers.
        const l = saveLookupFrom([cur], 1, response({ [cur.id]: cur.claudeSessionId! }, { [cur.id]: 'carried' }))
        expect(paneToSaved(cur, l?.ids.get(cur.id), l?.running.has(cur.id))).toMatchObject({
          command: 'claude',
          claudeSessionId: cur.claudeSessionId,
        })
      }
    })
  }

  it('a tick that arrives without a foreground does not clear what the pane carries', () => {
    let s = state([tab('t1', [pane('p1', { claudeSessionId: A })])])
    s = reducer(s, { type: 'metrics', panes: [tick('p1', 'claude')], system: null })
    s = reducer(s, { type: 'metrics', panes: [tick('p1', 'zsh', 0)], system: null })
    const tabs = stateToTabs(s, undefined, undefined)
    expect(tabs[0]!.panes['p1']).toMatchObject({ command: 'claude', claudeSessionId: A })
  })

  it('the lookup throwing keeps every carried id (no verdict is not "no session")', () => {
    const s = state([tab('t1', [handTyped, restoredSeen])])
    const l = saveLookupFrom(termPanes(s), 2, null)
    expect(l).toBeUndefined()
    const tabs = stateToTabs(s, l?.ids, l?.running)
    expect(tabs[0]!.panes['p1']).toMatchObject({ command: 'claude', claudeSessionId: A })
    expect(tabs[0]!.panes['p2']).toMatchObject({ command: 'claude', claudeSessionId: B })
  })

  it('an empty answer while panes carried ids is a failed lookup, not a verdict', () => {
    const s = state([tab('t1', [handTyped, restoredSeen])])
    const l = saveLookupFrom(termPanes(s), 2, response({}, {}))
    expect(l).toBeUndefined()
    const saved = stateToTabs(s, l?.ids, l?.running)[0]!.panes
    expect(saved['p1']?.claudeSessionId).toBe(A)
    expect(saved['p2']?.claudeSessionId).toBe(B)
  })

  it('a pane past the request cap was never asked and keeps its id', () => {
    const s = state([tab('t1', [pane('p1', { claudeSessionId: A }), pane('p2', { claudeSessionId: B })])])
    const l = saveLookupFrom(termPanes(s), 1, response({ p1: A }, { p1: 'carried' }))
    expect(l?.ids.get('p2')).toBe(B)
    expect(stateToTabs(s, l?.ids, l?.running)[0]!.panes['p2']).toMatchObject({ command: 'claude', claudeSessionId: B })
  })

  it('a restored pane whose first tick is the shell (claude -r not started yet) stays claude', () => {
    let s = state([tab('t1', [pane('p1', { command: 'claude', claudeSessionId: A, status: 'starting' })])])
    s = reducer(s, { type: 'metrics', panes: [tick('p1', 'zsh')], system: null })
    expect(stateToTabs(s)[0]!.panes['p1']).toMatchObject({ command: 'claude', claudeSessionId: A })
  })

  it('an answer that lists no claude but did run is still followed for the id', () => {
    // main refused the carried id (another holder has it): the save drops the
    // id but does not invent a shell out of a pane it has no evidence about.
    const cur = pane('p2', { command: 'claude', claudeSessionId: B })
    const l = saveLookupFrom([cur, pane('p9', { claudeSessionId: C })], 2, response({ p9: C }, { p9: 'carried' }))
    const saved = paneToSaved(cur, l?.ids.get('p2'), l?.running.has('p2'))
    expect(saved.command).toBe('claude')
    expect(saved.claudeSessionId).toBeUndefined()
  })
})

describe('(c) a pane whose claude genuinely exited saves as zsh', () => {
  it('a hand-typed claude that exited back to the prompt', () => {
    let s = state([tab('t1', [pane('p1')])])
    s = reducer(s, { type: 'panes.sessionIds', ids: { p1: A } })
    s = reducer(s, { type: 'metrics', panes: [tick('p1', 'claude')], system: null })
    s = reducer(s, { type: 'metrics', panes: [tick('p1', 'zsh')], system: null })
    // main still carries the id (nothing else holds it), and that is fine:
    // it is not written for a pane that is not running claude.
    const l = saveLookupFrom(termPanes(s), 1, response({ p1: A }, { p1: 'carried' }))
    const saved = stateToTabs(s, l?.ids, l?.running)[0]!.panes['p1']!
    expect(saved.command).toBe('zsh')
    expect(saved.claudeSessionId).toBeUndefined()
  })

  it('a restored claude pane seen running, then back at its shell', () => {
    let s = state([tab('t1', [pane('p1', { command: 'claude', claudeSessionId: A, status: 'starting' })])])
    s = reducer(s, { type: 'metrics', panes: [tick('p1', 'claude')], system: null })
    expect(s.tabs[0]!.panes['p1']!.claudeSeen).toBe(true)
    s = reducer(s, { type: 'metrics', panes: [tick('p1', 'zsh')], system: null })
    const saved = stateToTabs(s, undefined, undefined)[0]!.panes['p1']!
    expect(saved).toMatchObject({ command: 'zsh' })
    expect(saved.claudeSessionId).toBeUndefined()
  })

  it('the process lane proving claude again outranks an old exit', () => {
    const p = pane('p1', { command: 'claude', claudeSessionId: A, claudeSeen: true, metrics: tick('p1', 'zsh') })
    const l = saveLookupFrom([p], 1, response({ p1: C }, { p1: 'process' }))
    expect(paneToSaved(p, l?.ids.get('p1'), l?.running.has('p1'))).toMatchObject({ command: 'claude', claudeSessionId: C })
  })

  it('a restart forgets that claude was seen, so the relaunch is not read as an exit', () => {
    let s = state([tab('t1', [pane('p1', { command: 'claude', claudeSessionId: A, claudeSeen: true })])])
    s = reducer(s, { type: 'pane.restarting', paneId: 'p1' })
    expect(s.tabs[0]!.panes['p1']!.claudeSeen).toBeUndefined()
    s = reducer(s, { type: 'metrics', panes: [tick('p1', 'zsh')], system: null })
    expect(stateToTabs(s)[0]!.panes['p1']).toMatchObject({ command: 'claude', claudeSessionId: A })
  })

  it('claudeSeen never reaches a saved file', () => {
    const saved = paneToSaved(pane('p1', { command: 'claude', claudeSessionId: A, claudeSeen: true }), A)
    expect('claudeSeen' in saved).toBe(false)
  })
})

describe('(d) a tab-scope save leaves the other tabs alone', () => {
  const t1 = tab('t1', [pane('p1', { command: 'claude', claudeSessionId: A }), pane('p2', { claudeSessionId: B })])
  const t2 = tab('t2', [pane('p3', { command: 'claude', claudeSessionId: C })])

  it('writes only the active tab, with its ids', () => {
    const s = state([t1, t2])
    const l = saveLookupFrom(termPanes(s), 3, response({ p1: A, p2: B, p3: C }, { p1: 'process', p2: 'carried', p3: 'carried' }))
    const saved = tabToSaved(s.tabs[0]!, l?.ids, l?.running)
    expect(Object.keys(saved.panes)).toEqual(['p1', 'p2'])
    expect(saved.panes['p1']).toMatchObject({ command: 'claude', claudeSessionId: A })
    expect(saved.panes['p2']).toMatchObject({ command: 'claude', claudeSessionId: B })
  })

  it('the proven-id writeback touches no pane in another tab, and a later snapshot keeps them', () => {
    const s0 = state([t1, t2])
    const s1 = reducer(s0, { type: 'panes.sessionIds', ids: { p1: A } })
    expect(s1.tabs[1]).toBe(s0.tabs[1])
    const s2 = reducer(s0, { type: 'panes.sessionIds', ids: { p1: B } })
    expect(s2.tabs[1]).toBe(s0.tabs[1])
    const snap = stateToTabs(s2, undefined, undefined)
    expect(snap[1]!.panes['p3']).toMatchObject({ command: 'claude', claudeSessionId: C })
  })
})
