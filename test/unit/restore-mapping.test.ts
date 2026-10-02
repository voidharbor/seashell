import { describe, expect, it } from 'vitest'
import {
  applyLaunchModes,
  applyRestoreIds,
  claudeLaunchMode,
  launchCommandText,
  paneToSaved,
  planRestore,
  tabToSaved,
} from '../../src/renderer/projects/serialize.js'
import { reducer } from '../../src/renderer/store.js'
import type { AppState, PaneState, TabState } from '../../src/renderer/store.js'
import type { SavedPane, SavedTab } from '../../src/shared/ipc.js'

const HOME = '/Users/joshwald'
const ABDA = 'abda0000-0000-4000-8000-000000000001'
const AD7E = 'ad7e8d42-0000-4000-8000-000000000000'
const E565 = 'e5650000-0000-4000-8000-000000000002'

function saved(label: string, extra: Partial<SavedPane> = {}): SavedPane {
  return { label, labelIsCustom: false, kind: 'term', command: 'claude', cwd: HOME, ...extra }
}

function savedTab(id: string, panes: Record<string, SavedPane>, extra: Partial<SavedTab> = {}): SavedTab {
  return {
    id,
    name: id,
    nameIsCustom: true,
    cwd: HOME,
    zoomedPaneId: null,
    focusedPaneId: null,
    tree: {
      type: 'row',
      ratios: [1],
      children: [
        {
          type: 'col',
          ratios: Object.keys(panes).map(() => 1 / Object.keys(panes).length),
          children: Object.keys(panes).map((paneId) => ({ type: 'pane', paneId })),
        },
      ],
    },
    panes,
    ...extra,
  }
}

let n = 0
const mint = (prefix: string): string => `${prefix}-${++n}`

describe('planRestore', () => {
  it('asks about every claude pane, carrying its saved id and whether that id was verified', () => {
    const plan = planRestore(
      [
        savedTab('old', { a: saved('✳ Session alpha', { claudeSessionId: AD7E }) }),
        savedTab('new', { b: saved('✳ Session gamma', { claudeSessionId: E565 }) }, { sessionIdsVerified: true }),
      ],
      mint
    )
    expect(plan.lookup).toEqual([
      expect.objectContaining({ cwd: HOME, knownSid: AD7E, knownVerified: false, label: '✳ Session alpha', claude: true }),
      expect.objectContaining({ cwd: HOME, knownSid: E565, knownVerified: true, claude: true }),
    ])
  })

  it('in a snapshot from an older build, asks about a shell pane whose title says claude was in it', () => {
    // 13 of 20 claude panes on the PC were saved as 'zsh': the monitor never
    // told the renderer what was running, so the save could not know.
    const plan = planRestore([savedTab('old', { a: saved('✳ Session delta', { command: 'zsh' }), b: saved('~', { command: 'zsh' }) })], mint)
    expect(plan.lookup).toHaveLength(1)
    expect(plan.lookup[0]).toMatchObject({ label: '✳ Session delta', claude: true })
  })

  it('never sends a custom label as a title', () => {
    const plan = planRestore([savedTab('t', { a: saved('✳ my name', { labelIsCustom: true }) })], mint)
    expect(plan.lookup[0]!.label).toBeUndefined()
  })
})

describe('applyRestoreIds', () => {
  it('replaces a wrong saved id with the resolved one, drops an unresolved one, promotes a titled shell', () => {
    const plan = planRestore(
      [
        savedTab('old', {
          a: saved('✳ Session alpha', { claudeSessionId: AD7E }),
          b: saved('✳ Roof quote for 12 Elm St', { claudeSessionId: E565 }),
          c: saved('✳ Session delta', { command: 'zsh' }),
        }),
      ],
      mint
    )
    const [pa, pb, pc] = plan.lookup.map((l) => l.paneId)
    applyRestoreIds(plan.tabs, plan.lookup, { [pa!]: ABDA, [pc!]: E565 })
    const panes = plan.tabs[0]!.panes
    expect(panes[pa!]).toMatchObject({ command: 'claude', claudeSessionId: ABDA })
    expect(panes[pb!]!.command).toBe('claude')
    expect(panes[pb!]!.claudeSessionId).toBeUndefined()
    expect(panes[pc!]).toMatchObject({ command: 'claude', claudeSessionId: E565 })
  })

  it('when the lookup fails, keeps verified ids and drops unverified ones', () => {
    const plan = planRestore(
      [
        savedTab('old', { a: saved('✳ x', { claudeSessionId: AD7E }) }),
        savedTab('new', { b: saved('✳ y', { claudeSessionId: E565 }) }, { sessionIdsVerified: true }),
      ],
      mint
    )
    applyRestoreIds(plan.tabs, plan.lookup, null)
    const all = plan.tabs.flatMap((t) => Object.values(t.panes))
    expect(all.map((p) => p.claudeSessionId)).toEqual([undefined, E565])
  })
})

