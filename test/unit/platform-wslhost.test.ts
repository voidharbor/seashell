import { describe, expect, it } from 'vitest'
import { createWslhost } from '../../src/main/platform/wslhost.js'
import { buildEnv } from '../../src/main/pty/env.js'

function io(over: Partial<Parameters<typeof createWslhost>[0]> = {}) {
  const writes: Record<string, string> = {}
  const dirs: string[] = []
  const removed: string[] = []
  return {
    writes, dirs, removed,
    io: {
      hostPid: 777, home: '/Users/joshwald', appVersion: '0.6.0',
      mkdirp: (d: string) => { dirs.push(d) },
      writeFileAtomic: (f: string, c: string) => { writes[f] = c },
      readdir: () => ['777', '31337', 'junk'],
      rmrf: (d: string) => { removed.push(d) },
      windowsPidAlive: (pid: number) => pid === 777,
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
})
