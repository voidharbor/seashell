import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SessionIdSource } from '../../shared/ipc.js'
import { claudeTitleFromLabel } from '../../shared/claude-title.js'

export { claudeTitleFromLabel }

/**
 * Maps live panes to the claude session ids running in them.
 *
 * Lanes, most trusted first, and a pane takes the first one that answers:
 *
 *  1. **process**: the claude process under the pane's own shell, and the
 *     session id claude itself records for that pid in ~/.claude/sessions/.
 *     claude rewrites that file on every session switch (resume, /clear,
 *     compact), and stamps it with the process start time so a file left by a
 *     dead process can never be mistaken for a live one. Depends on nothing
 *     but claude.
 *  2. **registry**: the c-assistant SessionStart hook's registry, keyed by
 *     SEASHELL_PANE_ID. Only as good as the hook, which misses often.
 *  3. **carried**: the id the pane already had (from a restore or an earlier
 *     save), kept when nothing better answers and no one else holds it. A pane
 *     that was right must never be overwritten by a worse guess.
 *  4. **title**: the pane title claude set ("✳ <session title>"), matched to
 *     exactly one transcript. Used at restore to repair a snapshot an older
 *     build wrote with guessed ids.
 *  5. **cwd**: the newest free transcript for the pane's directory, and only
 *     when the pane is the sole claimant in that directory. With two panes in
 *     one directory it is a recency lottery, and a wrong session in a pane is
 *     worse than a fresh one.
 *
 * The pickers are [pure] and deps-injected for tests; the fs wrapper at the
 * bottom feeds them the real registry, pid files and transcripts.
 */

/** claude session ids are UUIDs. Anything else in a registry entry or a
 *  project file is noise at best and an injection attempt at worst — the id
 *  is later composed into a command typed into a shell, so the allowlist
 *  here is what keeps that composition inert. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidSessionId(sid: unknown): sid is string {
  return typeof sid === 'string' && SESSION_ID_RE.test(sid)
}

export interface RegistryEntry {
  session_id?: unknown
  pane_id?: unknown
  pid?: unknown
  registered_at?: unknown
}

export function pickSessionIds(
  entries: RegistryEntry[],
  paneIds: string[],
  isPidAlive: (pid: number) => boolean
): Record<string, string> {
  const wanted = new Set(paneIds)
  const best = new Map<string, { sid: string; at: number }>()

  for (const e of entries) {
    if (typeof e.pane_id !== 'string' || !wanted.has(e.pane_id)) continue
    if (!isValidSessionId(e.session_id)) continue
    const pid = typeof e.pid === 'number' ? e.pid : -1
    if (pid <= 0 || !isPidAlive(pid)) continue
    const at = typeof e.registered_at === 'number' ? e.registered_at : 0
    const current = best.get(e.pane_id)
    if (!current || at > current.at) best.set(e.pane_id, { sid: e.session_id, at })
  }

  return Object.fromEntries([...best.entries()].map(([paneId, v]) => [paneId, v.sid]))
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface PaneRef {
  paneId: string
  cwd: string
}

/** One transcript claude wrote for a directory. */
export interface SessionFile {
  sid: string
  mtimeMs: number
}

/**
 * The fallback lane, for panes the registry could not resolve.
 *
 * The registry is only populated when the c-assistant SessionStart hook fires.
 * When it does not — hook not installed, hook failed, claude started before the
 * plugin did — every pane saves as a plain `claude` and reopening a project
 * hands back fresh sessions instead of the work that was in them.
 *
 * claude's own transcripts do not have that problem: it writes one per session
 * under ~/.claude/projects/<cwd with slashes turned to dashes>/, hook or no
 * hook. So an unresolved pane takes the newest session for its cwd, which is
 * the same one `/resume` would put at the top of the list.
 *
 * Only a pane that is alone in its directory is resolved this way. With two or
 * more, the newest transcript could belong to either, so neither gets one. A
 * pane left out restores as a plain `claude`, which is merely cold; a pane
 * handed someone else's session is wrong.
 *
 * [pure] — the directory listing is injected.
 */
