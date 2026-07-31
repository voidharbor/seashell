/**
 * Text-file reading for the in-app viewer, with binary and size guards so
 * the viewer never has to render (or the IPC channel ship) something it
 * can't safely display.
 *
 * Binary detection happens before any decoding is attempted: scanning raw
 * bytes for a NUL is cheap and unambiguous, whereas trying to `toString`
 * arbitrary bytes as UTF-8 first and inspecting the result for replacement
 * characters is both slower and less reliable.
 */

import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as path from 'node:path'
import type { FsReadTextFileRequest, FsReadTextFileResponse } from '../../shared/ipc.js'

/** Bytes scanned for a NUL byte before any decoding is attempted. */
export const SNIFF_BYTES = 8192

/**
 * Line-count ceiling above which the viewer truncates with a banner rather
 * than rendering (and shipping over IPC) an unbounded number of lines —
 * the spec's own threshold for the in-app viewer.
 */
export const MAX_TEXT_LINES = 200_000

type ReadTextErrorCode = 'EBINARY' | 'ETOOBIG' | 'ENOENT' | 'EACCES'

/**
 * Reads `req.path` as text, refusing anything that looks binary or exceeds
 * `req.maxBytes`. `req.path` is resolved and realpath'ed before use — the
 * renderer supplies it, and is never trusted to have done that itself.
 */
export async function readTextFile(req: FsReadTextFileRequest): Promise<FsReadTextFileResponse> {
  const resolved = path.resolve(req.path)

  let real: string
  try {
    real = await fsp.realpath(resolved)
  } catch (err) {
    return errResult(err)
  }

  let handle: FileHandle
  try {
    handle = await fsp.open(real, 'r')
  } catch (err) {
    return errResult(err)
  }

  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      return { ok: false, code: 'ENOENT', message: `Not a regular file: ${real}` }
    }

    const sniffLen = Math.min(SNIFF_BYTES, stat.size)
    if (sniffLen > 0) {
      const sniffBuf = Buffer.alloc(sniffLen)
      await handle.read(sniffBuf, 0, sniffLen, 0)
      if (sniffBuf.includes(0)) {
        return { ok: false, code: 'EBINARY', message: `Binary content detected: ${real}` }
      }
    }

    if (stat.size > req.maxBytes) {
      return {
        ok: false,
        code: 'ETOOBIG',
        message: `File is ${stat.size} bytes, over the ${req.maxBytes}-byte limit`,
      }
    }

    const buf = Buffer.alloc(stat.size)
    if (stat.size > 0) {
      await handle.read(buf, 0, stat.size, 0)
    }
    const fullText = buf.toString('utf8')

    const { text, lines, truncated } = capLines(fullText, MAX_TEXT_LINES)

    return { ok: true, text, lines, size: stat.size, truncated }
  } finally {
    await handle.close()
  }
}

/**
 * Caps `text` at `maxLines` lines, cutting exactly on a line boundary so a
 * truncated file never ends mid-line. Scans once for the count and, only if
 * over the cap, a second time to find the cut point — both linear passes
 * over text that's already bounded to `maxBytes` by the caller.
 */
function capLines(text: string, maxLines: number): { text: string; lines: number; truncated: boolean } {
  if (text.length === 0) return { text, lines: 0, truncated: false }

  let newlineCount = 0
  for (let idx = 0; idx < text.length; idx++) {
    if (text[idx] === '\n') newlineCount++
  }
  const totalLines = newlineCount + 1

  if (totalLines <= maxLines) {
    return { text, lines: totalLines, truncated: false }
  }

  let seen = 0
  let cutAt = -1
  for (let idx = 0; idx < text.length; idx++) {
    if (text[idx] === '\n') {
      seen++
      if (seen === maxLines) {
        cutAt = idx
        break
      }
    }
  }
  // totalLines > maxLines guarantees at least maxLines newlines exist, so cutAt is always found.
  const cut = cutAt === -1 ? text.length : cutAt + 1
  return { text: text.slice(0, cut), lines: maxLines, truncated: true }
}

function errResult(err: unknown): FsReadTextFileResponse {
  const code = errnoCode(err)
  const mapped: ReadTextErrorCode =
    code === 'EACCES' || code === 'EPERM'
      ? 'EACCES'
      : code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP'
        ? 'ENOENT'
        : 'ENOENT' // unrecognized errno: treat as "couldn't find/read it" rather than invent a fifth code
  return { ok: false, code: mapped, message: describeError(err) }
}

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'Unknown filesystem error'
}
