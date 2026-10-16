import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAgentVerdicts, sessionIdsForPanes } from '../../src/main/state/session-lookup.js'
import type { PaneAgent, ProcInfo } from '../../src/main/state/agents.js'
import {
  applyRestoreIds,
  launchCommandText,
  lookupPaneFor,
  paneToSaved,
  planRestore,
  saveLookupFrom,
  savedToPane,
  stateToTabs,
} from '../../src/renderer/projects/serialize.js'
import { reducer, type AppState, type PaneState } from '../../src/renderer/store.js'
import type { SavedPane, SavedTab } from '../../src/shared/ipc.js'

const J1 = '01a13d10-dbe9-7514-819f-26fe33fe4b2a'
const J2 = '01a13d10-dbe9-7514-819f-26fe33fe4b2b'
const C1 = '11111111-1111-4111-8111-111111111111'
const OC1 = 'ses_aaaabbbbccccddddeeeeffff11'

function pane(extra: Partial<PaneState> = {}): PaneState {
  return { id: 'p1', kind: 'term', cwd: '/home/user/proj', label: 'proj', labelIsCustom: false, command: 'zsh', pid: 1, status: 'live', ...extra }
}

function savedPane(extra: Partial<SavedPane> = {}): SavedPane {
  return { label: 'proj', labelIsCustom: false, kind: 'term', command: 'zsh', cwd: '/home/user/proj', ...extra }
}

describe('saving an agent pane', () => {
  it('saves a pane main proved running jarvis, with its session and flags', () => {
    const saved = paneToSaved(pane(), undefined, false, {
      verdicts: new Map([['p1', { kind: 'jarvis', sid: J1, flags: ['--effort', 'high'], source: 'process' }]]),
      checked: true,
    })
    expect(saved).toMatchObject({ command: 'jarvis', agentSessionId: J1, agentFlags: ['--effort', 'high'] })
    expect(saved.claudeSessionId).toBeUndefined()
  })

  it('a live claude outranks a carried agent', () => {
    const saved = paneToSaved(pane({ command: 'jarvis', agentSessionId: J1 }), C1, true, {
      verdicts: new Map(),
      checked: true,
    })
    expect(saved).toMatchObject({ command: 'claude', claudeSessionId: C1 })
    expect(saved.agentSessionId).toBeUndefined()
  })

  it('keeps a restored agent pane that has not started yet, and retires one the user left', () => {
    const carried = { verdicts: new Map([['p1', { kind: 'ultron' as const, sid: J1, source: 'carried' as const }]]), checked: true }
    expect(paneToSaved(pane({ command: 'ultron', agentSessionId: J1 }), undefined, false, carried)).toMatchObject({
      command: 'ultron',
      agentSessionId: J1,
    })
    expect(paneToSaved(pane({ command: 'ultron', agentSessionId: J1, agentSeen: true }), undefined, false, carried).command).toBe('zsh')
    // An unread process table is no verdict: the pane stays.
    const unread = { ...carried, checked: false }
    expect(paneToSaved(pane({ command: 'ultron', agentSessionId: J1, agentSeen: true }), undefined, false, unread).command).toBe('ultron')
  })

  it('with no lookup at all, every agent pane keeps what it carries', () => {
    const state = {
      tabs: [{ id: 't', name: 't', cwd: '/', tree: {}, zoomedPaneId: null, focusedPaneId: 'p1', panes: { p1: pane({ command: 'opencode', agentSessionId: OC1 }) } }],
    } as unknown as AppState
    expect(stateToTabs(state)[0]!.panes.p1).toMatchObject({ command: 'opencode', agentSessionId: OC1 })
  })

  it('never writes an id that fails the agent’s allowlist', () => {
    const saved = paneToSaved(pane(), undefined, false, {
      verdicts: new Map([['p1', { kind: 'opencode', sid: 'ses_x; rm -rf ~', source: 'process' }]]),
      checked: true,
    })
    expect(saved.command).toBe('opencode')
    expect(saved.agentSessionId).toBeUndefined()
  })

  it('asks main about an agent pane without mixing its id into the claude lanes', () => {
    expect(lookupPaneFor(pane({ command: 'jarvis', agentSessionId: J1, agentFlags: ['--business'] }))).toEqual({
      paneId: 'p1',
      cwd: '/home/user/proj',
      claude: false,
      agent: 'jarvis',
      agentSid: J1,
      agentFlags: ['--business'],
    })
    expect(lookupPaneFor(pane({ command: 'claude', claudeSessionId: C1 }))).toMatchObject({ knownSid: C1, claude: true })
  })

  it('reads the verdicts off main’s answer, and a pane past the cap keeps its own', () => {
    const panes = [pane({ id: 'a' }), pane({ id: 'b', command: 'jarvis', agentSessionId: J2 })]
    const lookup = saveLookupFrom(panes, 1, {
      ids: {},
      sources: {},
      agents: { a: { kind: 'opencode', sid: OC1, source: 'process' } },
      agentsChecked: true,
    })
    expect(lookup?.agents?.checked).toBe(true)
    expect(lookup?.agents?.verdicts.get('a')).toMatchObject({ kind: 'opencode', sid: OC1 })
    expect(lookup?.agents?.verdicts.get('b')).toMatchObject({ kind: 'jarvis', sid: J2, source: 'carried' })
  })
})