export function pickFallbackSessionIds(
  panes: PaneRef[],
  resolved: Record<string, string>,
  listSessions: (cwd: string) => SessionFile[],
  excludeSids: ReadonlySet<string> = new Set()
): Record<string, string> {
  // `excludeSids` is every session known to be alive on screen right now. The
  // newest transcript for a directory is often a session already running in
  // another pane, and handing it out again would put two claudes on one
  // conversation.
  const taken = new Set([...Object.values(resolved), ...excludeSids])
  const byCwd = new Map<string, SessionFile[]>()
  const out: Record<string, string> = {}

  // Two unresolved panes in one directory cannot be told apart by directory.
  // Handing them "newest, then next newest" in pane order is how a whole window
  // of panes in ~ came back holding each other's sessions, so they get nothing.
  const rivals = new Map<string, number>()
  for (const pane of panes) {
    if (resolved[pane.paneId]) continue
    rivals.set(pane.cwd, (rivals.get(pane.cwd) ?? 0) + 1)
  }

  for (const pane of panes) {
    if (resolved[pane.paneId]) continue
    if ((rivals.get(pane.cwd) ?? 0) > 1) continue
    let candidates = byCwd.get(pane.cwd)
    if (!candidates) {
      // Newest first, and never trust a filename to be a session id.
      candidates = listSessions(pane.cwd)
        .filter((c) => isValidSessionId(c.sid))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      byCwd.set(pane.cwd, candidates)
    }
    const pick = candidates.find((c) => !taken.has(c.sid))
    if (!pick) continue
    taken.add(pick.sid)
    out[pane.paneId] = pick.sid
  }

  return out
}

/** claude stores a directory's transcripts under the path with every
 *  character that is not a letter or digit turned into a dash: slashes, but
 *  also spaces, dots and brackets ("Acme Widgets LLC" -> "Acme-Widgets-LLC"). */
export function transcriptDirFor(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

async function listSessionFiles(cwd: string): Promise<SessionFile[]> {
  const dir = transcriptDirFor(cwd)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: SessionFile[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const st = await fs.stat(path.join(dir, name))
      out.push({ sid: name.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs })
    } catch {
      /* a file that vanished mid-scan is not worth failing the save over */
    }
  }
  return out
}


// ---------------------------------------------------------------------------
// The process lane
// ---------------------------------------------------------------------------

/**
 * The process start time claude records as `procStart` on Linux: field 22 of
 * /proc/<pid>/stat, in clock ticks since boot. The name field can hold spaces
 * and parentheses, so fields are counted from the last `)`. [pure]
 */
export function procStartFromStat(stat: string): string | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  // After ") " comes field 3 (state), so field 22 is the 20th token.
  const value = stat.slice(close + 2).split(' ')[19]
  return value && /^\d+$/.test(value) ? value : undefined
}

/**
 * `ps -o pid=,lstart= -p a,b,c` run with LC_ALL=C TZ=UTC, which is exactly how
 * claude records `procStart` on macOS, one pid per line. [pure]
 */
export function parsePsLstart(stdout: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) out.set(Number(m[1]), m[2]!)
  }
  return out
}

/** A claude process known to be alive, and the session it is on right now.
 *  `at` is when the process started: of two holders of one session, the one
 *  started later is the one that went to it later. */
export interface LiveClaude {
  sid: string
  at: number
}

/**
 * The pid files under ~/.claude/sessions/ whose process is still the one that
 * wrote them. A pid file outlives its process (and pids get reused), so each
 * one has to match the live process start time the platform reports for its
 * pid; a file with no start time proves nothing and is dropped. [pure]
 */
export function liveSessionsFromPidFiles(
  files: readonly unknown[],
  startTokens: ReadonlyMap<number, string>
): Map<number, LiveClaude> {
  const out = new Map<number, LiveClaude>()
  for (const raw of files) {
    if (typeof raw !== 'object' || raw === null) continue
    const f = raw as { pid?: unknown; sessionId?: unknown; procStart?: unknown; updatedAt?: unknown; startedAt?: unknown }
    if (typeof f.pid !== 'number' || f.pid <= 0) continue
    if (!isValidSessionId(f.sessionId)) continue
    if (typeof f.procStart !== 'string' && typeof f.procStart !== 'number') continue
    const token = startTokens.get(f.pid)
    if (token === undefined || token !== String(f.procStart)) continue
    // startedAt, not updatedAt: updatedAt moves on every busy/idle flip, so it
    // says which holder was active last, not which one took the session last.
    const at =
      typeof f.startedAt === 'number' ? f.startedAt : typeof f.updatedAt === 'number' ? f.updatedAt : 0
    out.set(f.pid, { sid: f.sessionId, at })
  }
  return out
}

/** How far below the shell a pane's claude can sit (zsh -> claude is 1; a
 *  wrapper script adds one or two). */
const MAX_DEPTH = 6

/**
 * Maps each pane to the session of the claude running under its shell. [pure]
 *
 * The shallowest claude wins, so a `claude -p` the pane's claude spawned never
 * speaks for the pane. Two claudes at that same depth on different sessions
 * cannot be told apart and give nothing. One session live in two panes (a
 * `/resume` into a session another pane already holds) is kept only by the
 * pane that switched to it last; resuming it in both would put two claudes on
 * one conversation.
 */
