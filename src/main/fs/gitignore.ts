/**
 * Nested .gitignore composition, built on the 'ignore' package.
 *
 * [pure] — imports nothing but 'node:path' and 'ignore'. Filesystem access
 * (reading .gitignore files, finding the repo root) is injected via
 * `GitignoreFs` rather than called directly, because "walk up to the repo
 * root and stack .gitignore files in the right order" is exactly the kind
 * of logic that grows silent bugs when it can only be exercised against a
 * real disk. A caller (tree.ts) supplies a real-fs-backed implementation;
 * tests supply an in-memory one.
 *
 * Anchoring, negation, and `**` are not hand-rolled here on purpose — the
 * 'ignore' package (7.0.6) already gets those right, and re-implementing
 * gitignore glob semantics is a well-known bug farm.
 */

import ignoreFactory from 'ignore'
import * as path from 'node:path'

/** The value returned by calling the default export of 'ignore'. No named `Ignore` type is exported by the package itself. */
type Ignore = ReturnType<typeof ignoreFactory>

/**
 * Names filtered from every directory listing regardless of the
 * "show ignored" toggle or whether the directory is even inside a git repo.
 * These are never useful to browse and are common enough to special-case
 * rather than pay for a .gitignore walk just to hide them.
 */
export const ALWAYS_HIDDEN_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git', '.DS_Store'])

/**
 * Filesystem capability this module needs, injected so it stays free of
 * 'fs' and independently testable.
 */
export interface GitignoreFs {
  /** UTF-8 contents of `dirAbsPath/.gitignore`, or undefined if it doesn't exist / can't be read. */
  readGitignore(dirAbsPath: string): string | undefined
  /** True if `dirAbsPath/.git` exists — marks the repo root. */
  hasDotGit(dirAbsPath: string): boolean
}

interface GitignoreLevel {
  /** Absolute directory that owns this .gitignore. */
  dir: string
  ig: Ignore
}

/**
 * Composes nested .gitignore files the way git does: each file's patterns
 * are tested against paths relative to *that file's own directory*, and a
 * deeper (more specific) file's matching rule — including a negation —
 * overrides a shallower one for the same path. `Map<dirPath, ...>` caching
 * means re-listing a directory (e.g. after a watcher fires) never re-walks
 * to the repo root or re-parses every .gitignore on the path.
 */
export class GitignoreEngine {
  /** Per-directory chain (root..dir), keyed by the directory the chain was built for. */
  private readonly chainCache = new Map<string, GitignoreLevel[]>()
  /** Per-directory parsed .gitignore, or null if that directory has none. Shared across every chain that passes through it. */
  private readonly ownIgnoreCache = new Map<string, Ignore | null>()
  /** Per-directory "does this contain .git", so re-walking to the root from a sibling directory costs nothing extra. */
  private readonly isRepoRootCache = new Map<string, boolean>()

  constructor(private readonly fsBridge: GitignoreFs) {}

  /** Drop cached state for one directory — call when its .gitignore changes. */
  invalidate(dirAbsPath: string): void {
    this.chainCache.delete(dirAbsPath)
    this.ownIgnoreCache.delete(dirAbsPath)
  }

  /** Drop all cached state — call on a broad refresh (e.g. window focus). */
  clear(): void {
    this.chainCache.clear()
    this.ownIgnoreCache.clear()
    this.isRepoRootCache.clear()
  }

  /**
   * Whether `absPath`, a direct child of `parentDirAbsPath`, is ignored by
   * the composed .gitignore chain for `parentDirAbsPath`.
   */
  isIgnored(parentDirAbsPath: string, absPath: string, isDir: boolean): boolean {
    const chain = this.chainFor(parentDirAbsPath)
    let ignored = false
    for (const level of chain) {
      const rel = toIgnorePath(level.dir, absPath, isDir)
      if (rel === undefined) continue
      const result = level.ig.test(rel)
      // A level only speaks if one of its own rules actually matched;
      // otherwise the decision from a shallower level carries forward.
      if (result.ignored || result.unignored) {
        ignored = result.ignored
      }
    }
    return ignored
  }

  /** Root-to-leaf chain of {dir, ig} from the repo root down to and including `dirAbsPath`. */
  private chainFor(dirAbsPath: string): GitignoreLevel[] {
    const cached = this.chainCache.get(dirAbsPath)
    if (cached) return cached

    const dirs: string[] = [dirAbsPath]
    let cur = dirAbsPath
    while (!this.isRepoRoot(cur)) {
      const parent = path.dirname(cur)
      if (parent === cur) break // filesystem root; no .git found anywhere above
      dirs.push(parent)
      cur = parent
    }
    dirs.reverse() // root -> leaf, so deeper rules are applied (and can override) later

    const chain: GitignoreLevel[] = []
    for (const dir of dirs) {
      const ig = this.ownIgnoreFor(dir)
      if (ig) chain.push({ dir, ig })
    }

    this.chainCache.set(dirAbsPath, chain)
    return chain
  }

  private isRepoRoot(dir: string): boolean {
    const cached = this.isRepoRootCache.get(dir)
    if (cached !== undefined) return cached
    const result = this.fsBridge.hasDotGit(dir)
    this.isRepoRootCache.set(dir, result)
    return result
  }

  private ownIgnoreFor(dir: string): Ignore | null {
    const cached = this.ownIgnoreCache.get(dir)
    if (cached !== undefined) return cached
    const contents = this.fsBridge.readGitignore(dir)
    const ig = contents === undefined ? null : ignoreFactory().add(contents)
    this.ownIgnoreCache.set(dir, ig)
    return ig
  }
}

/**
 * POSIX-relative path from `dir` to `absPath`, with a trailing slash for
 * directories — the shape the 'ignore' package's own docs require for
 * directory-only patterns (e.g. `build/`) to match correctly. Returns
 * undefined when `absPath` isn't actually under `dir`.
 */
function toIgnorePath(dir: string, absPath: string, isDir: boolean): string | undefined {
  const rel = path.relative(dir, absPath)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  const posix = rel.split(path.sep).join('/')
  return isDir ? `${posix}/` : posix
}
