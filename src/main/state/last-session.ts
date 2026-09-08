import fs from 'node:fs/promises'
import path from 'node:path'
import type { LastSession, SavedTab } from '../../shared/ipc.js'
import { isValidProject } from './store.js'

const FILE = 'last-session.json'
export const SCHEMA_VERSION = 1

// The shape is declared in the IPC contract, not here: the renderer receives it
// verbatim from `session:load`, and two structurally identical declarations are
// two things that can drift.
export type { LastSession }

/**
 * The window as it last stood, so a relaunch can offer it back. Same tab shape
 * as a project, validated by the same rule, written atomically so a crash
 * mid-write leaves the previous snapshot rather than half of a new one.
 */
export async function saveLastSession(tabs: SavedTab[], dir: string): Promise<void> {
  const file = path.join(dir, FILE)
  const tmp = `${file}.tmp`
  const body: LastSession = { schemaVersion: SCHEMA_VERSION, savedAt: new Date().toISOString(), tabs }
  await fs.writeFile(tmp, JSON.stringify(body, null, 2))
  await fs.rename(tmp, file)
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
