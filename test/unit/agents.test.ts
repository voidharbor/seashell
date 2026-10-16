import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentLaunchText, cleanAgentFlags, isValidAgentSessionId } from '../../src/shared/agents.js'
import {
  classifyAgentProc,
  listPiSessions,
  lookupPaneAgents,
  opencodeSessionsFromDb,
  parseOpencodeSessionList,
  parsePiHeader,
  pickAgentSessions,
  piSessionDirName,
  type AgentProc,
  type ProcInfo,
  type SessionCandidate,
} from '../../src/main/state/agents.js'

const HOME = '/home/user'
const J1 = '01a13d10-dbe9-7514-819f-26fe33fe4b2a'
const J2 = '01a13d10-dbe9-7514-819f-26fe33fe4b2b'
const J3 = '01a13d10-dbe9-7514-819f-26fe33fe4b2c'
const OC1 = 'ses_aaaabbbbccccddddeeeeffff11'
const OC2 = 'ses_aaaabbbbccccddddeeeeffff22'

function proc(over: Partial<ProcInfo> & { argv: string[] }): ProcInfo {
  return { pid: 100, cwd: '/home/user/proj', env: {}, startMs: 1_000_000, exe: null, ...over }
}

const jarvisNode = (over: Partial<ProcInfo> = {}): ProcInfo =>
  proc({
    argv: ['node', `${HOME}/local-ai/jarvis/pi/node_modules/.bin/pi`, '--thinking', 'high'],
    env: { PI_CODING_AGENT_DIR: `${HOME}/local-ai/jarvis/pi-agent` },
    ...over,
  })
const jarvisLauncher = (args: string[]): ProcInfo => proc({ pid: 99, argv: ['bash', `${HOME}/.local/bin/jarvis`, ...args] })

describe('the agent table', () => {
  it('validates ids per agent and refuses injection attempts', () => {
    expect(isValidAgentSessionId('jarvis', J1)).toBe(true)
    expect(isValidAgentSessionId('opencode', OC1)).toBe(true)
    expect(isValidAgentSessionId('opencode', J1)).toBe(false)
    expect(isValidAgentSessionId('jarvis', OC1)).toBe(false)
    for (const bad of ['x; rm -rf ~', `${J1}; rm -rf ~`, `ses_abc$(id)defghijklmnop`, `${OC1} && echo`, '', `${J1}\n`]) {
      expect(isValidAgentSessionId('jarvis', bad)).toBe(false)
      expect(isValidAgentSessionId('opencode', bad)).toBe(false)
    }
  })

  it('composes each resume command from fixed parts only', () => {
    expect(agentLaunchText('jarvis', J1)).toBe(`jarvis --session ${J1}`)
    expect(agentLaunchText('jarvis', J1, ['--effort', 'high', '--business'])).toBe(`jarvis --effort high --business --session ${J1}`)
    expect(agentLaunchText('ultron', J1)).toBe(`ultron --session ${J1}`)
    expect(agentLaunchText('opencode', OC1)).toBe(`opencode -s ${OC1}`)
    expect(agentLaunchText('opencode')).toBe('opencode')
    // A bad id resumes nothing: the agent starts fresh.
    expect(agentLaunchText('jarvis', 'x; rm -rf ~')).toBe('jarvis')
    expect(agentLaunchText('opencode', `${OC1}; rm -rf ~`)).toBe('opencode')
    // Flags outside the table never reach the shell.
    expect(agentLaunchText('jarvis', J1, ['--effort', 'high; rm -rf ~', '--about', 'x', '$(id)'])).toBe(`jarvis --session ${J1}`)
    expect(agentLaunchText('ultron', undefined, ['--business'])).toBe('ultron')
  })

  it('keeps only the allowlisted jarvis flags', () => {
    expect(cleanAgentFlags('jarvis', ['--about', 'x', '--business', '--effort', 'max', '--model', 'y'])).toEqual(['--effort', 'max', '--business'])
    expect(cleanAgentFlags('jarvis', ['--effort=low'])).toEqual(['--effort', 'low'])
    expect(cleanAgentFlags('jarvis', ['--effort', 'turbo'])).toEqual([])
    expect(cleanAgentFlags('jarvis', 'nope')).toEqual([])
    expect(cleanAgentFlags('opencode', ['--business'])).toEqual([])
  })

  it('encodes a cwd the way pi names its session directories', () => {
    expect(piSessionDirName('/home/user')).toBe('--home-user--')
    expect(piSessionDirName('/home/user/proj/x')).toBe('--home-user-proj-x--')
  })
})