describe('saving', () => {
  const live = (extra: Partial<PaneState> = {}): PaneState => ({
    id: 'p1',
    kind: 'term',
    cwd: HOME,
    label: '✳ Session gamma',
    labelIsCustom: false,
    command: 'zsh',
    pid: 1,
    status: 'live',
    ...extra,
  })

  it('a shell pane proven to be running claude is saved as claude with its session', () => {
    expect(paneToSaved(live(), E565, true)).toMatchObject({ command: 'claude', claudeSessionId: E565 })
  })

  it('without that proof a shell pane stays a shell', () => {
    expect(paneToSaved(live(), E565).command).toBe('zsh')
  })

  it('a custom command pane is never rewritten into claude', () => {
    expect(paneToSaved(live({ command: 'cmd', commandText: 'ccli' }), E565, true).command).toBe('cmd')
  })

  it('marks a tab written by this build as carrying verified ids', () => {
    const tab = { id: 't', name: 't', cwd: HOME, pristine: true, zoomedPaneId: null, focusedPaneId: 'p1', tree: {}, panes: { p1: live() } } as unknown as TabState
    expect(tabToSaved(tab).sessionIdsVerified).toBe(true)
  })
})

describe('carry-forward in the live state', () => {
  const state = (panes: PaneState[]): AppState =>
    ({
      tabs: [{ id: 't1', name: 't', cwd: HOME, pristine: true, zoomedPaneId: null, focusedPaneId: panes[0]!.id, panes: Object.fromEntries(panes.map((p) => [p.id, p])), tree: {} }],
      activeTabId: 't1',
    }) as unknown as AppState
  const p = (id: string, sid?: string): PaneState =>
    ({ id, kind: 'term', cwd: HOME, label: id, labelIsCustom: false, command: 'claude', pid: 1, status: 'live', ...(sid ? { claudeSessionId: sid } : {}) }) as PaneState

  it('records the session a pane is proven to be on, so a later save can carry it', () => {
    const next = reducer(state([p('a', AD7E), p('b')]), { type: 'panes.sessionIds', ids: { a: ABDA, b: E565 } })
    expect(next.tabs[0]!.panes['a']!.claudeSessionId).toBe(ABDA)
    expect(next.tabs[0]!.panes['b']!.claudeSessionId).toBe(E565)
  })

  it('changes nothing when nothing changed', () => {
    const s = state([p('a', ABDA)])
    expect(reducer(s, { type: 'panes.sessionIds', ids: { a: ABDA } })).toBe(s)
  })
})

describe('permission mode on launch', () => {
  it('with bypass consented, a session last seen in dontAsk or default comes back in bypass', () => {
    for (const m of ['dontAsk', 'default', 'manual', 'auto', 'bypassPermissions', undefined]) {
      expect(claudeLaunchMode(m, true)).toBe('bypassPermissions')
    }
  })

  it('keeps plan and acceptEdits, which only a person picks', () => {
    expect(claudeLaunchMode('plan', true)).toBe('plan')
    expect(claudeLaunchMode('acceptEdits', true)).toBe('acceptEdits')
  })

  it('without consent, follows the transcript as before and never invents bypass', () => {
    expect(claudeLaunchMode('dontAsk', false)).toBe('dontAsk')
    expect(claudeLaunchMode('bypassPermissions', false)).toBe('bypassPermissions')
    expect(claudeLaunchMode(undefined, false)).toBeUndefined()
  })

  it('a fresh claude pane gets the flag too, not just a resumed one', () => {
    expect(launchCommandText({ command: 'claude', claudeResumeMode: 'bypassPermissions' })).toBe(
      'claude --dangerously-skip-permissions'
    )
  })

  it('applies to every claude pane being restored, resumed or cold', () => {
    const plan = planRestore([savedTab('t', { a: saved('✳ a', { claudeSessionId: E565 }), b: saved('✳ b'), c: saved('~', { command: 'zsh' }) }, { sessionIdsVerified: true })], mint)
    const ids = Object.keys(plan.tabs[0]!.panes)
    applyLaunchModes(plan.tabs, { [ids[0]!]: 'dontAsk' }, true)
    const panes = plan.tabs[0]!.panes
    expect(launchCommandText(panes[ids[0]!]!)).toBe(`claude --dangerously-skip-permissions -r ${E565}`)
    expect(launchCommandText(panes[ids[1]!]!)).toBe('claude --dangerously-skip-permissions')
    expect(launchCommandText(panes[ids[2]!]!)).toBeNull()
  })
})
