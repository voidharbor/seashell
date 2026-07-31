/**
 * Bulk path verification for the terminal-output linkifier.
 *
 * The tokenizer (renderer, pure) turns terminal text into path *candidates*
 * long before it knows whether any of them are real — most words on a
 * screen are prose, not paths. This is the one main-process round trip that
 * settles the question, so it exists to be nearly free even when almost
 * every candidate is a miss: misses are omitted from the response rather
 * than represented as null results, because a screen full of prose must
 * cost the caller (and the wire) almost nothing.
 */

import { promises as fsp } from 'node:fs'
import type { Stats } from 'node:fs'
import * as path from 'node:path'
import type { FsStatBatchRequest, FsStatBatchResponse, FsStatBatchResult } from '../../shared/ipc.js'

/**
 * Hard cap enforced here regardless of what the renderer sends. The
 * renderer is expected to stay at or below this already (it's part of the
 * IPC contract), but main never trusts the renderer to have done that —
 * a bug or a runaway paste shouldn't be able to turn one call into an
 * unbounded stat storm.
 */
export const MAX_CANDIDATES = 512

/**
 * Resolves each candidate against `cwd`, follows it through `realpath` (so
 * the reported path is canonical and symlink targets are what actually get
 * classified), then `lstat`s the result. Every path a renderer supplies is
 * untrusted input, so nothing here is assumed absolute or existing until
 * proven so by the filesystem itself.
 */
export async function statBatch(req: FsStatBatchRequest): Promise<FsStatBatchResponse> {
  const cwdAbs = path.resolve(req.cwd)
  const candidates = req.candidates.slice(0, MAX_CANDIDATES)

  const settled = await Promise.all(candidates.map((candidate, i) => statOne(cwdAbs, candidate, i)))

  const results: FsStatBatchResult[] = []
  for (const r of settled) {
    if (r !== undefined) results.push(r)
  }
  return { results }
}

async function statOne(cwdAbs: string, candidate: string, i: number): Promise<FsStatBatchResult | undefined> {
  const resolved = path.resolve(cwdAbs, candidate)
  // path.resolve() against an absolute cwd always yields an absolute path;
  // this check is a defensive backstop, not something expected to ever trip.
  if (!path.isAbsolute(resolved)) return undefined

  let real: string
  try {
    real = await fsp.realpath(resolved)
  } catch {
    return undefined // doesn't exist, a symlink cycle, permission denied, etc. — just a miss
  }

  let stat: Stats
  try {
    stat = await fsp.lstat(real)
  } catch {
    return undefined
  }

  const kind: FsStatBatchResult['kind'] = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other'
  const exec = (stat.mode & 0o111) !== 0

  return { i, resolved: real, kind, size: stat.size, exec }
}
