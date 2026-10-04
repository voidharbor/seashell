import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createWslhost, nodeWslhostIo } from '../../src/main/platform/wslhost.js'
import { buildEnv } from '../../src/main/pty/env.js'

function io(over: Partial<Parameters<typeof createWslhost>[0]> = {}) {
  const writes: Record<string, string> = {}
  const dirs: string[] = []
  const removed: string[] = []
  return {
    writes, dirs, removed,
    io: {
      hostPid: 777, home: '/Users/joshwald', appVersion: '0.6.0', installed: false,
      mkdirp: (d: string) => { dirs.push(d) },
      writeFileAtomic: (f: string, c: string) => { writes[f] = c },
      readdir: () => ['777', '31337', 'junk'],
      rmrf: (d: string) => { removed.push(d) },
      readFile: (): string => { throw new Error('ENOENT') },
      unlink: () => {},
      rmdirIfEmpty: () => {},
      windowsPidAlive: (pid: number) => pid === 777,
      onExit: () => {},
      ...over,
    },
  }
}

describe('wslhost platform', () => {
  it('writes the WSL shim files and returns the Linux shim dir', () => {
    const { io: i, writes, dirs } = io()
    const p = createWslhost(i)
    expect(p.installShellIntegration()).toBe('/Users/joshwald/.cache/seashell-win/zdotdir')
    expect(Object.keys(writes).sort()).toEqual(['.zlogin', '.zprofile', '.zshenv', '.zshrc'].map((n) => `/Users/joshwald/.cache/seashell-win/zdotdir/${n}`))
    expect(writes['/Users/joshwald/.cache/seashell-win/zdotdir/.zshenv']).toContain('SEASHELL_PIDFILE')
    expect(dirs).toContain('/Users/joshwald/.cache/seashell-win/pids/777')
  })
  it('sweeps pid dirs of dead shell pids only', () => {
    const { io: i, removed } = io()
    createWslhost(i).installShellIntegration()
    expect(removed).toEqual(['/Users/joshwald/.cache/seashell-win/pids/31337'])
  })
  it('removes only its own panes\' pid files at quit, and the folder once empty, in a temp home', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-wslhost-home-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    const pids = join(home, '.cache/seashell-win/pids')
    const mine = join(pids, '777')
    // Another live shell's folder, with its pane pid file, and a stray file.
    mkdirSync(join(pids, '31337'), { recursive: true })
    writeFileSync(join(pids, '31337', 'pane-pane-1.pid'), '4242\n')
    writeFileSync(join(pids, 'note'), 'x')
    const firstExit: Array<() => void> = []
    const first = createWslhost({ ...nodeWslhostIo(777, home), windowsPidAlive: () => true, onExit: (fn) => firstExit.push(fn) })
    first.installShellIntegration()
    first.installShellIntegration()   // a retry arms no second removal
    expect(firstExit).toHaveLength(1)
    // The first core's panes write their pid files into this host's folder.
    first.paneSpawned!('pane-9', 5151)
    first.paneSpawned!('pane-1-400', 5152)
    writeFileSync(join(mine, 'pane-pane-9.pid'), '5151 pts/3\n')
    writeFileSync(join(mine, 'pane-pane-1-400.pid'), '5152 pts/4\n')
    // The shell restarts the core at once (wsl.exe died first): the second core
    // shares the folder, spawns pane-2 and mints pane-1-400 again, whose shell
    // overwrites that pid file, all before the first core's exit runs.
    const secondExit: Array<() => void> = []
    const second = createWslhost({ ...nodeWslhostIo(777, home), windowsPidAlive: () => true, onExit: (fn) => secondExit.push(fn) })
    second.installShellIntegration()
    second.paneSpawned!('pane-2', 6161)
    second.paneSpawned!('pane-1-400', 6162)
    writeFileSync(join(mine, 'pane-pane-2.pid'), '6161 pts/5\n')
    writeFileSync(join(mine, 'pane-pane-1-400.pid'), '6162 pts/6\n')
    firstExit[0]!()
    // The second core's files survive, so the folder stays.
    expect(readdirSync(mine).sort()).toEqual(['pane-pane-1-400.pid', 'pane-pane-2.pid'])
    secondExit[0]!()
    // Empty now: the second core's exit removes it, and nothing else.
    expect(existsSync(mine)).toBe(false)
    expect(readdirSync(pids).sort()).toEqual(['31337', 'note'])
    expect(readdirSync(join(pids, '31337'))).toEqual(['pane-pane-1.pid'])
    expect(existsSync(join(home, '.cache/seashell-win/zdotdir/.zshenv'))).toBe(true)
  })
  it('arms no removal when the shim could not be written', () => {
    const exits: Array<() => void> = []
    const { io: i } = io({ mkdirp: () => { throw new Error('EACCES') }, onExit: (fn: () => void) => exits.push(fn) })
    expect(createWslhost(i).installShellIntegration()).toBeNull()
    expect(exits).toHaveLength(0)
  })
  it('pane env extras carry the win32 identity and the pid file', () => {
    const p = createWslhost(io().io)
    p.installShellIntegration()
    const extras = Object.fromEntries(p.paneEnvExtras!('pane-9'))
    expect(extras).toMatchObject({ SEASHELL_APP_ID: 'win32-777', SEASHELL_PIDFILE: '/Users/joshwald/.cache/seashell-win/pids/777/pane-pane-9.pid', TERM_PROGRAM: 'SeaShell', TERM_PROGRAM_VERSION: '0.6.0' })
    expect(extras).not.toHaveProperty('ZDOTDIR')
  })
  it('names the pane app id so session lookup accepts the registry entries its panes write', () => {
    const p = createWslhost(io().io)
    expect(p.paneAppId).toBe('win32-777')
  })
  it('a pane spawned from a pane keeps the real ZDOTDIR (Review Focus 3)', () => {
    const shim = '/Users/joshwald/.cache/seashell-win/zdotdir'
    const env = buildEnv({ baseEnv: { HOME: '/Users/joshwald', ZDOTDIR: shim, SEASHELL_USER_ZDOTDIR: '/Users/joshwald' }, paneId: 'p', appVersion: '0.6.0', zdotdirShimPath: shim })
    expect(env.ZDOTDIR).toBe(shim)
    expect(env.SEASHELL_USER_ZDOTDIR).toBe('/Users/joshwald')
    expect(env.COLORTERM).toBeUndefined()
  })
  it('selects the tcp control transport and no terminal font', () => {
    const p = createWslhost(io().io)
    expect(p.controlTransport).toBe('tcp')
    expect(p.terminalFontPath()).toBeNull()
    expect(p.id).toBe('linux')
  })
  it('checks for updates only when installed, on the win-native channel', () => {
    const fake = io().io
    expect(createWslhost({ ...fake, installed: false }).updater).toBe('off')
    const p = createWslhost({ ...fake, installed: true })
    expect(p.updater).toBe('on')
    expect(p.updateChannel).toBe('win-native')
  })
})
