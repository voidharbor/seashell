import { describe, expect, it } from 'vitest'
import { createWin32, parseStatBatch, type WslIo } from '../../src/main/platform/win32.js'
import { liveSessionsFromPidFiles } from '../../src/main/state/session-lookup.js'

// Two real-shaped /proc/<pid>/stat lines; the second has a space and a paren
// in its name, which is why fields are counted from the last ')'.
const STAT_900 =
  '900 (claude) S 812 900 812 34816 900 4194560 1 0 0 0 10 5 0 0 20 0 11 0 5123456 1 1 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0'
const STAT_950 =
  '950 (node (mcp) x) S 900 900 812 34816 900 4194560 1 0 0 0 1 1 0 0 20 0 7 0 5124000 1 1 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0'

function io(run: WslIo['run'], calls: string[][] = []): WslIo {
  return {
    wslExe: 'C:\\Windows\\System32\\wsl.exe',
    run: async (args) => {
      calls.push(args)
      return run(args)
    },
    runSync: (args) => (args[0] === '-l' ? Buffer.from('Ubuntu-24.04\r\n', 'utf16le') : Buffer.from('/home/u\n/usr/bin/zsh\n')),
    readFile: async () => {
      throw new Error('ENOENT')
    },
    writeFileAtomic: () => {},
    mkdirp: () => {},
    isDir: () => true,
    unlink: () => {},
    readdir: () => [],
    rmrf: () => {},
    pidAlive: () => true,
    appPid: 1,
    windowsHome: 'C:\\Users\\u',
  }
}

describe('parseStatBatch', () => {
  it('maps each stat line to field 22 by its own pid', () => {
    const m = parseStatBatch(`${STAT_900}\n${STAT_950}\n`, [900, 950, 977])
    expect(m.get(900)).toBe('5123456')
    expect(m.get(950)).toBe('5124000')
    expect(m.has(977)).toBe(false)
  })

  it('ignores pids it was not asked for and junk lines', () => {
    const m = parseStatBatch(`cat: /proc/977/stat: No such file\n${STAT_900}\n`, [950])
    expect(m.size).toBe(0)
  })
})

describe('win32 processStartTokens', () => {
  it('reads /proc/<pid>/stat inside WSL in one wsl.exe run', async () => {
    const calls: string[][] = []
    const w = createWin32(io(async () => `${STAT_900}\n`, calls))
    const tokens = await w.processStartTokens([900, 977, -1, 1.5])
    expect(tokens).toEqual(new Map([[900, '5123456']]))
    expect(calls).toEqual([['-d', 'Ubuntu-24.04', '-e', 'cat', '/proc/900/stat', '/proc/977/stat']])
  })

  it('runs nothing for no pids and reports nothing when wsl.exe cannot run', async () => {
    const calls: string[][] = []
    expect((await createWin32(io(async () => null, calls)).processStartTokens([])).size).toBe(0)
    expect(calls).toEqual([])
    expect((await createWin32(io(async () => null)).processStartTokens([900])).size).toBe(0)
  })

  it('proves a claude pid file against the live start token, as on Linux', async () => {
    const w = createWin32(io(async () => `${STAT_900}\n`))
    const tokens = await w.processStartTokens([900, 901])
    const sid = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
    const live = liveSessionsFromPidFiles(
      [
        { pid: 900, sessionId: sid, procStart: '5123456', startedAt: 10 },
        { pid: 901, sessionId: sid, procStart: '1', startedAt: 11 },
      ],
      tokens
    )
    expect([...live.keys()]).toEqual([900])
    expect(live.get(900)?.sid).toBe(sid)
  })
})