describe('classifyAgentProc', () => {
  it('recognises jarvis from its agent dir and carries the launcher flags', () => {
    const a = classifyAgentProc(jarvisNode(), jarvisLauncher(['--effort', 'high', '--about', 'stuff', '--business']), HOME, 'linux')
    expect(a).toMatchObject({ kind: 'jarvis', dataDir: `${HOME}/local-ai/jarvis/pi-agent`, flags: ['--effort', 'high', '--business'] })
  })

  it('recognises jarvis from the script path when the environment is unreadable', () => {
    const a = classifyAgentProc(jarvisNode({ env: {} }), null, HOME, 'linux')
    expect(a).toMatchObject({ kind: 'jarvis', dataDir: `${HOME}/local-ai/jarvis/pi-agent`, flags: [] })
  })

  it('does not take a script the agent ran for the agent', () => {
    const tool = proc({ argv: ['node', 'build.js'], env: { PI_CODING_AGENT_DIR: `${HOME}/local-ai/jarvis/pi-agent` } })
    expect(classifyAgentProc(tool, null, HOME, 'linux')).toBeNull()
    const bash = proc({ argv: ['bash', '-c', 'ls'], env: { PI_CODING_AGENT_DIR: `${HOME}/local-ai/jarvis/pi-agent` } })
    expect(classifyAgentProc(bash, null, HOME, 'linux')).toBeNull()
  })

  it('recognises ultron inside bwrap, but not bwrap itself', () => {
    const cli = `${HOME}/.local/share/ultron/pi-cli/dist/bundle/cli.js`
    expect(classifyAgentProc(proc({ argv: ['node', cli] }), null, HOME, 'linux')).toMatchObject({
      kind: 'ultron',
      dataDir: `${HOME}/.local/share/ultron/agent`,
    })
    expect(classifyAgentProc(proc({ argv: ['bwrap', '--bind', HOME, HOME, 'node', cli] }), null, HOME, 'linux')).toBeNull()
  })

  it('reads an explicit session from the command line', () => {
    const resumed = jarvisNode({ argv: ['node', `${HOME}/local-ai/jarvis/pi/node_modules/.bin/pi`, '--session', J2] })
    expect(classifyAgentProc(resumed, null, HOME, 'linux')?.explicitSid).toBe(J2)
    const byPath = jarvisNode({
      argv: ['node', `${HOME}/local-ai/jarvis/pi/node_modules/.bin/pi`, `--session=/x/2026-10-15T00-57-57-482Z_${J3}.jsonl`],
    })
    expect(classifyAgentProc(byPath, null, HOME, 'linux')?.explicitSid).toBe(J3)
    const bad = jarvisNode({ argv: ['node', `${HOME}/local-ai/jarvis/pi/node_modules/.bin/pi`, '--session', 'x; rm -rf ~'] })
    expect(classifyAgentProc(bad, null, HOME, 'linux')?.explicitSid).toBeUndefined()
    const oc = classifyAgentProc(proc({ argv: ['opencode', '-s', OC1] }), null, HOME, 'linux')
    expect(oc).toMatchObject({ kind: 'opencode', explicitSid: OC1 })
  })

  it('recognises opencode sessions, but not its other subcommands', () => {
    expect(classifyAgentProc(proc({ argv: ['/home/user/.local/bin/opencode'] }), null, HOME, 'linux')?.kind).toBe('opencode')
    expect(classifyAgentProc(proc({ argv: ['opencode', '/home/user/proj'] }), null, HOME, 'darwin')?.kind).toBe('opencode')
    expect(classifyAgentProc(proc({ argv: ['opencode', 'session', 'list'] }), null, HOME, 'linux')).toBeNull()
    expect(classifyAgentProc(proc({ argv: ['opencode', 'export', OC1] }), null, HOME, 'linux')).toBeNull()
  })

  it('never matches jarvis or ultron off Linux', () => {
    expect(classifyAgentProc(jarvisNode(), null, HOME, 'darwin')).toBeNull()
    expect(classifyAgentProc(jarvisNode(), null, HOME, 'win32')).toBeNull()
  })
})

const ap = (over: Partial<AgentProc>): AgentProc => ({
  kind: 'jarvis',
  pid: 1,
  dataDir: '/d',
  cwd: '/home/user/proj',
  startMs: 1_000_000,
  reopened: false,
  flags: [],
  ...over,
})
const cand = (sid: string, startedMs: number, touchedMs = startedMs): SessionCandidate => ({ sid, startedMs, touchedMs })

