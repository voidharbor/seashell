// Types for make-session.mjs, so the unit tests typecheck.
import type { SavedTab } from '../../src/shared/ipc.js'
export function buildW10(cwd?: string): { schemaVersion: 1; savedAt: string; tabs: SavedTab[] }