describe('loading and restoring agent panes', () => {
  it('an old-format saved claude pane loads exactly as before', () => {
    const p = savedToPane('n1', savedPane({ command: 'claude', claudeSessionId: C1 }))
    expect(p).toEqual({
      id: 'n1',
      kind: 'term',
      cwd: '/home/user/proj',
      label: 'proj',
      labelIsCustom: false,
      command: 'claude',
      claudeSessionId: C1,
      pid: null,
      status: 'starting',
    })
    expect(launchCommandText(p)).toBe(`claude -r ${C1}`)
  })

  it('validates an agent pane’s id and flags on load', () => {
    expect(savedToPane('n', savedPane({ command: 'jarvis', agentSessionId: J1, agentFlags: ['--effort', 'high', '--about', 'x'] }))).toMatchObject({
      command: 'jarvis',
      agentSessionId: J1,
      agentFlags: ['--effort', 'high'],
    })
    const bad = savedToPane('n', savedPane({ command: 'jarvis', agentSessionId: 'x; rm -rf ~', agentFlags: ['$(id)'] }))
    expect(bad.agentSessionId).toBeUndefined()
    expect(bad.agentFlags).toBeUndefined()
    expect(launchCommandText(bad)).toBe('jarvis')
    // A program nobody allowed comes back as a shell.
    expect(savedToPane('n', savedPane({ command: 'rm -rf ~' as never })).command).toBe('zsh')
  })

  it('types the resume command for each agent', () => {
    expect(launchCommandText(pane({ command: 'jarvis', agentSessionId: J1, agentFlags: ['--effort', 'high'] }))).toBe(
      `jarvis --effort high --session ${J1}`
    )
    expect(launchCommandText(pane({ command: 'ultron', agentSessionId: J1 }))).toBe(`ultron --session ${J1}`)
    expect(launchCommandText(pane({ command: 'opencode', agentSessionId: OC1 }))).toBe(`opencode -s ${OC1}`)
    expect(launchCommandText(pane({ command: 'opencode' }))).toBe('opencode')
  })

  it('asks main to settle agent panes at restore and applies its answer', () => {
    const saved: SavedTab[] = [
      {
        id: 't',
        name: 't',
        nameIsCustom: false,
        cwd: '/home/user/proj',
        zoomedPaneId: null,
        focusedPaneId: 'a',
        tree: { type: 'row', ratios: [0.5, 0.5], children: [{ type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'a' }] }, { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'b' }] }] },
        panes: {
          a: savedPane({ command: 'jarvis', agentSessionId: J1, agentFlags: ['--business'] }),
          b: savedPane({ command: 'opencode', agentSessionId: OC1 }),
        },
        sessionIdsVerified: true,
      },
    ]
    let n = 0
    const { tabs, lookup } = planRestore(saved, (prefix) => `${prefix}-${++n}`)
    expect(lookup.map((l) => [l.agent, l.agentSid, l.claude])).toEqual([
      ['jarvis', J1, false],
      ['opencode', OC1, false],
    ])
    const [a, b] = lookup.map((l) => l.paneId)
    applyRestoreIds(tabs, lookup, {}, { [a!]: { kind: 'jarvis', sid: J1, source: 'carried' }, [b!]: { kind: 'opencode', source: 'carried' } })
    expect(launchCommandText(tabs[0]!.panes[a!]!)).toBe(`jarvis --business --session ${J1}`)
    // Main would not stand behind b's session (it is open elsewhere): fresh.
    expect(launchCommandText(tabs[0]!.panes[b!]!)).toBe('opencode')
  })

  it('a failed lookup keeps only verified agent ids', () => {
    const tab = (verified: boolean): SavedTab => ({
      id: 't',
      name: 't',
      nameIsCustom: false,
      cwd: '/',
      zoomedPaneId: null,
      focusedPaneId: 'a',
      tree: null,
      panes: { a: savedPane({ command: 'ultron', agentSessionId: J1 }) },
      ...(verified ? { sessionIdsVerified: true } : {}),
    })
    for (const verified of [true, false]) {
      const { tabs, lookup } = planRestore([tab(verified)], (p) => `${p}-x`)
      applyRestoreIds(tabs, lookup, null)
      expect(Object.values(tabs[0]!.panes)[0]!.agentSessionId).toBe(verified ? J1 : undefined)
    }
  })

  it('panes.agents makes a pane the agent main proved, and only from a live process', () => {
    const state = {
      tabs: [{ id: 't', name: 't', cwd: '/', tree: {}, zoomedPaneId: null, focusedPaneId: 'p1', panes: { p1: pane({ claudeSessionId: C1 }), p2: pane({ id: 'p2' }) } }],
    } as unknown as AppState
    const next = reducer(state, {
      type: 'panes.agents',
      agents: { p1: { kind: 'jarvis', sid: J1, flags: ['--effort', 'low'], source: 'process' }, p2: { kind: 'ultron', sid: J2, source: 'carried' } },
    })
    expect(next.tabs[0]!.panes.p1).toMatchObject({ command: 'jarvis', agentSessionId: J1, agentFlags: ['--effort', 'low'], agentSeen: true })
    expect(next.tabs[0]!.panes.p1!.claudeSessionId).toBeUndefined()
    expect(next.tabs[0]!.panes.p2!.command).toBe('zsh')
  })
})