describe('pickAgentSessions', () => {
  it('takes the newest session started since the process did', () => {
    const out = pickAgentSessions([ap({ pid: 1 })], () => [
      cand(J1, 500_000, 2_000_000), // older than the process: someone else's
      cand(J2, 1_000_500, 1_100_000),
      cand(J3, 1_200_000, 1_300_000), // a /new later on
    ])
    expect(out.get(1)).toBe(J3)
  })

  it('allows a few seconds of skew between the process start and the header', () => {
    expect(pickAgentSessions([ap({ pid: 1 })], () => [cand(J1, 997_000)]).get(1)).toBe(J1)
    expect(pickAgentSessions([ap({ pid: 1 })], () => [cand(J1, 990_000)]).get(1)).toBeUndefined()
  })

  it('a reopened session counts when it was written since the start', () => {
    const out = pickAgentSessions([ap({ pid: 1, reopened: true })], () => [cand(J1, 100, 1_500_000)])
    expect(out.get(1)).toBe(J1)
  })

  it('an id on the command line wins, and is never handed to another process', () => {
    const out = pickAgentSessions([ap({ pid: 1, explicitSid: J1 }), ap({ pid: 2, startMs: 900_000 })], () => [
      cand(J1, 1_500_000, 3_000_000),
      cand(J2, 950_000, 1_000_000),
    ])
    expect(out.get(1)).toBe(J1)
    expect(out.get(2)).toBe(J2)
  })

  it('gives nothing when two processes share the agent dir and cwd and either could own the session', () => {
    const out = pickAgentSessions([ap({ pid: 1 }), ap({ pid: 2, startMs: 1_050_000 })], () => [
      cand(J1, 1_001_000, 1_100_000),
      cand(J2, 1_060_000, 1_200_000),
    ])
    // J2 started after both: ambiguous for both. pid 1's best (J2) is contested.
    expect(out.size).toBe(0)
  })

  it('still answers for the older process when its newest session predates the other one', () => {
    const out = pickAgentSessions([ap({ pid: 1 }), ap({ pid: 2, startMs: 1_500_000 })], () => [cand(J1, 1_001_000, 1_100_000)])
    expect(out.get(1)).toBe(J1)
    expect(out.get(2)).toBeUndefined()
  })

  it('keeps different directories and agents apart', () => {
    const out = pickAgentSessions(
      [ap({ pid: 1 }), ap({ pid: 2, cwd: '/home/user/other' }), ap({ pid: 3, kind: 'ultron', dataDir: '/u' })],
      (p) => (p.pid === 1 ? [cand(J1, 1_001_000)] : p.pid === 2 ? [cand(J2, 1_001_000)] : [cand(J3, 1_001_000)])
    )
    expect(Object.fromEntries(out)).toEqual({ 1: J1, 2: J2, 3: J3 })
  })

  it('opencode goes by the last update, and never takes a malformed id', () => {
    const out = pickAgentSessions([ap({ pid: 1, kind: 'opencode' })], () => [
      cand('ses_x; rm -rf ~', 2_000_000, 3_000_000),
      cand(OC1, 10, 1_200_000),
      cand(OC2, 20, 900_000),
    ])
    expect(out.get(1)).toBe(OC1)
  })
})

