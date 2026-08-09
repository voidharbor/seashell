import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { statForOpen } from '../../src/main/fs/open-target.js'
import { denyOpenPath } from '../../src/main/fs/path-guard.js'

/**
 * Real symlinks in a real tmpdir, because the whole point is what the
 * filesystem does rather than what a mock says it does.
 *
 * The property under test is one line long: the verdict `denyOpenPath` reaches
 * must describe the file that would actually be launched. Everything the guard
 * reasons about — the executable bit, directory-ness, the extension, /dev —
 * reads false or empty off an unresolved symlink, so before this the answer was
 * "allow" for every laundered target.
 */

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs = []
})

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seashell-open-'))
  dirs.push(d)
  return d
}

const refuses = async (p: string): Promise<boolean> => {
  const t = await statForOpen(p)
  return denyOpenPath({ resolvedPath: t.real, isExecutable: t.isExecutable, isDir: t.isDir })
}

describe('statForOpen', () => {
  it('refuses a link whose target is a .command, however the link is named', async () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'pwn.command'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
    fs.symlinkSync(path.join(d, 'pwn.command'), path.join(d, 'notes.txt'))

    expect(await refuses(path.join(d, 'notes.txt'))).toBe(true)
  })

  it('refuses a link into a .app bundle', async () => {
    const d = tmp()
    fs.mkdirSync(path.join(d, 'Evil.app'))
    fs.symlinkSync(path.join(d, 'Evil.app'), path.join(d, 'report.pdf'))

    expect(await refuses(path.join(d, 'report.pdf'))).toBe(true)
  })

  it('still allows a link to an ordinary document', async () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'real.txt'), 'hello\n')
    fs.symlinkSync(path.join(d, 'real.txt'), path.join(d, 'link.txt'))

    const t = await statForOpen(path.join(d, 'link.txt'))
    expect(t.unresolved).toBe(false)
    expect(t.real).toBe(fs.realpathSync(path.join(d, 'real.txt')))
    expect(await refuses(path.join(d, 'link.txt'))).toBe(false)
  })

  /**
   * The case a naive `isSymbolicLink()` gate misses: lstat follows symlinked
   * PARENTS, so the final component is an ordinary node and the gate would
   * skip realpath entirely.
   */
  it('resolves a target reached through a symlinked parent directory', async () => {
    const d = tmp()
    fs.mkdirSync(path.join(d, 'real-dir'))
    fs.writeFileSync(path.join(d, 'real-dir', 'run.command'), '#!/bin/sh\n', { mode: 0o755 })
    fs.symlinkSync(path.join(d, 'real-dir'), path.join(d, 'alias'))

    const via = path.join(d, 'alias', 'run.command')
    const t = await statForOpen(via)
    expect(t.real).toContain('real-dir')
    expect(await refuses(via)).toBe(true)
  })

  it('falls back to the link itself when the target is missing, rather than throwing', async () => {
    const d = tmp()
    fs.symlinkSync(path.join(d, 'gone.txt'), path.join(d, 'dangling.txt'))

    const t = await statForOpen(path.join(d, 'dangling.txt'))
    expect(t.unresolved).toBe(true)
    expect(t.real).toBe(path.join(d, 'dangling.txt'))
    // A target that does not exist cannot launder anything, and the explorer
    // is still rendering the row — so this must not become "no longer exists".
    expect(await refuses(path.join(d, 'dangling.txt'))).toBe(false)
  })

  it('reports the target size, so the viewer ceiling measures what it would read', async () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'big.txt'), 'x'.repeat(5000))
    fs.symlinkSync(path.join(d, 'big.txt'), path.join(d, 's.txt'))

    expect((await statForOpen(path.join(d, 's.txt'))).size).toBe(5000)
  })

  it('throws for a path that does not exist at all', async () => {
    const d = tmp()
    await expect(statForOpen(path.join(d, 'nope.txt'))).rejects.toThrow()
  })

  it('leaves an ordinary file exactly as it was', async () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'plain.txt'), 'hi')
    const t = await statForOpen(path.join(d, 'plain.txt'))
    expect(t.isDir).toBe(false)
    expect(t.isExecutable).toBe(false)
    expect(t.unresolved).toBe(false)
  })
})