describe('resolveAgentVerdicts', () => {
  const live = (kind: PaneAgent['kind'], sid?: string): PaneAgent => ({ kind, depth: 1, pid: 5, ...(sid ? { sid } : {}), flags: [], cwd: '/x' })

  it('answers a live pane from its process, and a carried pane only while its session is free', () => {
    const out = resolveAgentVerdicts(
      [
        { paneId: 'a', cwd: '/x' },
        { paneId: 'b', cwd: '/x', agent: 'jarvis', agentSid: J1 },
        { paneId: 'c', cwd: '/x', agent: 'jarvis', agentSid: J2 },
        { paneId: 'd', cwd: '/x', agent: 'opencode', agentSid: OC1 },
        { paneId: 'e', cwd: '/x', agent: 'opencode', agentSid: OC1 },
      ],
      new Map([['a', live('ultron', J1)]]),
      new Map([['jarvis', new Set([J2])]]),
      new Set()
    )
    expect(out.a).toEqual({ kind: 'ultron', sid: J1, source: 'process' })
    expect(out.b).toEqual({ kind: 'jarvis', sid: J1, source: 'carried' })
    // J2 is open in a process somewhere: the pane comes back fresh.
    expect(out.c).toEqual({ kind: 'jarvis', source: 'carried' })
    // Two panes carrying one session cannot both be right.
    expect(out.d).toEqual({ kind: 'opencode', source: 'carried' })
    expect(out.e).toEqual({ kind: 'opencode', source: 'carried' })
  })

  it('a pane running claude keeps no other agent', () => {
    const out = resolveAgentVerdicts([{ paneId: 'a', cwd: '/x', agent: 'jarvis', agentSid: J1 }], new Map(), new Map(), new Set(['a']))
    expect(out).toEqual({})
  })
})

