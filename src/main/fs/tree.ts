/**
 * Lazy, one-directory-at-a-time listing for the file explorer sidebar.
 *
 * Never recurses — the explorer expands one `fs:readDir` per opened
 * directory, so this module only ever has to be correct about a single
 * level. Every incoming path is resolved and realpath'ed before touching
 * the disk because the renderer is never an authority on paths (a dropped
 * or typed path could point anywhere); listing itself always uses `lstat`
 * so a symlink is reported as a symlink instead of silently being followed
 * into whatever it points at.
 */

import { existsSync, readFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import type { Stats } from 'node:fs'
import * as path from 'node:path'
import type { FsDirEntry, FsReadDirRequest, FsReadDirResponse } from '../../shared/ipc.js'
import { ALWAYS_HIDDEN_NAMES, GitignoreEngine, type GitignoreFs } from './gitignore.js'

/**
 * Above this many entries, the directory is reported truncated and the
 * renderer shows a "Show all N entries" row instead of rendering everything
 * at once — matches the spec's stated cap for the explorer.
 */
export const MAX_DIR_ENTRIES = 5000

/** Real-fs-backed bridge for GitignoreEngine, using sync reads because .gitignore files are tiny and this runs once per expanded directory, not per frame. */
const nodeGitignoreFs: GitignoreFs = {
  readGitignore(dirAbsPath: string): string | undefined {
    try {
      return readFileSync(path.join(dirAbsPath, '.gitignore'), 'utf8')
    } catch {
      return undefined
    }
  },
  hasDotGit(dirAbsPath: string): boolean {
    return existsSync(path.join(dirAbsPath, '.git'))
  },
}

/** One engine per process — its per-directory caches are exactly what makes repeat listings of the same directory cheap. */
const gitignoreEngine = new GitignoreEngine(nodeGitignoreFs)

/** Exposed so a directory-change notification (from the watcher, out of this module's scope) can drop stale gitignore state. */
export function invalidateGitignoreCache(dirAbsPath: string): void {
  gitignoreEngine.invalidate(dirAbsPath)
}

const READDIR_ERROR_CODES = ['ENOENT', 'EACCES', 'ENOTDIR', 'ELOOP'] as const
type ReadDirErrorCode = (typeof READDIR_ERROR_CODES)[number]

/**
 * Lists the direct children of `req.path`. Directories sort before files;
 * both groups sort case-insensitively, matching how Finder-like explorers
 * read to users.
 */
export async function readDir(req: FsReadDirRequest): Promise<FsReadDirResponse> {
  const resolved = path.resolve(req.path)

  let real: string
  try {
    real = await fsp.realpath(resolved)
  } catch (err) {
    return errResult(err)
  }

  let names: string[]
  try {
    names = await fsp.readdir(real)
  } catch (err) {
    return errResult(err)
  }

  const withStats: Array<{ name: string; abs: string; stat: Stats }> = []
  for (const name of names) {
    if (ALWAYS_HIDDEN_NAMES.has(name)) continue
    const abs = path.join(real, name)
    try {
      const stat: Stats = await fsp.lstat(abs)
      withStats.push({ name, abs, stat })
    } catch {
      // Vanished between readdir and lstat, or unreadable on its own — drop this one entry rather than fail the whole listing.
      continue
    }
  }

  withStats.sort((a, b) => {
    const aDir = a.stat.isDirectory()
    const bDir = b.stat.isDirectory()
    if (aDir !== bDir) return aDir ? -1 : 1
    return compareCaseInsensitive(a.name, b.name)
  })

  const truncated = withStats.length > MAX_DIR_ENTRIES
  const visible = truncated ? withStats.slice(0, MAX_DIR_ENTRIES) : withStats

  const entries: FsDirEntry[] = visible.map(({ name, abs, stat }) => {
    const isDir = stat.isDirectory()
    const ignored = req.respectGitignore ? gitignoreEngine.isIgnored(real, abs, isDir) : false
    return {
      name,
      isDir,
      isSymlink: stat.isSymbolicLink(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ignored,
    }
  })

  return { ok: true, entries, truncated }
}

function compareCaseInsensitive(a: string, b: string): number {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la < lb) return -1
  if (la > lb) return 1
  return 0
}

function errResult(err: unknown): FsReadDirResponse {
  const code = errnoCode(err)
  const mapped: ReadDirErrorCode = (READDIR_ERROR_CODES as readonly string[]).includes(code ?? '')
    ? (code as ReadDirErrorCode)
    : 'EACCES' // unrecognized errno: deny by default rather than leak an unmapped code
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
