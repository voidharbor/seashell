import fs from 'node:fs/promises'
import path from 'node:path'
import { isValidAgentSessionId } from '../../shared/agents.js'
import { findPiSessionFile, piAgentDirs, runFile } from '../state/agents.js'
import { transcriptDirFor } from '../state/session-lookup.js'
import { claudeFileOps, opencodeFileOps, piFileOps } from './records.js'
import { jsonlRecord, type RecordSource, type TrackedSession } from './tracker.js'

/** How often opencode's record is exported at most: a long session's export is over a megabyte and takes seconds. */
const OPENCODE_EXPORT_MIN_MS = 10_000

/** Where opencode is usually installed, then every PATH entry. */
async function findOpencode(home: string): Promise<string | null> {
  const dirs = [
    `${home}/.local/bin`,
    `${home}/.opencode/bin`,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    ...(process.env.PATH ?? '').split(':').filter((d) => d.startsWith('/')),
  ]
  for (const d of dirs) {
    const f = path.join(d, 'opencode')
    try {
      await fs.access(f, fs.constants.X_OK)
      return f
    } catch {
      /* next */
    }
  }
  return null
}

/**
 * The record of one session on this machine: claude's transcript, pi's
 * session file (jarvis, ultron) or opencode's export. Null for a session
 * whose id is unknown, which is then watched through the filesystem only.
 * `claudeHome` is where `.claude/` lives when it is not `home`.
 */
export function recordSourceFor(session: TrackedSession, home: string, now: () => number, claudeHome?: string): RecordSource | null {
  const { kind, sid, cwd } = session
  if (!sid || !isValidAgentSessionId(kind, sid)) return null
  if (kind === 'claude') {
    return jsonlRecord(async () => path.join(transcriptDirFor(cwd, claudeHome ?? home), `${sid}.jsonl`), claudeFileOps)
  }
  if (kind === 'jarvis' || kind === 'ultron') {
    return jsonlRecord(() => findPiSessionFile(piAgentDirs(home)[kind], cwd, sid), piFileOps)
  }
  let last = 0
  let exe: string | null | undefined
  return {
    async read() {
      if (now() - last < OPENCODE_EXPORT_MIN_MS) return { ops: [], whole: false }
      last = now()
      exe ??= await findOpencode(home)
      if (!exe) return { ops: [], whole: false }
      const out = await runFile(exe, ['export', sid], 30_000, 64 * 1024 * 1024)
      const start = out.indexOf('{')
      if (start < 0) return { ops: [], whole: false }
      try {
        return { ops: opencodeFileOps(JSON.parse(out.slice(start))), whole: true }
      } catch {
        return { ops: [], whole: false }
      }
    },
  }
}
