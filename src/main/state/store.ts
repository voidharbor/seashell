import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Project, SavedTab } from '../../shared/ipc.js'

/**
 * Named projects — reopenable sets of tabs and panes (spec §11).
 *
 * What a project holds is a *layout*, never a session: no pty state, no pid, no
 * scrollback, no environment. A pane's processes die with the app and cannot be
 * brought back; what returns is the shape — which tabs existed, how they were
 * split, what each pane's directory was, and what it had been launched as.
 *
 * Scrollback is excluded deliberately rather than merely unimplemented. A
 * terminal buffer routinely contains API keys, tokens and customer data, and
 * persisting that to a plain JSON file is a real exposure to buy a nicety.
 */

const FILE = 'projects.json'

/** Bumped only on a breaking shape change; unknown versions are quarantined. */
export const SCHEMA_VERSION = 1

/** Enough for any real workflow, low enough that a runaway caller cannot grow
 *  the file without bound. */
export const MAX_PROJECTS = 50

export const MAX_NAME_LENGTH = 60

export interface ProjectsFile {
  schemaVersion: number
  projects: Project[]
}

function filePath(): string {
  return path.join(app.getPath('userData'), FILE)
}

/**
 * Atomic write, then an fsync of the containing directory.
 *
 * `fh.sync()` guarantees the temp file's bytes reached the disk; it says
 * nothing about the directory entry the rename creates. Without the directory
 * fsync the rename itself is not durable, so a crash at the wrong moment can
 * leave the old file in place having reported success. This is the one write in
 * the app where a torn result would silently lose the user's saved work.
 */
async function writeFileAtomic(body: string): Promise<void> {
  const target = filePath()
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`

  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(body, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }

  await fs.rename(tmp, target)

  try {
    const dh = await fs.open(path.dirname(target), 'r')
    await dh.sync()
    await dh.close()
  } catch {
    // Directory fsync is unsupported on some filesystems. The rename already
    // happened; losing only its durability guarantee is acceptable.
  }
}

/**
 * A missing file is first run, not a failure. A file that exists but does not
 * parse is renamed aside rather than deleted — it is the only debuggable
 * artifact of whatever went wrong, and a user's saved projects are worth more
 * than the tidiness of removing them.
 */
export async function loadProjects(): Promise<Project[]> {
  const target = filePath()

  let raw: string
  try {
    raw = await fs.readFile(target, 'utf8')
  } catch {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as ProjectsFile
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.projects)) {
      throw new Error('shape')
    }
    return parsed.projects.filter(isValidProject)
  } catch {
    await quarantine(target)
    return []
  }
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await writeFileAtomic(
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, projects } satisfies ProjectsFile, null, 2)
  )
}

async function quarantine(target: string): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.rename(target, target.replace(/\.json$/, `.corrupt-${stamp}.json`))
  } catch {
    /* nothing further to do; the caller falls back to an empty list regardless */
  }
}

/**
 * Structural validation only — enough that the renderer cannot be handed
 * something it will crash on. Anything questionable is dropped wholesale rather
 * than repaired, because a half-restored layout is harder to understand than a
 * missing one.
 */
export function isValidProject(value: unknown): value is Project {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<Project>

  if (typeof p.id !== 'string' || p.id === '') return false
  if (typeof p.name !== 'string' || p.name === '') return false
  if (typeof p.savedAt !== 'string') return false
  if (!Array.isArray(p.tabs) || p.tabs.length === 0) return false

  return p.tabs.every(isValidTab)
}

function isValidTab(tab: unknown): tab is SavedTab {
  if (typeof tab !== 'object' || tab === null) return false
  const t = tab as Partial<SavedTab>

  if (typeof t.id !== 'string' || typeof t.name !== 'string') return false
  if (typeof t.cwd !== 'string') return false
  if (typeof t.panes !== 'object' || t.panes === null) return false
  if (typeof t.tree !== 'object' || t.tree === null) return false

  for (const pane of Object.values(t.panes)) {
    if (typeof pane?.label !== 'string') return false
    if (pane.kind !== 'term' && pane.kind !== 'file' && pane.kind !== 'web') return false
    if (typeof pane.cwd !== 'string') return false
  }
  return true
}

/**
 * Saving by name, not by id, is the behaviour that matches how people think
 * about this: "save as Solar Bear" twice means one project called Solar Bear,
 * not two. An explicit id still wins, so renaming an existing project does not
 * silently fork it.
 */
export function upsertProject(existing: Project[], incoming: Project): Project[] {
  const byId = incoming.id
    ? existing.findIndex((p) => p.id === incoming.id)
    : -1
  const idx =
    byId >= 0
      ? byId
      : existing.findIndex((p) => p.name.toLowerCase() === incoming.name.toLowerCase())

  if (idx >= 0) {
    const next = [...existing]
    next[idx] = { ...incoming, id: existing[idx]!.id }
    return next
  }
  return [...existing, incoming]
}
