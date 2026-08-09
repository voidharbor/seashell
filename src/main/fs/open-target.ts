/**
 * What a path really points at, for the two places that decide whether opening
 * it is safe.
 *
 * `denyOpenPath` documents its own precondition — "every path must be
 * realpath'ed before reaching this guard" — and both callers were handing it an
 * unresolved path. That is not a cosmetic gap. Every input the guard reasons
 * about is derived from the link rather than its target:
 *
 *   - `lstat` on a symlink reports `isFile() === false`, so the executable bit
 *     is forced false and the "executable and not a known-safe document" rule
 *     never fires;
 *   - `isDirectory()` is false, so the "a directory is never opened, only
 *     revealed" rule is skipped;
 *   - the extension is read off the link's own name, so `notes.txt -> pwn.command`
 *     never meets DENY_EXTENSIONS;
 *   - `isUnderDev` cannot see a link that points into /dev.
 *
 * `shell.openPath` then hands the path to LaunchServices, which *does* follow
 * the link. So the guard inspected one file and the system opened another.
 *
 * The realpath is unconditional rather than gated on `isSymbolicLink()`, which
 * looks like it would be enough and is not: `lstat` follows symlinked *parents*
 * and only leaves the final component unresolved. With `~/mydev -> /dev`, the
 * path `~/mydev/disk0` lstats as a character device with `isSymbolicLink()`
 * false, and a gated realpath would skip straight past every rule above.
 */

import { promises as fsp } from 'node:fs'

export interface OpenTarget {
  /** Canonical path, or the path as given when it could not be resolved. */
  real: string
  isDir: boolean
  isExecutable: boolean
  size: number
  /**
   * True when the link could not be followed — dangling, or a permission wall
   * partway down. The lstat-derived answer is reported instead, because a
   * target that does not exist cannot launder anything, and callers that
   * already render the row should not suddenly be told it is missing.
   */
  unresolved: boolean
}

function fromStats(real: string, st: { mode: number; size: number; isFile(): boolean; isDirectory(): boolean }, unresolved: boolean): OpenTarget {
  return {
    real,
    isDir: st.isDirectory(),
    isExecutable: (st.mode & 0o111) !== 0 && st.isFile(),
    size: st.size,
    unresolved,
  }
}

/**
 * Resolve → lstat → realpath → lstat, best effort.
 *
 * Throws only when the path itself does not exist, which both callers already
 * treat as "not found". A failed *realpath* is not an error: it falls back to
 * what the first lstat said.
 */
export async function statForOpen(abs: string): Promise<OpenTarget> {
  const st = await fsp.lstat(abs)

  let real: string
  try {
    real = await fsp.realpath(abs)
  } catch {
    return fromStats(abs, st, true)
  }
  if (real === abs) return fromStats(abs, st, false)

  try {
    return fromStats(real, await fsp.lstat(real), false)
  } catch {
    return fromStats(abs, st, true)
  }
}