describe('session files', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('parses a pi header and refuses anything else', () => {
    expect(parsePiHeader(JSON.stringify({ type: 'session', version: 3, id: J1, timestamp: '2026-10-15T00:57:57.482Z', cwd: '/home/user/proj' }))).toEqual({
      id: J1,
      startedMs: Date.parse('2026-10-15T00:57:57.482Z'),
      cwd: '/home/user/proj',
    })
    expect(parsePiHeader('{"type":"message"}')).toBeNull()
    expect(parsePiHeader('not json')).toBeNull()
  })

  it('lists a cwd’s pi sessions from their headers', async () => {
    const sdir = path.join(dir, 'sessions', piSessionDirName('/home/user/proj'))
    fs.mkdirSync(sdir, { recursive: true })
    const write = (name: string, header: object, mtime: number): void => {
      const f = path.join(sdir, name)
      fs.writeFileSync(f, JSON.stringify(header) + '\n{"type":"message"}\n')
      fs.utimesSync(f, mtime / 1000, mtime / 1000)
    }
    write(`2026-10-15T00-57-57-482Z_${J1}.jsonl`, { type: 'session', version: 3, id: J1, timestamp: '2026-10-15T00:57:57.482Z', cwd: '/home/user/proj' }, 1_800_000_000_000)
    write(`2026-10-15T01-00-00-000Z_${J2}.jsonl`, { type: 'session', version: 3, id: J2, timestamp: '2026-10-15T01:00:00.000Z', cwd: '/home/user/proj' }, 1_800_000_100_000)
    fs.writeFileSync(path.join(sdir, 'notes.txt'), 'x')
    const out = await listPiSessions(dir, '/home/user/proj')
    expect(out.map((s) => s.sid)).toEqual([J2, J1])
    expect(out[1]!.startedMs).toBe(Date.parse('2026-10-15T00:57:57.482Z'))
    expect(await listPiSessions(dir, '/home/user/none')).toEqual([])
  })

  it('reads opencode’s session list output', () => {
    const rows = parseOpencodeSessionList(
      JSON.stringify([
        { id: OC1, title: 'A made-up title', updated: 2000, created: 1000, projectId: 'p', directory: '/home/user/proj' },
        { id: 3, directory: '/x' },
      ])
    )
    expect(rows).toEqual([{ sid: OC1, directory: '/home/user/proj', startedMs: 1000, touchedMs: 2000 }])
    expect(parseOpencodeSessionList('garbage')).toEqual([])
  })

  it('reads opencode’s database read-only when node:sqlite is there', () => {
    const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
    const lib = get?.('node:sqlite') as { DatabaseSync?: new (f: string) => { exec(sql: string): void; close(): void } } | undefined
    const file = path.join(dir, 'opencode.db')
    if (!lib?.DatabaseSync) {
      expect(opencodeSessionsFromDb(file, '/home/user/proj')).toBeNull()
      return
    }
    const db = new lib.DatabaseSync(file)
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
      INSERT INTO session VALUES ('${OC1}', NULL, '/home/user/proj', 1000, 5000);
      INSERT INTO session VALUES ('${OC2}', '${OC1}', '/home/user/proj', 1100, 6000);
      INSERT INTO session VALUES ('ses_zzzzzzzzzzzzzzzzzzzzzzzzzz', NULL, '/home/user/other', 1000, 7000);`)
    db.close()
    expect(opencodeSessionsFromDb(file, '/home/user/proj')).toEqual([{ sid: OC1, directory: '/home/user/proj', startedMs: 1000, touchedMs: 5000 }])
    expect(opencodeSessionsFromDb(path.join(dir, 'missing.db'), '/x')).toBeNull()
  })
})

describe('lookupPaneAgents', () => {
  // zsh 10 -> bash launcher 11 -> node 12 (jarvis); zsh 20 -> opencode 21;
  // a second jarvis outside any pane (30) on the explicit session J2.
  const procs: Record<number, ProcInfo> = {
    10: proc({ pid: 10, argv: ['-zsh'] }),
    11: jarvisLauncher(['--effort', 'xhigh']),
    12: jarvisNode({ pid: 12 }),
    13: proc({ pid: 13, argv: ['node', 'build.js'], env: { PI_CODING_AGENT_DIR: `${HOME}/local-ai/jarvis/pi-agent` } }),
    20: proc({ pid: 20, argv: ['-zsh'] }),
    21: proc({ pid: 21, argv: ['opencode'], cwd: '/home/user/web' }),
    30: jarvisNode({ pid: 30, argv: ['node', `${HOME}/local-ai/jarvis/pi/node_modules/.bin/pi`, '--session', J2] }),
  }
  procs[11] = { ...procs[11]!, pid: 11 }
  const parents = new Map([[11, 10], [12, 11], [13, 12], [21, 20], [30, 1], [10, 1], [20, 1]])
  const childrenOf = new Map<number, number[]>()
  for (const [c, p] of parents) childrenOf.set(p, [...(childrenOf.get(p) ?? []), c])
  const deps = {
    home: HOME,
    platform: 'linux' as const,
    procInfo: async (pid: number) => procs[pid] ?? null,
    parents,
    childrenOf,
    commOf: (pid: number) => (procs[pid]?.argv[0] ?? '').split('/').pop(),
    listPi: async () => [cand(J1, 1_001_000, 1_400_000), cand(J2, 1_002_000, 1_500_000)],
    listOpencode: async () => [cand(OC1, 10, 1_300_000)],
  }

  it('finds each pane’s agent, its session and flags, and every live session', async () => {
    const out = await lookupPaneAgents(
      [
        { paneId: 'a', shellPid: 10 },
        { paneId: 'b', shellPid: 20 },
      ],
      deps
    )
    // J2 is taken by the jarvis outside the panes, so pane a gets J1.
    expect(out.panes.get('a')).toMatchObject({ kind: 'jarvis', sid: J1, flags: ['--effort', 'xhigh'], depth: 2 })
    expect(out.panes.get('b')).toMatchObject({ kind: 'opencode', sid: OC1, depth: 1 })
    expect([...(out.liveSids.get('jarvis') ?? [])].sort()).toEqual([J1, J2].sort())
  })
})
