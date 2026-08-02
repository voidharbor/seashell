import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeTextFile } from '../../src/main/fs/write.js'

/** Real files in a real tmpdir — the guards under test are filesystem facts
 *  (realpath containment, mtime, NUL bytes), not logic worth faking. */

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs = []
})

function scope(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seashell-write-'))
  dirs.push(d)
  return d
}

function seed(dir: string, name: string, content: string | Buffer): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

function mtimeOf(p: string): number {
  return fs.statSync(p).mtimeMs
}

describe('writeTextFile', () => {
  it('writes when the mtime matches and returns the new mtime', async () => {
    const dir = scope()
    const p = seed(dir, 'notes.md', 'old text\n')
    const res = await writeTextFile({ path: p, text: 'new text\n', expectedMtimeMs: mtimeOf(p) }, dir)
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe('new text\n')
    if (res.ok) expect(res.mtimeMs).toBe(mtimeOf(p))
  })

  it('refuses when the file changed on disk underneath', async () => {
    const dir = scope()
    const p = seed(dir, 'notes.md', 'original\n')
    const staleMtime = mtimeOf(p) - 1000
    const res = await writeTextFile({ path: p, text: 'clobber\n', expectedMtimeMs: staleMtime }, dir)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ECONFLICT')
    expect(fs.readFileSync(p, 'utf8')).toBe('original\n')
  })

  it('refuses to overwrite a binary file', async () => {
    const dir = scope()
    const p = seed(dir, 'blob.dat', Buffer.from([0x89, 0x50, 0x00, 0x47]))
    const res = await writeTextFile({ path: p, text: 'text', expectedMtimeMs: mtimeOf(p) }, dir)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('EBINARY')
  })

  it('refuses a path outside the scope directory', async () => {
    const inside = scope()
    const outside = scope()
    const p = seed(outside, 'escape.txt', 'x')
    const res = await writeTextFile({ path: p, text: 'y', expectedMtimeMs: mtimeOf(p) }, inside)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ESCOPE')
    expect(fs.readFileSync(p, 'utf8')).toBe('x')
  })

  it('refuses a symlink inside scope pointing outside it', async () => {
    const inside = scope()
    const outside = scope()
    const target = seed(outside, 'target.txt', 'x')
    const link = path.join(inside, 'link.txt')
    fs.symlinkSync(target, link)
    const res = await writeTextFile({ path: link, text: 'y', expectedMtimeMs: mtimeOf(target) }, inside)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ESCOPE')
    expect(fs.readFileSync(target, 'utf8')).toBe('x')
  })

  it('refuses a file that does not exist — the editor edits, it never creates', async () => {
    const dir = scope()
    const res = await writeTextFile(
      { path: path.join(dir, 'missing.txt'), text: 'y', expectedMtimeMs: 0 },
      dir
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ENOENT')
  })

  // Asserted against the mode the file actually carries rather than a literal
  // 0o600: Windows honours only the read-only bit, so the chmod below cannot
  // take there and a literal would fail a platform, not a regression. What is
  // under test either way is that the replace copies the mode it found.
  it('preserves the file mode across the atomic replace', async () => {
    const dir = scope()
    const p = seed(dir, 'notes.md', 'old')
    fs.chmodSync(p, 0o600)
    const before = fs.statSync(p).mode & 0o777
    const res = await writeTextFile({ path: p, text: 'new', expectedMtimeMs: mtimeOf(p) }, dir)
    expect(res.ok).toBe(true)
    expect(fs.statSync(p).mode & 0o777).toBe(before)
  })
})
