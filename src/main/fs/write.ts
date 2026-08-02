/**
 * Text-file writing for the editable preview — the only write path in the
 * app, so every refusal that keeps it honest lives here, not in the
 * renderer:
 *
 *  - **scope**: the realpath'd target must live under `scopeDir` (the
 *    directory the explorer is rooted at). A symlink inside scope pointing
 *    outside it resolves outside and is refused — the editor must never be
 *    a write primitive to the rest of the disk.
 *  - **existing files only**: the preview opens files that exist; a write
 *    to a path that does not is a request this module never receives
 *    legitimately, so it is refused rather than a create.
 *  - **text only**: the same NUL sniff read.ts uses. A binary refused by
 *    the reader must be equally unwritable, or a stale renderer could
 *    replace a binary with whatever its textarea holds.
 *  - **no clobbering**: the caller passes the mtime it loaded at; a
 *    mismatch means the file changed on disk underneath the editor and the
 *    write is refused, edits intact on the caller's side.
 *
 * The write itself is temp-file + rename in the target's own directory, so
 * a crash mid-write can never leave a half-written file, and the original
 * mode is copied onto the temp file before the swap.
 */

import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { FsWriteTextFileRequest, FsWriteTextFileResponse } from '../../shared/ipc.js'
import { SNIFF_BYTES } from './read.js'
import { VIEWER_MAX_BYTES } from './route.js'

export async function writeTextFile(
  req: FsWriteTextFileRequest,
  scopeDir: string
): Promise<FsWriteTextFileResponse> {
  if (req.text.length > VIEWER_MAX_BYTES) {
    return { ok: false, code: 'ETOOBIG', message: 'text exceeds the viewer size limit' }
  }

  let real: string
  let scopeReal: string
  try {
    real = await fsp.realpath(path.resolve(req.path))
  } catch {
    return { ok: false, code: 'ENOENT', message: 'file not found' }
  }
  try {
    scopeReal = await fsp.realpath(path.resolve(scopeDir))
  } catch {
    return { ok: false, code: 'ESCOPE', message: 'scope directory not found' }
  }

  if (real !== scopeReal && !real.startsWith(scopeReal + path.sep)) {
    return { ok: false, code: 'ESCOPE', message: 'file is outside the editable scope' }
  }

  let stat
  try {
    stat = await fsp.stat(real)
  } catch {
    return { ok: false, code: 'ENOENT', message: 'file not found' }
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'ENOENT', message: 'not a regular file' }
  }

  // Same verdict as the reader: NUL in the head means binary.
  try {
    const handle = await fsp.open(real, 'r')
    try {
      const sniffLen = Math.min(SNIFF_BYTES, stat.size)
      if (sniffLen > 0) {
        const buf = Buffer.alloc(sniffLen)
        await handle.read(buf, 0, sniffLen, 0)
        if (buf.includes(0)) {
          return { ok: false, code: 'EBINARY', message: 'refusing to overwrite a binary file' }
        }
      }
    } finally {
      await handle.close()
    }
  } catch (err) {
    return { ok: false, code: mapErrno(err), message: 'could not read the file' }
  }

  // Checked last, directly before the swap, to keep the lost-update window
  // as small as a stat-then-rename can be.
  if (stat.mtimeMs !== req.expectedMtimeMs) {
    return { ok: false, code: 'ECONFLICT', message: 'file changed on disk since it was loaded' }
  }

  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.seashell-save-${process.pid}`)
  try {
    await fsp.writeFile(tmp, req.text, { encoding: 'utf8', mode: stat.mode & 0o777 })
    // writeFile's mode only applies on create and is masked by umask; make
    // the copy exact before the swap.
    await fsp.chmod(tmp, stat.mode & 0o777)
    await fsp.rename(tmp, real)
  } catch (err) {
    try {
      await fsp.rm(tmp, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    return { ok: false, code: mapErrno(err), message: 'could not write the file' }
  }

  const after = await fsp.stat(real)
  return { ok: true, mtimeMs: after.mtimeMs }
}

function mapErrno(err: unknown): 'EACCES' | 'ENOENT' {
  const code =
    err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
  return code === 'EACCES' || code === 'EPERM' ? 'EACCES' : 'ENOENT'
}