export function pickProcessSessionIds(
  panes: readonly { paneId: string; shellPid: number | null }[],
  childrenOf: ReadonlyMap<number, readonly number[]>,
  live: ReadonlyMap<number, LiveClaude>
): Record<string, string> {
  const found = new Map<string, LiveClaude>()

  for (const pane of panes) {
    if (pane.shellPid === null || pane.shellPid <= 0) continue
    const seen = new Set<number>([pane.shellPid])
    let level: number[] = [pane.shellPid]
    for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth += 1) {
      const hits = level.map((pid) => live.get(pid)).filter((h): h is LiveClaude => h !== undefined)
      if (hits.length > 0) {
        if (new Set(hits.map((h) => h.sid)).size === 1) {
          found.set(pane.paneId, { sid: hits[0]!.sid, at: Math.max(...hits.map((h) => h.at)) })
        }
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

  const holders = new Map<string, { paneId: string; at: number }[]>()
  for (const [paneId, hit] of found) {
    holders.set(hit.sid, [...(holders.get(hit.sid) ?? []), { paneId, at: hit.at }])
  }
  const out: Record<string, string> = {}
  for (const [sid, list] of holders) {
    const newest = Math.max(...list.map((h) => h.at))
    const winners = list.filter((h) => h.at === newest)
    if (winners.length === 1) out[winners[0]!.paneId] = sid
  }
  return out
}

// ---------------------------------------------------------------------------
// The title lane
// ---------------------------------------------------------------------------

/** The titles a transcript's tail ends on: its last ai-title and its last
 *  custom-title (a /rename). Either is what claude shows as the pane title.
 *  [pure] */
export function parseLastTitles(lines: readonly string[]): string[] {
  let ai: string | undefined
  let custom: string | undefined
  for (let i = lines.length - 1; i >= 0 && (ai === undefined || custom === undefined); i -= 1) {
    const raw = lines[i]
    if (!raw || (!raw.includes('"ai-title"') && !raw.includes('"custom-title"'))) continue
    try {
      const e = JSON.parse(raw) as { type?: unknown; aiTitle?: unknown; customTitle?: unknown }
      if (ai === undefined && e.type === 'ai-title' && typeof e.aiTitle === 'string') ai = e.aiTitle
      if (custom === undefined && e.type === 'custom-title' && typeof e.customTitle === 'string') {
        custom = e.customTitle
      }
    } catch {
      /* a torn line is not worth the scan */
    }
  }
  return [ai, custom].filter((t): t is string => typeof t === 'string' && t !== '')
}

// ---------------------------------------------------------------------------
// All lanes together
// ---------------------------------------------------------------------------

// Declared in the IPC contract: the renderer reads it off the response.
export type { SessionIdSource }

export interface LookupPane {
  paneId: string
  cwd: string
  /** The id the pane already had: set by a restore or an earlier save. */
  knownSid?: string
  /** False when `knownSid` came from a snapshot an older build wrote, whose
   *  ids were guessed; such an id is kept only if the pane title confirms it. */
  knownVerified?: boolean
  /** The pane's own (non-custom) label, for the title lane. */
  label?: string
  /** Whether the pane is running claude, as far as the renderer knows. Only
   *  claude panes compete for the cwd lane; undefined counts as yes. */
  claude?: boolean
}

export interface ResolveInputs {
  panes: readonly LookupPane[]
  processIds: Readonly<Record<string, string>>
  registryIds: Readonly<Record<string, string>>
  /** Every session a live claude process is on right now, anywhere. */
  liveSids: ReadonlySet<string>
  listSessions: (cwd: string) => SessionFile[]
  titlesOf: (cwd: string, sid: string) => readonly string[]
  sidsTitled: (cwd: string, title: string) => readonly string[]
}

export interface ResolveResult {
  ids: Record<string, string>
  sources: Record<string, SessionIdSource>
}

/** Runs the lanes in trust order; see the top of this file. [pure] */
export function resolveSessionIds(input: ResolveInputs): ResolveResult {
  const ids: Record<string, string> = {}
  const sources: Record<string, SessionIdSource> = {}
  const claimed = new Set<string>()
  const assign = (paneId: string, sid: string, source: SessionIdSource): void => {
    ids[paneId] = sid
    sources[paneId] = source
    claimed.add(sid)
  }
  const open = (): LookupPane[] => input.panes.filter((p) => ids[p.paneId] === undefined)

  for (const p of input.panes) {
    const sid = input.processIds[p.paneId]
    if (isValidSessionId(sid) && !claimed.has(sid)) assign(p.paneId, sid, 'process')
  }

  for (const p of open()) {
    const sid = input.registryIds[p.paneId]
    if (isValidSessionId(sid) && !claimed.has(sid)) assign(p.paneId, sid, 'registry')
  }

  // Carry-forward. A session live in some process is not this pane's (its own
  // claude would have answered in the process lane), and resuming it here
  // would put two claudes on one conversation. Two panes carrying one id
  // cannot both be right, so neither keeps it.
  const carriers = new Map<string, number>()
  for (const p of open()) {
    if (isValidSessionId(p.knownSid)) carriers.set(p.knownSid, (carriers.get(p.knownSid) ?? 0) + 1)
  }
  for (const p of open()) {
    const sid = p.knownSid
    if (!isValidSessionId(sid)) continue
    if (claimed.has(sid) || input.liveSids.has(sid) || (carriers.get(sid) ?? 0) > 1) continue
    if (p.knownVerified === false) {
      const title = p.label ? claudeTitleFromLabel(p.label) : null
      if (!title || !input.titlesOf(p.cwd, sid).includes(title)) continue
    }
    assign(p.paneId, sid, 'carried')
  }

  // Title. A title shared by two panes, or by two transcripts, names nothing.
  const titled = open()
    .map((p) => ({ p, title: p.label ? claudeTitleFromLabel(p.label) : null }))
    .filter((x): x is { p: LookupPane; title: string } => x.title !== null)
  const titleRivals = new Map<string, number>()
  for (const { p, title } of titled) {
    const key = `${p.cwd}\0${title}`
    titleRivals.set(key, (titleRivals.get(key) ?? 0) + 1)
  }
  for (const { p, title } of titled) {
    if ((titleRivals.get(`${p.cwd}\0${title}`) ?? 0) > 1) continue
    const cands = input.sidsTitled(p.cwd, title)
    const sid = cands[0]
    if (cands.length !== 1 || !isValidSessionId(sid)) continue
    if (claimed.has(sid) || input.liveSids.has(sid)) continue
    assign(p.paneId, sid, 'title')
  }

  // cwd, last and narrowest: the only claude pane in its directory, counting
  // panes already resolved another way, and never one a verified save had
  // already left without an id. No id submitted for any pane is handed out
  // here, so an id refused as unconfirmed for one pane cannot land in another.
  const claudeIn = new Map<string, number>()
  for (const p of input.panes) {
    if (p.claude !== false) claudeIn.set(p.cwd, (claudeIn.get(p.cwd) ?? 0) + 1)
  }
  const guessable = open().filter(
    (p) =>
      p.knownSid === undefined &&
      p.knownVerified !== true &&
      p.claude !== false &&
      claudeIn.get(p.cwd) === 1
  )
  const submitted = input.panes.map((p) => p.knownSid).filter(isValidSessionId)
  const guessed = pickFallbackSessionIds(
    guessable,
    {},
    input.listSessions,
    new Set([...claimed, ...input.liveSids, ...submitted])
  )
  for (const [paneId, sid] of Object.entries(guessed)) assign(paneId, sid, 'cwd')

  return { ids, sources }
}

// ---------------------------------------------------------------------------
// The fs side
// ---------------------------------------------------------------------------

/** What the caller in main knows about the running app and the OS. */
export interface LookupDeps {
  /** The shell pid rooting a pane, or null when it has none (yet). */
  shellPidOf: (paneId: string) => number | null
  /** pid -> child pids, or null when the process table could not be read. */
  processChildren: () => Promise<ReadonlyMap<number, readonly number[]> | null>
  /** The live start token for each pid, in the form claude records it. */
  startTokens: (pids: number[]) => Promise<Map<number, string>>
}

async function readRegistry(): Promise<RegistryEntry[]> {
  const dir = path.join(os.homedir(), '.claude', 'session-registry')
  const entries: RegistryEntry[] = []
  try {
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        entries.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as RegistryEntry)
      } catch {
        /* one bad entry must not cost the rest */
      }
    }
  } catch {
    /* no registry at all */
  }
  return entries
}

