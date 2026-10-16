import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  isValidAgentSessionId,
  cleanAgentFlags,
  type AgentKind,
  type OtherAgentKind,
} from '../../shared/agents.js'

/**
 * The agent registry's process side: which live process in a pane is which
 * agent, where that agent keeps its sessions, and which session the process
 * is on. claude keeps its own lanes in session-lookup.ts (it records
 * pid -> session itself); this file is for the agents that do not.
 *
 * Every entry is a fixed signature, never a guess from a process name alone:
 *
 *  - **jarvis**: the `pi` harness under ~/local-ai/jarvis, started as a child
 *    of the `jarvis` bash launcher. Sessions under
 *    ~/local-ai/jarvis/pi-agent/sessions/<encoded cwd>/.
 *  - **ultron**: the `pi` harness bundled under ~/.local/share/ultron, inside
 *    bwrap (which binds $HOME read-write, so the files are visible outside).
 *    Sessions under ~/.local/share/ultron/agent/sessions/<encoded cwd>/.
 *  - **opencode**: the `opencode` binary; sessions in its SQLite database
 *    (or its own `session list`).
 *
 * jarvis and ultron are Linux-only by construction (paths in a Linux home);
 * on any other platform their entries never match. `jarvis-cc` execs claude,
 * so the claude lanes already cover it.
 *
 * The pickers are [pure] and deps-injected for tests; the fs side is at the
 * bottom.
 */

/** What the process table and /proc say about one live process. */
export interface ProcInfo {
  pid: number
  argv: string[]
  /** Where the process is running, or null when it could not be read. */
  cwd: string | null
  /** PI_CODING_AGENT_DIR and XDG_DATA_HOME from its environment, when readable. */
  env: Readonly<Record<string, string>>
  /** Wall-clock start, ms since the epoch, or null when unknown. */
  startMs: number | null
  /** The executable's real path, or null. */
  exe: string | null
}

/** A live process recognised as an agent. */
export interface AgentProc {
  kind: OtherAgentKind
  pid: number
  /** pi: the agent dir its sessions live under; opencode: the data dir. */
  dataDir: string
  cwd: string | null
  startMs: number | null
  /** An id the command line names outright (`--session <id>`, `-s <id>`). */
  explicitSid?: string
  /** The command line asked to continue or pick an older session, so a
   *  session started before the process may still be the one it is on. */
  reopened: boolean
  /** The launcher's flags worth carrying across a restore (jarvis). */
  flags: string[]
  /** opencode: the binary, for its CLI fallback. */
  exe?: string
}

/** One session an agent has on disk for a directory. */
export interface SessionCandidate {
  sid: string
  /** When the session was created, ms. */
  startedMs: number
  /** When it was last written, ms. */
  touchedMs: number
}

/** How far apart a process start and its session's first timestamp may be. */
export const START_SKEW_MS = 5_000

const UUID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i

function base(p: string | undefined): string {
  return (p ?? '').split('/').pop() ?? ''
}

/** The pi agent dirs of jarvis and ultron under `home`. */
export function piAgentDirs(home: string): Record<'jarvis' | 'ultron', string> {
  const h = home.replace(/\/+$/, '')
  return {
    jarvis: `${h}/local-ai/jarvis/pi-agent`,
    ultron: `${h}/.local/share/ultron/agent`,
  }
}

/** opencode's data dir: $XDG_DATA_HOME/opencode, else ~/.local/share/opencode. */
export function opencodeDataDir(home: string, xdgDataHome?: string): string {
  const root = xdgDataHome && xdgDataHome.startsWith('/') ? xdgDataHome : `${home.replace(/\/+$/, '')}/.local/share`
  return `${root.replace(/\/+$/, '')}/opencode`
}

/**
 * The directory pi keeps a cwd's sessions in: `--` + the path without its
 * leading slash, every `/`, `\` and `:` turned into `-`, + `--`.
 * `/home/user/proj/x` is `--home-user-proj-x--`. [pure]
 */
export function piSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/** The value after `flag` (`--x v` or `--x=v`), searching the whole argv. */
function flagValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    if (a === '--') return undefined
    for (const n of names) {
      if (a === n) return argv[i + 1]
      if (n.startsWith('--') && a.startsWith(`${n}=`)) return a.slice(n.length + 1)
    }
  }
  return undefined
}

