import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Reads and writes the saved window layout (spec §11).
 *
 * What this file holds is a *layout*, never a session: no pty state, no pid, no
 * scrollback, no environment. A pane's processes die with the app and cannot be
 * brought back; what returns is the shape — which tabs existed, how they were
 * split, what each pane's directory was, and what it had been launched as.
 *
 * Scrollback is deliberately excluded rather than merely unimplemented. A
 * terminal buffer routinely contains API keys, tokens and customer data, and
 * persisting that to a plain JSON file is a real exposure to buy a nicety.
 */

const FILE = 'state.json'

/** Bumped only on a breaking shape change; unknown versions are quarantined. */
export const SCHEMA_VERSION = 1

export interface SavedPane {
  label: string
  labelIsCustom: boolean
  kind: 'term' | 'file' | 'web'
  command: 'zsh' | 'claude' | 'cmd'
  commandText?: string
  cwd: string
  color?: string
  filePath?: string
  url?: string
}

export interface SavedTab {
  id: string
  name: string
  nameIsCustom: boolean
  cwd: string
  zoomedPaneId: string | null
  focusedPaneId: string | null
  tree: unknown
  panes: Record<string, SavedPane>
}

export interface SavedState {
  schemaVersion: number
  savedAt: string
  window: { width: number; height: number; x?: number; y?: number }
  activeTabId: string
  tabs: SavedTab[]
}

export type LoadResult =
  | { ok: true; state: SavedState }
  | { ok: false; reason: 'first-run' | 'corrupt' | 'unreadable' }

function statePath(): string {
  return path.join(app.getPath('userData'), FILE)
}

/**
 * Atomic write, then an fsync of the containing directory.
 *
 * `fh.sync()` guarantees the temp file's bytes reached the disk; it says
 * nothing about the directory entry the rename creates. Without the directory
 * fsync the rename itself is not durable, so a crash at the wrong moment can
 * leave the old file in place having reported success. This is the one write in
 * the app where a torn result would silently lose the user's layout.
 */
export async function saveState(state: SavedState): Promise<void> {
  const target = statePath()
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  const body = JSON.stringify(state, null, 2)

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
 * artifact of whatever went wrong, and its entire contents are a recreatable
 * window layout, so keeping it costs nothing.
 */
export async function loadState(): Promise<LoadResult> {
  const target = statePath()

  let raw: string
  try {
    raw = await fs.readFile(target, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'first-run' }
    return { ok: false, reason: 'unreadable' }
  }

  try {
    const parsed = JSON.parse(raw) as SavedState
    if (!isValidState(parsed)) throw new Error('shape')
    return { ok: true, state: parsed }
  } catch {
    await quarantine(target)
    return { ok: false, reason: 'corrupt' }
  }
}

async function quarantine(target: string): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.rename(target, target.replace(/\.json$/, `.corrupt-${stamp}.json`))
  } catch {
    /* nothing further to do; the caller falls back to defaults regardless */
  }
}

/**
 * Structural validation only — enough that the renderer cannot be handed
 * something it will crash on. Anything questionable is rejected wholesale
 * rather than repaired, because a half-restored layout is harder to understand
 * than a fresh one.
 */
export function isValidState(value: unknown): value is SavedState {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Partial<SavedState>

  if (s.schemaVersion !== SCHEMA_VERSION) return false
  if (typeof s.activeTabId !== 'string') return false
  if (!Array.isArray(s.tabs)) return false
  if (typeof s.window !== 'object' || s.window === null) return false
  if (!Number.isFinite(s.window.width) || !Number.isFinite(s.window.height)) return false

  for (const tab of s.tabs) {
    if (typeof tab?.id !== 'string' || typeof tab.name !== 'string') return false
    if (typeof tab.cwd !== 'string') return false
    if (typeof tab.panes !== 'object' || tab.panes === null) return false
    if (typeof tab.tree !== 'object' || tab.tree === null) return false

    for (const pane of Object.values(tab.panes)) {
      if (typeof pane?.label !== 'string') return false
      if (pane.kind !== 'term' && pane.kind !== 'file' && pane.kind !== 'web') return false
      if (typeof pane.cwd !== 'string') return false
    }
  }

  return true
}
