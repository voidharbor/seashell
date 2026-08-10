import fs from 'node:fs/promises'
import path from 'node:path'
import { isValidSessionId, transcriptDirFor } from './session-lookup.js'

/**
 * Recovering the permission mode a claude session was last running in, from
 * the session's own transcript.
 *
 * Why this exists: restore types `claude -r <id>` into a shell, and a bare
 * resume falls back to the user's settings defaultMode — which is not
 * necessarily how the pane was running when the project was saved. On a
 * machine whose default is dontAsk, every resumed agent came back with Bash
 * denied and no prompt ever shown. The transcript records the mode on every
 * message (and cycles as `permission-mode` events), so the last entry is the
 * session's own answer.
 *
 * The mode never enters the project file. It is re-read at open, so a project
 * saved months ago follows what the session was actually doing, and a
 * hand-edited project file has no mode field to lie in.
 */

/** The modes `claude --permission-mode` accepts, plus bypassPermissions which
 *  travels as its own flag. A transcript is a file on disk — anything outside
 *  this set is discarded, because the value ends up composed into a command
 *  typed into a shell. */
export const PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk',
  'manual',
  'plan',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

const MODE_SET: ReadonlySet<string> = new Set(PERMISSION_MODES)

/**
 * The last permission mode a transcript records, or null.
 *
 * Scans from the end: both `permission-mode` events and the `permissionMode`
 * field stamped on ordinary entries count, and the newest one wins. [pure]
 */
export function parseLastPermissionMode(lines: readonly string[]): PermissionMode | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i]
    if (!raw || !raw.includes('permissionMode')) continue
    try {
      const entry = JSON.parse(raw) as { permissionMode?: unknown }
      const mode = entry.permissionMode
      if (typeof mode === 'string' && MODE_SET.has(mode)) return mode as PermissionMode
    } catch {
      /* a torn or non-JSON line is not worth losing the scan over */
    }
  }
  return null
}

/** How much of the transcript tail to read. Modes are stamped on every
 *  message, so the answer is always near the end; a whole multi-MB transcript
 *  is never needed. */
const TAIL_BYTES = 256 * 1024

async function readTailLines(file: string): Promise<string[]> {
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    await handle.read(buf, 0, buf.length, start)
    return buf.toString('utf8').split('\n')
  } finally {
    await handle.close()
  }
}

export interface ResumePaneRef {
  paneId: string
  cwd: string
  sid: string
}

/** The last recorded mode per pane, for panes about to resume a session.
 *  Any per-pane failure just leaves that pane out — restore then types the
 *  bare resume it always did. */
export async function resumeModesForPanes(
  panes: readonly ResumePaneRef[]
): Promise<Record<string, PermissionMode>> {
  const out: Record<string, PermissionMode> = {}
  for (const pane of panes) {
    if (!isValidSessionId(pane.sid)) continue
    try {
      const file = path.join(transcriptDirFor(pane.cwd), `${pane.sid}.jsonl`)
      const mode = parseLastPermissionMode(await readTailLines(file))
      if (mode) out[pane.paneId] = mode
    } catch {
      /* no transcript, unreadable, whatever — bare resume still works */
    }
  }
  return out
}