function hasFlag(argv: readonly string[], names: readonly string[]): boolean {
  for (const a of argv) {
    if (a === '--') return false
    if (names.includes(a)) return true
  }
  return false
}

/** A session id from `--session <path|id>`: the id, or the uuid a pi file name ends with. */
function sidFromSessionArg(kind: OtherAgentKind, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isValidAgentSessionId(kind, value)) return value
  if (kind === 'opencode') return undefined
  const m = UUID_IN_NAME.exec(value)
  return m && isValidAgentSessionId(kind, m[1]) ? m[1] : undefined
}

/** opencode subcommands that are not an agent session. */
const OPENCODE_NOT_SESSION = new Set([
  'session', 'export', 'import', 'serve', 'web', 'models', 'auth', 'upgrade', 'uninstall', 'mcp',
  'stats', 'agent', 'github', 'pr', 'debug', 'acp', 'completion', 'help', 'generate',
])

/**
 * Which agent `proc` is, if any. `parent` is its parent process (the jarvis
 * launcher, for the flags). `platform` gates the Linux-only entries. [pure]
 */
export function classifyAgentProc(
  proc: ProcInfo,
  parent: ProcInfo | null,
  home: string,
  platform: NodeJS.Platform
): AgentProc | null {
  const argv = proc.argv
  if (argv.length === 0) return null
  const prog = base(argv[0])

  if (platform === 'linux') {
    const dirs = piAgentDirs(home)
    const h = home.replace(/\/+$/, '')
    const envDir = proc.env.PI_CODING_AGENT_DIR?.replace(/\/+$/, '')
    // bwrap's own argv carries the script too; only the node it runs counts.
    const isNode = prog === 'node' || prog === 'nodejs' || /^node\d*$/.test(prog)
    const script = argv[1] ?? ''
    // The process must look like pi itself, not a script pi's bash tool ran
    // (those inherit PI_CODING_AGENT_DIR too).
    const looksLikePi =
      prog === 'pi' || (isNode && (base(script) === 'pi' || base(script) === 'cli.js' || script.includes('/pi-coding-agent/')))
    let kind: 'jarvis' | 'ultron' | null = null
    if (looksLikePi && envDir === dirs.jarvis) kind = 'jarvis'
    else if (looksLikePi && envDir === dirs.ultron) kind = 'ultron'
    else if (isNode && script.startsWith(`${h}/local-ai/jarvis/pi/`)) kind = 'jarvis'
    else if (isNode && script === `${h}/.local/share/ultron/pi-cli/dist/bundle/cli.js`) kind = 'ultron'
    if (kind !== null && prog !== 'bwrap' && prog !== 'bash' && prog !== 'sh') {
      const piArgs = argv.slice(2)
      const explicitSid = sidFromSessionArg(kind, flagValue(piArgs, ['--session', '--session-id']))
      // The launcher (bash, its parent) holds the flags the user typed.
      const flags =
        kind === 'jarvis' && parent && parent.argv.some((a) => base(a) === 'jarvis')
          ? cleanAgentFlags('jarvis', parent.argv.slice(parent.argv.findIndex((a) => base(a) === 'jarvis') + 1))
          : []
      return {
        kind,
        pid: proc.pid,
        dataDir: envDir ?? dirs[kind],
        cwd: proc.cwd,
        startMs: proc.startMs,
        ...(explicitSid ? { explicitSid } : {}),
        reopened: hasFlag(piArgs, ['--continue', '-c', '--resume', '-r']),
        flags,
      }
    }
  }

  if (prog === 'opencode' || prog === '.opencode' || base(proc.exe ?? undefined) === 'opencode') {
    const args = argv.slice(1)
    const sub = args.find((a) => !a.startsWith('-'))
    // `opencode [project dir]` and `opencode run` are sessions; the rest are tools.
    if (sub !== undefined && OPENCODE_NOT_SESSION.has(sub)) return null
    const explicitSid = sidFromSessionArg('opencode', flagValue(args, ['--session', '-s']))
    return {
      kind: 'opencode',
      pid: proc.pid,
      dataDir: opencodeDataDir(home, proc.env.XDG_DATA_HOME),
      cwd: proc.cwd,
      startMs: proc.startMs,
      ...(explicitSid ? { explicitSid } : {}),
      reopened: hasFlag(args, ['--continue', '-c']),
      flags: [],
      ...(proc.exe ? { exe: proc.exe } : {}),
    }
  }
  return null
}

