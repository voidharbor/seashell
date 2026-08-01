import { describe, expect, it } from 'vitest'
import { statBatch } from '../../src/main/fs/stat-batch.js'
import { tokenizeLine } from '../../src/renderer/links/tokenizer.js'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

/**
 * The bug this pins, which survived three attempted fixes at the event layer:
 *
 * `pathAtPoint` returns text exactly as it appeared on screen, and nearly
 * everything a program prints is relative — `src/renderer/app.tsx:645`. That
 * string was handed straight to the explorer, whose reveal walks parent
 * directories while they still start with the explorer root. A relative path
 * never does, so it expanded nothing and selected nothing, which is
 * indistinguishable from the double-click never firing.
 *
 * The missing step was `statBatch`: resolve against the pane's cwd, canonicalise,
 * and drop anything that does not exist. These tests cover that seam end to end
 * against a real temporary directory, because the whole failure was a wiring gap
 * between two pieces that each worked.
 */
describe('double-click reveal: tokenize then resolve', () => {
  it('turns a relative path in output into an absolute one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seashell-reveal-'))
    await fs.mkdir(path.join(dir, 'src', 'renderer'), { recursive: true })
    const file = path.join(dir, 'src', 'renderer', 'app.tsx')
    await fs.writeFile(file, 'x', 'utf8')

    // What an agent actually prints, line-number suffix and all.
    const candidates = tokenizeLine('Updated src/renderer/app.tsx:645 with 3 additions')
    expect(candidates.length).toBeGreaterThan(0)

    const res = await statBatch({ cwd: dir, candidates: candidates.map((c) => c.path) })
    expect(res.results).toHaveLength(1)
    // Absolute, and pointing at the real file — the thing the explorer needs.
    expect(path.isAbsolute(res.results[0]!.resolved)).toBe(true)
    expect(await fs.realpath(res.results[0]!.resolved)).toBe(await fs.realpath(file))
    expect(res.results[0]!.kind).toBe('file')

    await fs.rm(dir, { recursive: true, force: true })
  })

  it('stays silent on prose that merely looks like a path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seashell-reveal-'))
    const candidates = tokenizeLine('see src/does/not/exist.ts for details')
    const res = await statBatch({ cwd: dir, candidates: candidates.map((c) => c.path) })
    // Misses are omitted, so a double-click on this reveals nothing at all.
    expect(res.results).toHaveLength(0)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('resolves a directory too, so folders can be revealed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seashell-reveal-'))
    await fs.mkdir(path.join(dir, 'src'), { recursive: true })
    const res = await statBatch({ cwd: dir, candidates: ['src/'] })
    expect(res.results[0]?.kind).toBe('dir')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('leaves an already-absolute path alone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seashell-reveal-'))
    const file = path.join(dir, 'README.md')
    await fs.writeFile(file, 'x', 'utf8')
    // cwd is deliberately somewhere else: an absolute candidate must not be
    // re-rooted against it.
    const res = await statBatch({ cwd: os.homedir(), candidates: [file] })
    expect(await fs.realpath(res.results[0]!.resolved)).toBe(await fs.realpath(file))
    await fs.rm(dir, { recursive: true, force: true })
  })
})

/**
 * The reveal's own precondition, mirrored here rather than reaching into the
 * component: the explorer can only expand to something beneath its root.
 */
function insideRoot(p: string, root: string): boolean {
  if (!root) return true
  return p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`)
}

describe('explorer root boundary', () => {
  it('accepts paths under the root', () => {
    expect(insideRoot('/Users/j/work/a.ts', '/Users/j')).toBe(true)
    expect(insideRoot('/Users/j', '/Users/j')).toBe(true)
  })

  it('rejects paths outside it, so the UI can say so instead of doing nothing', () => {
    expect(insideRoot('/tmp/a.ts', '/Users/j')).toBe(false)
    expect(insideRoot('/opt/homebrew/bin/brew', '/Users/j')).toBe(false)
  })

  it('does not treat a sibling with a shared prefix as inside', () => {
    // /Users/joshwald2 must not count as inside /Users/joshwald.
    expect(insideRoot('/Users/joshwald2/a.ts', '/Users/joshwald')).toBe(false)
  })
})

/**
 * Two defects found by measuring a real screenful of agent output, after a
 * report that only some paths revealed.
 *
 * Both had the same shape: the path was correct on screen and correct in the
 * user's head, and one layer in the middle quietly disagreed.
 */
describe('tilde paths', () => {
  it('expands a leading ~, which nothing did before', async () => {
    const home = os.homedir()
    const res = await statBatch({ cwd: '/tmp', candidates: ['~'] })
    expect(res.results[0]?.resolved).toBe(await fs.realpath(home))
  })

  it('resolves ~/file regardless of the pane cwd', async () => {
    const name = `.seashell-tilde-${process.pid}`
    const file = path.join(os.homedir(), name)
    await fs.writeFile(file, 'x', 'utf8')
    // cwd deliberately elsewhere: a ~ path must not depend on it.
    const res = await statBatch({ cwd: '/tmp', candidates: [`~/${name}`] })
    expect(await fs.realpath(res.results[0]!.resolved)).toBe(await fs.realpath(file))
    await fs.rm(file, { force: true })
  })

  it('does not guess at another user\'s home', async () => {
    // ~user needs a passwd lookup and is not something to invent.
    const res = await statBatch({ cwd: '/tmp', candidates: ['~nonexistentuser/x'] })
    expect(res.results).toHaveLength(0)
  })
})

describe('the Name(path) form agents print', () => {
  it('unwraps the label', () => {
    expect(tokenizeLine('Write(doubleclick-test.txt)').map((c) => c.path)).toEqual([
      'doubleclick-test.txt',
    ])
    expect(tokenizeLine('Read(src/renderer/app.tsx)').map((c) => c.path)).toEqual([
      'src/renderer/app.tsx',
    ])
  })

  it('leaves parentheses that belong to the filename alone', () => {
    // A real file can contain brackets; the label rule must not eat them.
    expect(tokenizeLine('run src/helper(a).ts now').map((c) => c.path)).toEqual([
      'src/helper(a).ts',
    ])
  })

  it('does not turn a command invocation into a path', () => {
    expect(tokenizeLine('Bash(ls -la)')).toHaveLength(0)
  })
})
