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

/** Reads the registry and resolves session ids for the given panes. Any
 *  failure — no registry, unreadable entries — is an empty map: a project
 *  saved without ids restores plain claude panes, which still works. */
export async function sessionIdsForPanes(paneIds: string[]): Promise<Record<string, string>> {
  const dir = path.join(os.homedir(), '.claude', 'session-registry')
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return {}
  }
  const entries: RegistryEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      entries.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as RegistryEntry)
    } catch {
      /* one bad entry must not cost the rest */
    }
  }
  return pickSessionIds(entries, paneIds, pidAlive)
}