describe('sessionIdsForPanes with the agent lanes', () => {
  let home: string
  let savedHome: string | undefined
  beforeEach(() => {
    savedHome = process.env.HOME
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'))
    process.env.HOME = home
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true })
  })
  afterEach(() => {
    process.env.HOME = savedHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  const H = '/home/user'
  const info = (pid: number, argv: string[], extra: Partial<ProcInfo> = {}): ProcInfo => ({
    pid,
    argv,
    cwd: '/home/user/proj',
    env: {},
    startMs: 1_000_000,
    exe: null,
    ...extra,
  })

  function deps(procs: Record<number, ProcInfo>, parents: Record<number, number>, claudeTokens: Record<number, string> = {}) {
    const childrenOf = new Map<number, number[]>()
    for (const [c, p] of Object.entries(parents)) childrenOf.set(p, [...(childrenOf.get(p) ?? []), Number(c)])
    return {
      shellPidOf: (paneId: string) => ({ p1: 10, p2: 20 })[paneId] ?? null,
      processChildren: async () => childrenOf,
      startTokens: async (pids: number[]) => new Map(pids.filter((p) => claudeTokens[p]).map((p) => [p, claudeTokens[p]!])),
      agents: {
        home: H,
        platform: 'linux' as const,
        procInfo: async (pid: number) => procs[pid] ?? null,
        listPi: async () => [{ sid: J1, startedMs: 1_001_000, touchedMs: 1_100_000 }],
        listOpencode: async () => [],
        processTable: async () => ({
          parents: new Map(Object.entries(parents).map(([c, p]) => [Number(c), p])),
          comm: new Map(Object.entries(procs).map(([pid, p]) => [Number(pid), p.argv[0]!])),
        }),
      },
    }
  }

  it('reports a pane running jarvis as such, and keeps it out of the claude lanes', async () => {
    const procs = {
      10: info(10, ['-zsh']),
      11: info(11, ['bash', `${H}/.local/bin/jarvis`, '--effort', 'high']),
      12: info(12, ['node', `${H}/local-ai/jarvis/pi/node_modules/.bin/pi`]),
    }
    const out = await sessionIdsForPanes([{ paneId: 'p1', cwd: '/home/user/proj' }], deps(procs, { 11: 10, 12: 11 }))
    expect(out.agents).toEqual({ p1: { kind: 'jarvis', sid: J1, flags: ['--effort', 'high'], source: 'process' } })
    expect(out.agentsChecked).toBe(true)
    expect(out.ids).toEqual({})
  })

  it('the agent nearest the shell wins: a claude jarvis started is not the pane’s', async () => {
    fs.writeFileSync(
      path.join(home, '.claude', 'sessions', '13.json'),
      JSON.stringify({ pid: 13, sessionId: C1, procStart: '77', startedAt: 1 })
    )
    const procs = {
      10: info(10, ['-zsh']),
      11: info(11, ['bash', `${H}/.local/bin/jarvis`]),
      12: info(12, ['node', `${H}/local-ai/jarvis/pi/node_modules/.bin/pi`]),
      13: info(13, ['claude', '-p', 'x']),
    }
    const out = await sessionIdsForPanes([{ paneId: 'p1', cwd: '/home/user/proj' }], deps(procs, { 11: 10, 12: 11, 13: 12 }, { 13: '77' }))
    expect(out.agents?.p1?.kind).toBe('jarvis')
    expect(out.ids.p1).toBeUndefined()
  })

  it('a carried session another live process holds is not resumed', async () => {
    const procs = {
      30: info(30, ['node', `${H}/local-ai/jarvis/pi/node_modules/.bin/pi`, '--session', J2]),
    }
    const out = await sessionIdsForPanes(
      [
        { paneId: 'p1', cwd: '/home/user/proj', agent: 'jarvis', agentSid: J2 },
        { paneId: 'p2', cwd: '/home/user/proj', agent: 'jarvis', agentSid: J1 },
      ],
      deps(procs, { 30: 1 })
    )
    expect(out.agents).toEqual({
      p1: { kind: 'jarvis', source: 'carried' },
      p2: { kind: 'jarvis', sid: J1, source: 'carried' },
    })
  })
})