async function readPidFiles(): Promise<unknown[]> {
  const dir = path.join(os.homedir(), '.claude', 'sessions')
  const out: unknown[] = []
  try {
    for (const name of await fs.readdir(dir)) {
      if (!/^\d+\.json$/.test(name)) continue
      try {
        out.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')))
      } catch {
        /* torn or vanished mid-scan */
      }
    }
  } catch {
    /* claude has never run here, or keeps its state elsewhere */
  }
  return out
}

/** Titles live at the very end of a transcript (claude re-stamps them as the
 *  session goes), so the tail is enough and a 60 MB transcript is never read. */
const TITLE_TAIL_BYTES = 128 * 1024

async function readTail(file: string, bytes: number): Promise<string[]> {
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await handle.read(buf, 0, buf.length, start)
    return buf.toString('utf8').split('\n')
  } finally {
    await handle.close()
  }
}

/** sid -> titles, for every transcript of one directory. */
async function titleIndex(cwd: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>()
  const dir = transcriptDirFor(cwd)
  for (const file of await listSessionFiles(cwd)) {
    if (!isValidSessionId(file.sid)) continue
    try {
      index.set(file.sid, parseLastTitles(await readTail(path.join(dir, `${file.sid}.jsonl`), TITLE_TAIL_BYTES)))
    } catch {
      /* unreadable transcript: it simply matches no title */
    }
  }
  return index
}

