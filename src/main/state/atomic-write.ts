import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Write a file whole or not at all.
 *
 * Three things make that true, and each covers a different failure:
 *
 * - A temp name unique to this process and moment. Two writers racing on one
 *   fixed `.tmp` interleave their bytes into it and the second `rename` then
 *   fails on a file the first one already moved away.
 * - `fh.sync()`, so the temp file's bytes are on the disk before the rename
 *   makes them the file everyone reads.
 * - An fsync of the containing directory. `fh.sync()` says nothing about the
 *   directory entry the rename creates, so without this the rename itself is
 *   not durable and a crash at the wrong moment can leave the old file in
 *   place having reported success.
 *
 * Shared by the projects file and the last-session snapshot, which are the two
 * writes where a torn result silently loses the user's arrangement.
 */
export async function writeFileAtomic(target: string, body: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.round(Math.random() * 1e6)}`

  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(body, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }

  try {
    await fs.rename(tmp, target)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }

  try {
    const dh = await fs.open(path.dirname(target), 'r')
    await dh.sync()
    await dh.close()
  } catch {
    // Directory fsync is unsupported on some filesystems. The rename already
    // happened; losing only its durability guarantee is acceptable.
  }
}
