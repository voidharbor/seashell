import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEEP_MS, decodeBase64Output, saveClipboardImage } from '../../src/main/clipboard-image.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

describe('saveClipboardImage', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-clip-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('saves the Linux clipboard image without asking Windows', async () => {
    let askedWindows = false
    const file = await saveClipboardImage({
      readLinux: () => PNG,
      readWindows: async () => {
        askedWindows = true
        return null
      },
      dir,
      now: () => 1000,
    })
    expect(file).toBe(path.join(dir, 'clipboard-1000.png'))
    expect(await fs.readFile(file)).toEqual(PNG)
    expect(askedWindows).toBe(false)
  })

  it('falls back to the Windows clipboard', async () => {
    const file = await saveClipboardImage({ readLinux: () => null, readWindows: async () => PNG, dir, now: () => 7 })
    expect(await fs.readFile(file)).toEqual(PNG)
  })

  it('returns nothing and writes nothing when there is no image', async () => {
    const file = await saveClipboardImage({ readLinux: () => null, readWindows: async () => null, dir, now: () => 7 })
    expect(file).toBe('')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('clears out old pasted images but leaves other files alone', async () => {
    const old = path.join(dir, 'clipboard-1.png')
    const other = path.join(dir, 'notes.txt')
    await fs.writeFile(old, PNG)
    await fs.writeFile(other, 'x')
    const past = new Date(Date.now() - KEEP_MS - 60_000)
    await fs.utimes(old, past, past)
    await fs.utimes(other, past, past)
    await saveClipboardImage({ readLinux: () => PNG, readWindows: async () => null, dir, now: () => Date.now() })
    const names = await fs.readdir(dir)
    expect(names).not.toContain('clipboard-1.png')
    expect(names).toContain('notes.txt')
  })
})

describe('decodeBase64Output', () => {
  it('decodes PowerShell output with CRLF', () => {
    expect(decodeBase64Output(PNG.toString('base64') + '\r\n')).toEqual(PNG)
  })
  it('treats empty output as no image', () => {
    expect(decodeBase64Output('\r\n')).toBeNull()
  })
})
