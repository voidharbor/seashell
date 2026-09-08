import fs from 'node:fs/promises'
import path from 'node:path'
import type { LastSession, SavedTab } from '../../shared/ipc.js'
import { writeFileAtomic } from './atomic-write.js'
import { isValidProject } from './store.js'

const FILE = 'last-session.json'
export const SCHEMA_VERSION = 1

// The shape is declared in the IPC contract, not here: the renderer receives it
// verbatim from `session:load`, and two structurally identical declarations are
// two things that can drift.
export type { LastSession }

/**
 * The window as it last stood, so a relaunch can offer it back. Same tab shape
 * as a project, validated by the same rule, and written through the same
 * atomic write, so a crash mid-write leaves the previous snapshot rather than
 * half of a new one, and so the 30 second timer and the snapshot quit forces
 * cannot interleave: ipcMain runs handlers concurrently, and two writers on
 * one fixed temp name produce a file that is half of each.
 */
export async function saveLastSession(tabs: SavedTab[], dir: string): Promise<void> {
  const body: LastSession = { schemaVersion: SCHEMA_VERSION, savedAt: new Date().toISOString(), tabs }
  await writeFileAtomic(path.join(dir, FILE), JSON.stringify(body, null, 2))
}

export async function loadLastSession(dir: string): Promise<LastSession | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, FILE), 'utf8')) as Partial<LastSession>
    if (raw?.schemaVersion !== SCHEMA_VERSION || typeof raw.savedAt !== 'string') return null
    if (!isValidProject({ id: 'last', name: 'last', savedAt: raw.savedAt, tabs: raw.tabs })) return null
    return { schemaVersion: SCHEMA_VERSION, savedAt: raw.savedAt, tabs: raw.tabs as SavedTab[] }
  } catch {
    return null
  }
}

export async function clearLastSession(dir: string): Promise<void> {
  await fs.rm(path.join(dir, FILE), { force: true })
}