/** Every pid in the trees rooted at `roots`, roots included. */
function descendants(roots: number[], childrenOf: ReadonlyMap<number, readonly number[]>): Set<number> {
  const out = new Set<number>()
  const stack = [...roots]
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (out.has(pid)) continue
    out.add(pid)
    stack.push(...(childrenOf.get(pid) ?? []))
  }
  return out
}

/** Resolves session ids for the given panes through every lane. Any failure
 *  inside a lane just leaves that lane empty; a pane saved without an id
 *  restores as a plain claude, which still works.
 *
 *  `releasing` names live panes that are about to be killed (opening a project
 *  over the window): the sessions running in them are not "live elsewhere",
 *  because they are about to be free, and reopening the project you are in
 *  must resume them rather than bring every pane back cold. */
export async function sessionIdsForPanes(
  panes: LookupPane[],
  deps: LookupDeps,
  releasing: readonly string[] = []
): Promise<ResolveResult> {
  const entries = await readRegistry()
  const registryIds = pickSessionIds(
    entries,
    panes.map((p) => p.paneId),
    pidAlive
  )

  let processIds: Record<string, string> = {}
  const liveSids = new Set<string>(
    entries
      .filter((e) => typeof e.pid === 'number' && e.pid > 0 && pidAlive(e.pid))
      .map((e) => e.session_id)
      .filter(isValidSessionId)
  )
  try {
    const children = await deps.processChildren()
    // Liveness from pid files is only used when the process table was read
    // too: without it no pane's own claude could be told apart from one
    // running elsewhere, and every carried id would look taken.
    if (children) {
      const files = await readPidFiles()
      const pids = files
        .map((f) => (f as { pid?: unknown } | null)?.pid)
        .filter((p): p is number => typeof p === 'number' && p > 0)
      const live = liveSessionsFromPidFiles(files, await deps.startTokens(pids))
      // A process inside a pane that is about to be killed does not make its
      // session live elsewhere; any other holder still does.
      const released = descendants(
        releasing.map((id) => deps.shellPidOf(id)).filter((p): p is number => p !== null),
        children
      )
      for (const [pid, c] of live) if (!released.has(pid)) liveSids.add(c.sid)
      processIds = pickProcessSessionIds(
        panes.map((p) => ({ paneId: p.paneId, shellPid: deps.shellPidOf(p.paneId) })),
        children,
        live
      )
    }
  } catch {
    /* no process lane this time */
  }

  const needTitles = new Set(
    panes
      .filter((p) => !processIds[p.paneId] && p.label && claudeTitleFromLabel(p.label))
      .map((p) => p.cwd)
  )
  const titles = new Map<string, Map<string, string[]>>()
  for (const cwd of needTitles) titles.set(cwd, await titleIndex(cwd))

  // Only the cwd lane lists a directory, and only for a pane that never had an
  // id; a save of a window whose panes all resolved lists nothing.
  const files = new Map<string, SessionFile[]>()
  const listable = panes.filter((p) => p.knownSid === undefined && p.knownVerified !== true && p.claude !== false)
  for (const cwd of new Set(listable.map((p) => p.cwd))) files.set(cwd, await listSessionFiles(cwd))

  return resolveSessionIds({
    panes,
    processIds,
    registryIds,
    liveSids,
    listSessions: (cwd) => files.get(cwd) ?? [],
    titlesOf: (cwd, sid) => titles.get(cwd)?.get(sid) ?? [],
    sidsTitled: (cwd, title) =>
      [...(titles.get(cwd)?.entries() ?? [])].filter(([, t]) => t.includes(title)).map(([sid]) => sid),
  })
}
