import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWin32, type WslIo } from '../../src/main/platform/win32.js'
import { toLinuxPath, wslUncPath } from '../../src/shared/wsl-shell.js'
import { linuxToUnc } from '../../src/shared/wsl-path.js'
import { runLinuxImport, type ImportFs } from '../../src/main/state/import-linux.js'
import { sessionIdsForPanes } from '../../src/main/state/session-lookup.js'

/**
 * The seams between the Windows pieces: one distro and home (the win32 probe)
 * for panes, paths and the first-run import, one path translator, and the
 * session lookup reading claude's state from the WSL home with WSL pids.
 */

function probeIo(over: Partial<WslIo> = {}): { io: WslIo; calls: string[][] } {
  const calls: string[][] = []
  const io: WslIo = {
    wslExe: 'C:\\Windows\\System32\\wsl.exe',
    run: async () => '',
    runSync: (args) => {
      calls.push(args)
      if (args[0] === '-l') return Buffer.from('Ubuntu-24.04\r\n', 'utf16le')
      if (args.includes('sh')) return Buffer.from('/home/j\n/usr/bin/zsh\n')
      return null
    },
    readFile: async () => {
      throw new Error('ENOENT')
    },
    writeFileAtomic: () => {},
    mkdirp: () => {},
    isDir: () => true,
    unlink: () => {},
    readdir: () => [],
    rmrf: () => {},
    pidAlive: () => false,
    appPid: 1,
    windowsHome: 'C:\\Users\\j',
    ...over,
  }
  return { io, calls }
}

describe('the win32 probe is the one source of the distro', () => {
  it('lists the distros when nothing overrides it', () => {
    const { io, calls } = probeIo()
    expect(createWin32(io).info()).toEqual({ distro: 'Ubuntu-24.04', home: '/home/j', shell: '/usr/bin/zsh' })
    expect(calls[0]).toEqual(['-l', '-q'])
  })

  it('takes SEASHELL_WSL_DISTRO over the default distro, and probes the home there', () => {
    const { io, calls } = probeIo({ distroOverride: 'Debian' })
    expect(createWin32(io).info().distro).toBe('Debian')
    expect(calls.some((c) => c[0] === '-l')).toBe(false)
    expect(calls[0]!.slice(0, 2)).toEqual(['-d', 'Debian'])
  })
})

describe('one path translator', () => {
  it('builds the shim UNC path with the same function the fs layer uses', () => {
    expect(wslUncPath('Ubuntu-24.04', '/home/j/x')).toBe(linuxToUnc('Ubuntu-24.04', '/home/j/x'))
  })

  it('normalizes a Windows cwd before it becomes a pane cwd', () => {
    expect(toLinuxPath('C:\\Users\\j\\..\\k')).toBe('/mnt/c/Users/k')
    expect(toLinuxPath('//server/share')).toBeNull()
    expect(toLinuxPath('~')).toBe('~')
  })
})

describe('the first-run import reads from the probed distro', () => {
  it('uses the platform distro over the env fallback', async () => {
    const seen: string[] = []
    const memFs: ImportFs = {
      exists: async (p) => {
        seen.push(p)
        return false
      },
      readFile: async () => Buffer.from(''),
      writeNew: async () => {},
      mkdirp: async () => {},
    }
    const r = await runLinuxImport({
      platform: 'win32',
      userData: 'C:\\Users\\j\\AppData\\Roaming\\seashell',
      env: { SEASHELL_WSL_DISTRO: 'Other' },
      distro: () => 'Debian',
      fs: memFs,
      linuxHome: async () => '/home/j',
      now: () => new Date(0),
    })
    expect(r.reason).toBe('no linux state found')
    expect(seen.some((p) => p.startsWith('\\\\wsl.localhost\\Debian\\home\\j\\.config\\seashell'))).toBe(true)
    expect(seen.some((p) => p.includes('\\Other\\'))).toBe(false)
  })
})

