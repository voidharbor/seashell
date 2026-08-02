import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Maps live panes to the claude session ids running in them, using the
 * session registry the c-assistant SessionStart hook maintains
 * (~/.claude/session-registry/, one JSON file per session). That hook
 * re-registers on resume, /clear and compact, so the NEWEST registration per
 * pane is the session actually on screen — saving a project must capture
 * that one, not the id the pane started the week with.
 *
 * `pickSessionIds` is [pure] and deps-injected for tests; the fs wrapper
 * below feeds it the real registry.
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
 * Two panes in one directory must never be handed the same session, so an id is
 * consumed once and the next pane falls to the one below it. A pane with
 * nothing left is simply left out and restores as a plain `claude` — the old
 * behaviour, which still works.
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

  for (const pane of panes) {
    if (resolved[pane.paneId]) continue
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

/** claude stores a directory's transcripts under the path with every slash
 *  turned into a dash. */
export function transcriptDirFor(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'))
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

/** Resolves session ids for the given panes: the registry first, since it knows
 *  exactly which session is in which pane, then claude's own transcripts for
 *  whatever is left. Any failure is an empty map — a project saved without ids
 *  restores plain claude panes, which still works. */
export async function sessionIdsForPanes(panes: PaneRef[]): Promise<Record<string, string>> {
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
    /* no registry at all: the fallback below is the whole answer */
  }

  const resolved = pickSessionIds(
    entries,
    panes.map((p) => p.paneId),
    pidAlive
  )

  // Listed once per distinct cwd, then handed to the pure picker.
  const cache = new Map<string, SessionFile[]>()
  for (const cwd of new Set(panes.filter((p) => !resolved[p.paneId]).map((p) => p.cwd))) {
    cache.set(cwd, await listSessionFiles(cwd))
  }

  // Sessions with a living process are already on screen somewhere, so they are
  // not free for a restored pane to claim.
  const liveSids = new Set(
    entries
      .filter((e) => typeof e.pid === 'number' && e.pid > 0 && pidAlive(e.pid))
      .map((e) => e.session_id)
      .filter(isValidSessionId)
  )

  return {
    ...resolved,
    ...pickFallbackSessionIds(panes, resolved, (cwd) => cache.get(cwd) ?? [], liveSids),
  }
}
