import { describe, expect, it, vi } from 'vitest'
import { ALWAYS_HIDDEN_NAMES, GitignoreEngine, type GitignoreFs } from '../../src/main/fs/gitignore.js'

/**
 * In-memory fake standing in for the real filesystem. Keys are absolute
 * POSIX-style directory paths; this lets the tests exercise repo-root
 * walking and nested-.gitignore composition without touching a real disk.
 */
function fakeFs(opts: { gitignores?: Record<string, string>; gitDirs?: Iterable<string> }): GitignoreFs {
  const gitignores = opts.gitignores ?? {}
  const gitDirs = new Set(opts.gitDirs ?? [])
  return {
    readGitignore: vi.fn((dir: string) => gitignores[dir]),
    hasDotGit: vi.fn((dir: string) => gitDirs.has(dir)),
  }
}

describe('GitignoreEngine', () => {
  it('ignores a simple top-level pattern', () => {
    const fs = fakeFs({
      gitignores: { '/repo': '*.log\n' },
      gitDirs: ['/repo'],
    })
    const engine = new GitignoreEngine(fs)
    expect(engine.isIgnored('/repo', '/repo/debug.log', false)).toBe(true)
    expect(engine.isIgnored('/repo', '/repo/main.ts', false)).toBe(false)
  })

  it('matches directory-only patterns using the trailing slash', () => {
    const fs = fakeFs({
      gitignores: { '/repo': 'build/\n' },
      gitDirs: ['/repo'],
    })
    const engine = new GitignoreEngine(fs)
    expect(engine.isIgnored('/repo', '/repo/build', true)).toBe(true)
    // A *file* named "build" must not match a directory-only pattern.
    expect(engine.isIgnored('/repo', '/repo/build', false)).toBe(false)
  })

  it('anchors a leading-slash pattern to the .gitignore directory only', () => {
    const fs = fakeFs({
      gitignores: { '/repo': '/only-root.txt\n' },
      gitDirs: ['/repo'],
    })
    const engine = new GitignoreEngine(fs)
    expect(engine.isIgnored('/repo', '/repo/only-root.txt', false)).toBe(true)
    // Same basename nested one level down is a different relative path and must not match.
    expect(engine.isIgnored('/repo/sub', '/repo/sub/only-root.txt', false)).toBe(false)
  })

  it('walks up through multiple directories to the repo root, stacking rules', () => {
    const fs = fakeFs({
      gitignores: {
        '/repo': '*.log\n',
        '/repo/pkg': 'dist\n',
      },
      gitDirs: ['/repo'],
    })
    const engine = new GitignoreEngine(fs)
    // root rule reaches into the nested directory
    expect(engine.isIgnored('/repo/pkg', '/repo/pkg/debug.log', false)).toBe(true)
    // pkg's own rule applies to its own children
    expect(engine.isIgnored('/repo/pkg', '/repo/pkg/dist', true)).toBe(true)
    // pkg's rule must not leak to a sibling untouched by any pattern
    expect(engine.isIgnored('/repo/pkg', '/repo/pkg/index.ts', false)).toBe(false)
  })

  it('lets a deeper .gitignore negate a shallower ignore rule for the same path', () => {
    const fs = fakeFs({
      gitignores: {
        '/repo': '*.log\n',
        '/repo/keep': '!important.log\n',
      },
      gitDirs: ['/repo'],
    })
    const engine = new GitignoreEngine(fs)
    expect(engine.isIgnored('/repo/keep', '/repo/keep/other.log', false)).toBe(true)
    expect(engine.isIgnored('/repo/keep', '/repo/keep/important.log', false)).toBe(false)
  })

  it('handles ** recursive-glob patterns via the ignore package, not hand-rolled logic', () => {
    const fs = fakeFs({
      gitignores: { '/repo': '**/*.tmp\n' },
      gitDirs: ['/repo'],
    })
    const engine = new GitignoreEngine(fs)
    expect(engine.isIgnored('/repo/a/b/c', '/repo/a/b/c/x.tmp', false)).toBe(true)
  })

  it('falls back to the filesystem root when no .git directory exists anywhere above', () => {
    const fs = fakeFs({
      gitignores: { '/some/deep/dir': '*.bak\n' },
      gitDirs: [],
    })
    const engine = new GitignoreEngine(fs)
    expect(engine.isIgnored('/some/deep/dir', '/some/deep/dir/x.bak', false)).toBe(true)
  })

  it('treats a directory with no .gitignore anywhere in its chain as not ignored', () => {
    const fs = fakeFs({ gitignores: {}, gitDirs: ['/repo'] })
    const engine = new GitignoreEngine(fs)
    expect(engine.isIgnored('/repo', '/repo/whatever.txt', false)).toBe(false)
  })

  it('caches the composed chain per directory, never re-reading on a repeat call', () => {
    const fs = fakeFs({
      gitignores: { '/repo': '*.log\n', '/repo/pkg': 'dist\n' },
      gitDirs: ['/repo'],
    })
    const engine = new GitignoreEngine(fs)
    engine.isIgnored('/repo/pkg', '/repo/pkg/a.log', false)
    engine.isIgnored('/repo/pkg', '/repo/pkg/b.log', false)
    engine.isIgnored('/repo/pkg', '/repo/pkg/dist', true)

    expect(fs.readGitignore).toHaveBeenCalledTimes(2) // once for /repo, once for /repo/pkg
    expect(fs.hasDotGit).toHaveBeenCalledTimes(2) // /repo/pkg (miss), /repo (hit) — walked once, then cached
  })

  it('invalidate() forces the chain to be rebuilt for that directory only', () => {
    const gitignores: Record<string, string> = { '/repo': '*.log\n' }
    const fs = fakeFs({ gitignores, gitDirs: ['/repo'] })
    const engine = new GitignoreEngine(fs)

    expect(engine.isIgnored('/repo', '/repo/new.log', false)).toBe(true)
    expect(fs.readGitignore).toHaveBeenCalledTimes(1)

    engine.invalidate('/repo')
    engine.isIgnored('/repo', '/repo/new.log', false)
    expect(fs.readGitignore).toHaveBeenCalledTimes(2)
  })

  it('clear() forces every cached chain to be rebuilt', () => {
    const fs = fakeFs({
      gitignores: { '/repo': '*.log\n', '/repo/pkg': 'dist\n' },
      gitDirs: ['/repo'],
    })
    const engine = new GitignoreEngine(fs)
    engine.isIgnored('/repo', '/repo/a.log', false)
    engine.isIgnored('/repo/pkg', '/repo/pkg/dist', true)
    expect(fs.readGitignore).toHaveBeenCalledTimes(2)

    engine.clear()
    engine.isIgnored('/repo', '/repo/a.log', false)
    engine.isIgnored('/repo/pkg', '/repo/pkg/dist', true)
    expect(fs.readGitignore).toHaveBeenCalledTimes(4)
  })

  it('returns false for a path that is not actually under the tested directory', () => {
    const fs = fakeFs({
      gitignores: { '/repo': '*.log\n' },
      gitDirs: ['/repo'],
    })
    const engine = new GitignoreEngine(fs)
    // Deliberately misused: absPath outside parentDirAbsPath must never throw or false-positive.
    expect(engine.isIgnored('/repo', '/elsewhere/x.log', false)).toBe(false)
  })
})

describe('ALWAYS_HIDDEN_NAMES', () => {
  it('contains exactly the names the spec says are always filtered', () => {
    expect(ALWAYS_HIDDEN_NAMES.has('node_modules')).toBe(true)
    expect(ALWAYS_HIDDEN_NAMES.has('.git')).toBe(true)
    expect(ALWAYS_HIDDEN_NAMES.has('.DS_Store')).toBe(true)
    expect(ALWAYS_HIDDEN_NAMES.has('src')).toBe(false)
  })
})