describe('session lookup with a foreign claude home', () => {
  it('reads the registry under claudeHome and judges pids by the WSL table', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'win32-lookup-'))
    try {
      const reg = path.join(home, '.claude', 'session-registry')
      await fs.mkdir(reg, { recursive: true })
      const live = '11111111-1111-4111-8111-111111111111'
      const dead = '22222222-2222-4222-8222-222222222222'
      await fs.writeFile(
        path.join(reg, 'a.json'),
        JSON.stringify({ session_id: live, pane_id: 'p1', pid: 900, registered_at: 1 })
      )
      await fs.writeFile(
        path.join(reg, 'b.json'),
        JSON.stringify({ session_id: dead, pane_id: 'p2', pid: 901, registered_at: 1 })
      )
      const res = await sessionIdsForPanes(
        [
          { paneId: 'p1', cwd: '/nowhere', claude: false },
          { paneId: 'p2', cwd: '/nowhere', claude: false },
        ],
        {
          shellPidOf: () => null,
          processChildren: async () => null,
          startTokens: async () => new Map(),
          claudeHome: home,
          livePids: async () => new Set([900]),
        }
      )
      expect(res.ids['p1']).toBe(live)
      expect(res.ids['p2']).toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('gives no verdict when the WSL process table cannot be read, rather than calling everything dead', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'win32-lookup-'))
    try {
      const reg = path.join(home, '.claude', 'session-registry')
      await fs.mkdir(reg, { recursive: true })
      // Live right now in another SeaShell; the restored pane carries it.
      const elsewhere = '33333333-3333-4333-8333-333333333333'
      await fs.writeFile(
        path.join(reg, 'c.json'),
        JSON.stringify({ session_id: elsewhere, pane_id: 'pane-9-1', pid: 950, registered_at: 1 })
      )
      const res = await sessionIdsForPanes(
        [{ paneId: 'p1', cwd: '/nowhere', knownSid: elsewhere, knownVerified: true }],
        {
          shellPidOf: () => null,
          processChildren: async () => null,
          startTokens: async () => new Map(),
          claudeHome: home,
          livePids: async () => null,
        }
      )
      // Nothing carried, nothing guessed: a restore starts the pane cold and
      // a save keeps what the pane already had (saveLookupFrom).
      expect(res).toEqual({ ids: {}, sources: {} })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('credits a registry entry only to a pane of the app run that wrote it', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'win32-lookup-'))
    try {
      const reg = path.join(home, '.claude', 'session-registry')
      await fs.mkdir(reg, { recursive: true })
      const linuxApp = '44444444-4444-4444-8444-444444444444'
      const mine = '55555555-5555-4555-8555-555555555555'
      // Both apps minted pane-2-812; only the second entry is this run's.
      await fs.writeFile(
        path.join(reg, 'l.json'),
        JSON.stringify({ session_id: linuxApp, pane_id: 'pane-2-812', pid: 900, registered_at: 5 })
      )
      await fs.writeFile(
        path.join(reg, 'w.json'),
        JSON.stringify({ session_id: mine, pane_id: 'pane-2-813', pid: 901, registered_at: 1, app_id: 'win32-77' })
      )
      const deps = {
        shellPidOf: () => null,
        processChildren: async () => null,
        startTokens: async () => new Map<number, string>(),
        claudeHome: home,
        livePids: async () => new Set([900, 901]),
        appId: 'win32-77',
      }
      const res = await sessionIdsForPanes(
        [
          { paneId: 'pane-2-812', cwd: '/nowhere', claude: false },
          { paneId: 'pane-2-813', cwd: '/nowhere', claude: false },
        ],
        deps
      )
      expect(res.ids['pane-2-812']).toBeUndefined()
      expect(res.ids['pane-2-813']).toBe(mine)
      // The other app's session still counts as live: never resumed here.
      const carried = await sessionIdsForPanes(
        [{ paneId: 'pane-5-1', cwd: '/nowhere', knownSid: linuxApp, knownVerified: true }],
        deps
      )
      expect(carried.ids['pane-5-1']).toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