/** Whether a session counts as one `p` may be on: started after it did, or,
 *  for opencode and a pi that reopened an older session, written after. */
function isCandidate(p: AgentProc, c: SessionCandidate): boolean {
  if (p.startMs === null) return false
  const since = p.startMs - START_SKEW_MS
  if (c.startedMs >= since) return true
  return (p.kind === 'opencode' || p.reopened) && c.touchedMs >= since
}

/**
 * The session each live agent process is on. [pure]
 *
 * An id the command line names wins outright (a resumed session's file is
 * older than the process). Otherwise a process takes the most recently
 * written session that it could have created or reopened, and that no other
 * process has claimed. When another live process of the same agent shares
 * its data dir and cwd and could have been the one that created or last wrote
 * that session, the answer is ambiguous and the process gets nothing: a wrong
 * session in a pane is worse than a fresh one.
 *
 * `procs` should be every live process of these agents, not only the ones in
 * panes: a session someone else is on is never handed out.
 */
export function pickAgentSessions(
  procs: readonly AgentProc[],
  listFor: (p: AgentProc) => readonly SessionCandidate[]
): Map<number, string> {
  const out = new Map<number, string>()
  const holders = new Map<string, AgentProc[]>()
  for (const p of procs) {
    if (p.explicitSid && isValidAgentSessionId(p.kind, p.explicitSid)) {
      const key = `${p.kind}\0${p.explicitSid}`
      holders.set(key, [...(holders.get(key) ?? []), p])
    }
  }
  const claimed = new Set<string>()
  for (const [key, list] of holders) {
    claimed.add(key)
    // Two processes on one named session: the one started last went to it last.
    const newest = Math.max(...list.map((p) => p.startMs ?? 0))
    const winners = list.filter((p) => (p.startMs ?? 0) === newest)
    if (winners.length === 1) out.set(winners[0]!.pid, winners[0]!.explicitSid!)
  }

  const groups = new Map<string, AgentProc[]>()
  for (const p of procs) {
    if (p.explicitSid || p.cwd === null) continue
    const key = `${p.kind}\0${p.dataDir}\0${p.cwd}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }

  const picks = new Map<number, string>()
  for (const group of groups.values()) {
    for (const p of group) {
      const cands = listFor(p)
        .filter((c) => isValidAgentSessionId(p.kind, c.sid) && !claimed.has(`${p.kind}\0${c.sid}`))
        .filter((c) => isCandidate(p, c))
        .sort((a, b) => b.touchedMs - a.touchedMs)
      const best = cands[0]
      if (!best) continue
      const rivals = group.filter((q) => q !== p)
      const contested = rivals.some((q) => {
        if (q.startMs === null) return true
        const since = q.startMs - START_SKEW_MS
        return best.startedMs >= since || ((q.kind === 'opencode' || q.reopened) && best.touchedMs >= since)
      })
      if (!contested) picks.set(p.pid, best.sid)
    }
  }
  // One session picked for two processes cannot be right for both.
  const count = new Map<string, number>()
  for (const sid of picks.values()) count.set(sid, (count.get(sid) ?? 0) + 1)
  for (const [pid, sid] of picks) if (count.get(sid) === 1) out.set(pid, sid)
  return out
}

/** How far below the shell a pane's agent can sit (zsh, bwrap, bwrap, node is 3). */
export const AGENT_MAX_DEPTH = 6

/**
 * The shallowest agent under each pane's shell, and its depth. [pure]
 *
 * `classify` answers for one pid (null for anything that is not an agent);
 * two different agents at the same depth give nothing for that pane.
 */
export function findPaneAgents<T extends { kind: string }>(
  panes: readonly { paneId: string; shellPid: number | null }[],
  childrenOf: ReadonlyMap<number, readonly number[]>,
  classify: (pid: number) => T | null
): Map<string, { hit: T; depth: number }> {
  const out = new Map<string, { hit: T; depth: number }>()
  for (const pane of panes) {
    if (pane.shellPid === null || pane.shellPid <= 0) continue
    const seen = new Set<number>([pane.shellPid])
    let level: number[] = [pane.shellPid]
    for (let depth = 0; depth <= AGENT_MAX_DEPTH && level.length > 0; depth += 1) {
      const hits = level.map(classify).filter((h): h is T => h !== null)
      if (hits.length > 0) {
        if (new Set(hits.map((h) => h.kind)).size === 1) out.set(pane.paneId, { hit: hits[0]!, depth })
        break
      }
      const next: number[] = []
      for (const pid of level) {
        for (const child of childrenOf.get(pid) ?? []) {
          if (seen.has(child)) continue
          seen.add(child)
          next.push(child)
        }
      }
      level = next
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Session files
// ---------------------------------------------------------------------------

/** The `session` header pi writes as a session file's first line. [pure] */
export function parsePiHeader(line: string): { id: string; startedMs: number; cwd: string | null } | null {
  try {
    const h = JSON.parse(line) as { type?: unknown; id?: unknown; timestamp?: unknown; cwd?: unknown }
    if (h.type !== 'session' || typeof h.id !== 'string' || typeof h.timestamp !== 'string') return null
    const startedMs = Date.parse(h.timestamp)
    if (!Number.isFinite(startedMs)) return null
    return { id: h.id, startedMs, cwd: typeof h.cwd === 'string' ? h.cwd : null }
  } catch {
    return null
  }
}

async function readFirstLine(file: string, max = 8192): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(max)
    const { bytesRead } = await handle.read(buf, 0, max, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const nl = text.indexOf('\n')
    return nl < 0 ? text : text.slice(0, nl)
  } finally {
    await handle.close()
  }
}

/** One pi session file: its id, its header and its last write. */
export interface PiSessionFile extends SessionCandidate {
  file: string
  cwd: string | null
}

/** Every session pi has for `cwd` under `agentDir`, newest write first. */
export async function listPiSessions(agentDir: string, cwd: string): Promise<PiSessionFile[]> {
  const dir = path.join(agentDir, 'sessions', piSessionDirName(cwd))
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return []
  }
  const out: PiSessionFile[] = []
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const st = await fs.stat(file)
      const header = parsePiHeader(await readFirstLine(file))
      const fromName = UUID_IN_NAME.exec(name)?.[1]
      const sid = header?.id ?? fromName
      if (!sid) continue
      out.push({
        sid,
        file,
        cwd: header?.cwd ?? null,
        startedMs: header?.startedMs ?? st.birthtimeMs,
        touchedMs: st.mtimeMs,
      })
    } catch {
      /* vanished or unreadable mid-scan */
    }
  }
  return out.sort((a, b) => b.touchedMs - a.touchedMs)
}

/** The file of pi session `sid` for `cwd`, or null. */
export async function findPiSessionFile(agentDir: string, cwd: string, sid: string): Promise<string | null> {
  for (const f of await listPiSessions(agentDir, cwd)) if (f.sid === sid) return f.file
  return null
}

/** One opencode session row, as its database or `session list` gives it. */
export interface OpencodeSession extends SessionCandidate {
  directory: string
}

type SqliteRow = Record<string, unknown>
interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): SqliteRow[] }
  close(): void
}

/** node:sqlite where this Node has it (22.5 and later), else null. Loaded at
 *  run time so neither bundler has to know about it. */
function sqlite(): { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDb } | null {
  try {
    const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
    const mod = get?.('node:sqlite') as { DatabaseSync?: unknown } | undefined
    return mod && typeof mod.DatabaseSync === 'function'
      ? (mod as { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDb })
      : null
  } catch {
    return null
  }
}

/** Rows of `session` for `directory` from opencode's database, read-only; null when it cannot be read. */
export function opencodeSessionsFromDb(dbFile: string, directory: string): OpencodeSession[] | null {
  const lib = sqlite()
  if (!lib) return null
  let db: SqliteDb | null = null
  try {
    db = new lib.DatabaseSync(dbFile, { readOnly: true })
    const queries = [
      'SELECT id, directory, time_created, time_updated FROM session WHERE directory = ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 200',
      'SELECT id, directory, time_created, time_updated FROM session WHERE directory = ? ORDER BY time_updated DESC LIMIT 200',
    ]
    for (const sql of queries) {
      let rows: SqliteRow[]
      try {
        rows = db.prepare(sql).all(directory)
      } catch {
        continue
      }
      return rows.flatMap((r) =>
        typeof r.id === 'string' && typeof r.directory === 'string'
          ? [{ sid: r.id, directory: r.directory, startedMs: Number(r.time_created) || 0, touchedMs: Number(r.time_updated) || 0 }]
          : []
      )
    }
    return null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

/** `opencode session list --format json`'s rows. [pure] */
export function parseOpencodeSessionList(stdout: string): OpencodeSession[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r: unknown) => {
    const x = r as { id?: unknown; directory?: unknown; created?: unknown; updated?: unknown }
    if (typeof x?.id !== 'string' || typeof x.directory !== 'string') return []
    return [{ sid: x.id, directory: x.directory, startedMs: Number(x.created) || 0, touchedMs: Number(x.updated) || 0 }]
  })
}

/** Runs a program with an argv array (never a shell string), resolving its stdout or ''. */
export function runFile(file: string, args: string[], timeoutMs: number, maxBuffer = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout))
    })
  })
}

/** opencode's sessions for `directory`: the database, else its own CLI. */
export async function listOpencodeSessions(dataDir: string, directory: string, exe?: string): Promise<OpencodeSession[]> {
  const fromDb = opencodeSessionsFromDb(path.join(dataDir, 'opencode.db'), directory)
  if (fromDb !== null) return fromDb
  if (!exe) return []
  const rows = parseOpencodeSessionList(await runFile(exe, ['session', 'list', '--format', 'json', '-n', '200'], 15_000))
  return rows.filter((r) => r.directory === directory)
}

// ---------------------------------------------------------------------------
// /proc
// ---------------------------------------------------------------------------

/** Field 22 of /proc/<pid>/stat (start, clock ticks since boot). [pure] */
export function startTicksFromStat(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const v = stat.slice(close + 2).split(' ')[19]
  return v && /^\d+$/.test(v) ? Number(v) : null
}

/** `btime` from /proc/stat, seconds since the epoch. [pure] */
export function bootTimeFromProcStat(text: string): number | null {
  const m = /^btime\s+(\d+)$/m.exec(text)
  return m ? Number(m[1]) : null
}

/** USER_HZ; 100 on every Linux this runs on. */
const CLOCK_TICKS = 100

let bootSec: number | null | undefined

/** What /proc says about `pid`, or null when it is gone. Linux only. */
export async function linuxProcInfo(pid: number, wantDetail: boolean): Promise<ProcInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  let argv: string[]
  try {
    argv = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter((a, i, all) => a !== '' || i < all.length - 1)
  } catch {
    return null
  }
  if (!wantDetail) return { pid, argv, cwd: null, env: {}, startMs: null, exe: null }
  const read = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn()
    } catch {
      return null
    }
  }
  const [cwd, exe, environ, stat] = await Promise.all([
    read(() => fs.readlink(`/proc/${pid}/cwd`)),
    read(() => fs.readlink(`/proc/${pid}/exe`)),
    read(() => fs.readFile(`/proc/${pid}/environ`, 'utf8')),
    read(() => fs.readFile(`/proc/${pid}/stat`, 'utf8')),
  ])
  const env: Record<string, string> = {}
  for (const kv of (environ ?? '').split('\0')) {
    const eq = kv.indexOf('=')
    const k = eq > 0 ? kv.slice(0, eq) : ''
    if (k === 'PI_CODING_AGENT_DIR' || k === 'XDG_DATA_HOME') env[k] = kv.slice(eq + 1)
  }
  if (bootSec === undefined) bootSec = bootTimeFromProcStat((await read(() => fs.readFile('/proc/stat', 'utf8'))) ?? '')
  const ticks = stat ? startTicksFromStat(stat) : null
  const startMs = ticks !== null && bootSec !== null ? bootSec * 1000 + (ticks * 1000) / CLOCK_TICKS : null
  return {
    pid,
    argv,
    cwd: cwd && cwd.startsWith('/') ? cwd.replace(/ \(deleted\)$/, '') : null,
    env,
    startMs,
    exe: exe ? exe.replace(/ \(deleted\)$/, '') : null,
  }
}

/** The same from `ps` and `lsof`, for macOS (opencode is the only agent there). */
export async function darwinProcInfo(pid: number, wantDetail: boolean): Promise<ProcInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const args = (await runFile('/bin/ps', ['-o', 'args=', '-p', String(pid)], 5_000)).trim()
  if (!args) return null
  // ps joins argv with spaces; only the program and simple flags matter here.
  const argv = args.split(/\s+/)
  if (!wantDetail) return { pid, argv, cwd: null, env: {}, startMs: null, exe: null }
  const [lstart, lsof] = await Promise.all([
    runFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], 5_000),
    runFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], 5_000),
  ])
  const cwdLine = lsof.split('\n').find((l) => l.startsWith('n/'))
  const startMs = Date.parse(lstart.trim())
  return {
    pid,
    argv,
    cwd: cwdLine ? cwdLine.slice(1) : null,
    env: {},
    startMs: Number.isFinite(startMs) ? startMs : null,
    exe: argv[0] ?? null,
  }
}

// ---------------------------------------------------------------------------
// All together
// ---------------------------------------------------------------------------

/** What finding agents needs from the caller. */
export interface AgentLookupDeps {
  /** The Linux home the agents live under. */
  home: string
  platform: NodeJS.Platform
  /** /proc (or ps) for one pid; `detail` adds cwd, env, start and exe. */
  procInfo: (pid: number, detail: boolean) => Promise<ProcInfo | null>
  /** Every live pid and its parent, from the sweep. */
  parents: ReadonlyMap<number, number>
  childrenOf: ReadonlyMap<number, readonly number[]>
  /** The sweep's process name for a pid. Without it, nothing outside the
   *  panes is looked at (on macOS every look is a `ps` run). */
  commOf?: (pid: number) => string | undefined
  listPi?: (agentDir: string, cwd: string) => Promise<SessionCandidate[]>
  listOpencode?: (dataDir: string, cwd: string, exe?: string) => Promise<SessionCandidate[]>
}

/** A live agent in a pane: which, at what depth under the shell, and its session if one could be told. */
export interface PaneAgent {
  kind: OtherAgentKind
  depth: number
  pid: number
  sid?: string
  flags: string[]
  cwd: string | null
}

/** The most processes looked at under one pane, so a pane running a build of
 *  a thousand processes does not cost a thousand reads. */
const MAX_PROCS_PER_PANE = 96

/** Process names worth a closer look outside the panes. */
const AGENT_COMMS = /^(node\d*|nodejs|pi|opencode|\.opencode|jarvis|ultron)$/

/**
 * Every pane's agent (the non-claude ones) and the session it is on, plus
 * every session any live process of these agents holds (for the carried
 * lane: a session open elsewhere is never resumed into a pane).
 * `releasedPids` are processes in panes about to be killed; their sessions
 * count as free.
 */
export async function lookupPaneAgents(
  panes: readonly { paneId: string; shellPid: number | null }[],
  deps: AgentLookupDeps,
  options: { wantLiveSids?: ReadonlySet<OtherAgentKind>; releasedPids?: ReadonlySet<number> } = {}
): Promise<{ panes: Map<string, PaneAgent>; liveSids: Map<OtherAgentKind, Set<string>> }> {
  const brief = new Map<number, ProcInfo | null>()
  const detail = new Map<number, ProcInfo | null>()
  const info = async (pid: number, full: boolean): Promise<ProcInfo | null> => {
    const cache = full ? detail : brief
    if (!cache.has(pid)) cache.set(pid, await deps.procInfo(pid, full))
    return cache.get(pid) ?? null
  }

  const classified = new Map<number, AgentProc | null>()
  const classify = async (pid: number): Promise<AgentProc | null> => {
    if (classified.has(pid)) return classified.get(pid) ?? null
    let hit: AgentProc | null = null
    const quick = await info(pid, false)
    if (quick) {
      // On Linux the environment can name the agent when argv was retitled,
      // so every process gets the full read; elsewhere only a likely name does.
      const prog = base(quick.argv[0])
      if (deps.platform === 'linux' || AGENT_COMMS.test(prog)) {
        const full = await info(pid, true)
        const ppid = deps.parents.get(pid)
        const parent = ppid !== undefined ? await info(ppid, false) : null
        if (full) hit = classifyAgentProc(full, parent, deps.home, deps.platform)
      }
    }
    classified.set(pid, hit)
    return hit
  }

  // Under each pane: breadth first, capped.
  for (const pane of panes) {
    if (pane.shellPid === null || pane.shellPid <= 0) continue
    const sub: number[] = []
    const seen = new Set<number>([pane.shellPid])
    let level = [pane.shellPid]
    for (let d = 0; d <= AGENT_MAX_DEPTH && level.length > 0 && sub.length < MAX_PROCS_PER_PANE; d += 1) {
      sub.push(...level)
      const next: number[] = []
      for (const pid of level) {
        for (const c of deps.childrenOf.get(pid) ?? []) {
          if (seen.has(c)) continue
          seen.add(c)
          next.push(c)
        }
      }
      level = next
    }
    for (const pid of sub.slice(0, MAX_PROCS_PER_PANE)) await classify(pid)
  }
  const found = findPaneAgents(panes, deps.childrenOf, (pid) => classified.get(pid) ?? null)

  // Every live process of the agents in play: the pane ones, and for the
  // claimed check the rest of the table, narrowed by process name.
  const kinds = new Set<OtherAgentKind>([...[...found.values()].map((f) => f.hit.kind), ...(options.wantLiveSids ?? [])])
  if (kinds.size > 0 && deps.commOf) {
    for (const pid of deps.parents.keys()) {
      if (classified.has(pid)) continue
      const comm = base(deps.commOf(pid))
      if (!AGENT_COMMS.test(comm)) continue
      await classify(pid)
    }
  }
  // A process under another of the same agent is its tool run, never a second agent.
  const underSameAgent = (p: AgentProc): boolean => {
    let cur = deps.parents.get(p.pid)
    for (let i = 0; cur !== undefined && cur > 1 && i < 64; i += 1) {
      if (classified.get(cur)?.kind === p.kind) return true
      cur = deps.parents.get(cur)
    }
    return false
  }
  const procs = [...classified.values()].filter(
    (p): p is AgentProc => p !== null && kinds.has(p.kind) && !underSameAgent(p)
  )

  const lists = new Map<string, SessionCandidate[]>()
  for (const p of procs) {
    if (p.explicitSid || p.cwd === null) continue
    const key = `${p.kind}\0${p.dataDir}\0${p.cwd}`
    if (lists.has(key)) continue
    let rows: SessionCandidate[] = []
    try {
      if (p.kind === 'opencode') rows = deps.listOpencode ? await deps.listOpencode(p.dataDir, p.cwd, p.exe) : []
      else rows = deps.listPi ? await deps.listPi(p.dataDir, p.cwd) : []
    } catch {
      rows = []
    }
    lists.set(key, rows)
  }
  const sids = pickAgentSessions(procs, (p) => lists.get(`${p.kind}\0${p.dataDir}\0${p.cwd}`) ?? [])

  const out = new Map<string, PaneAgent>()
  for (const [paneId, { hit, depth }] of found) {
    const sid = sids.get(hit.pid)
    out.set(paneId, { kind: hit.kind, depth, pid: hit.pid, ...(sid ? { sid } : {}), flags: hit.flags, cwd: hit.cwd })
  }
  const liveSids = new Map<OtherAgentKind, Set<string>>()
  for (const p of procs) {
    if (options.releasedPids?.has(p.pid)) continue
    const sid = sids.get(p.pid) ?? p.explicitSid
    if (!sid) continue
    if (!liveSids.has(p.kind)) liveSids.set(p.kind, new Set())
    liveSids.get(p.kind)!.add(sid)
  }
  return { panes: out, liveSids }
}

export type { AgentKind }
