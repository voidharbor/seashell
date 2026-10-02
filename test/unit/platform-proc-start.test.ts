import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { linux } from '../../src/main/platform/linux.js'
import { createWin32, type WslIo } from '../../src/main/platform/win32.js'
import { procStartFromStat } from '../../src/main/state/session-lookup.js'

describe('processStartTokens', () => {
  it.runIf(process.platform === 'linux')('reads the live start token claude records, on Linux', async () => {
    const expected = procStartFromStat(fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8'))
    const tokens = await linux.processStartTokens([process.pid, 999999999])
    expect(expected).toMatch(/^\d+$/)
    expect(tokens.get(process.pid)).toBe(expected)
    expect(tokens.has(999999999)).toBe(false)
  })

  it('reports nothing on Windows when WSL cannot answer, rather than guess', async () => {
    // The real singleton would run wsl.exe where it exists (win32-proc-start
    // covers the live path), so this one gets an io that never answers.
    const dead: WslIo = {
      wslExe: 'C:\\Windows\\System32\\wsl.exe',
      run: async () => null,
      runSync: () => null,
      readFile: async () => {
        throw new Error('ENOENT')
      },
      writeFileAtomic: () => {},
      mkdirp: () => {},
      isDir: () => false,
      unlink: () => {},
      readdir: () => [],
      rmrf: () => {},
      pidAlive: () => false,
      appPid: 1,
      windowsHome: 'C:\\Users\\u',
    }
    expect((await createWin32(dead).processStartTokens([process.pid])).size).toBe(0)
  })
})
