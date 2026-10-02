import { describe, expect, it } from 'vitest'
import {
  envArgs,
  isSafeLinuxCwd,
  paneFileKey,
  appInstanceId,
  paneVars,
  parseDistroList,
  parseHomeShellProbe,
  parsePidFile,
  pidFileFor,
  shimDirFor,
  toLinuxPath,
  wslShimFiles,
  wslSpawnArgs,
  wslUncPath,
} from '../../src/shared/wsl-shell.js'

/** What node-pty's Windows argv-to-command-line does: quote only on space, tab or quote. */
function needsQuoting(arg: string): boolean {
  return arg === '' || /[\s"]/.test(arg)
}

describe('the WSL pane spawn', () => {
  const vars = paneVars({
    paneId: 'a1b2c3d4-0000-4000-8000-000000000001',
    appVersion: '0.5.0',
    shimDir: '/Users/joshwald/.cache/seashell-win/zdotdir',
    userZdotdir: '/Users/joshwald',
    pidFile: '/Users/joshwald/.cache/seashell-win/pids/4242/pane-a1b2c3d4-0000-4000-8000-000000000001.pid',
  })

  it('runs env then the login shell through wsl.exe -e, in the Linux cwd', () => {
    const args = wslSpawnArgs({ distro: 'Ubuntu-24.04', cwd: '/Users/joshwald', shell: '/usr/bin/zsh', vars })
    expect(args).toEqual([
      '-d',
      'Ubuntu-24.04',
      '--cd',
      '/Users/joshwald',
      '-e',
      'env',
      '-u',
      'COLORTERM',
      'ZDOTDIR=/Users/joshwald/.cache/seashell-win/zdotdir',
      'SEASHELL_USER_ZDOTDIR=/Users/joshwald',
      'SEASHELL_PIDFILE=/Users/joshwald/.cache/seashell-win/pids/4242/pane-a1b2c3d4-0000-4000-8000-000000000001.pid',
      'TERM=xterm-256color',
      'TERM_PROGRAM=SeaShell',
      'TERM_PROGRAM_VERSION=0.5.0',
      'SEASHELL_PANE_ID=a1b2c3d4-0000-4000-8000-000000000001',
      '/usr/bin/zsh',
      '-l',
    ])
  })

  it('needs no quoting for any env argument', () => {
    const args = wslSpawnArgs({ distro: 'Ubuntu-24.04', cwd: '/tmp', shell: '/usr/bin/zsh', vars })
    for (const a of args) expect(needsQuoting(a)).toBe(false)
  })

  it('never sets COLORTERM, it unsets it', () => {
    const args = wslSpawnArgs({ distro: null, cwd: '/tmp', shell: '/usr/bin/zsh', vars })
    expect(args.some((a) => a.startsWith('COLORTERM='))).toBe(false)
    expect(args.slice(args.indexOf('env'), args.indexOf('env') + 3)).toEqual(['env', '-u', 'COLORTERM'])
  })

  it('omits -d when no distro is known', () => {
    const args = wslSpawnArgs({ distro: null, cwd: '~', shell: '/bin/bash', vars: [] })
    expect(args).toEqual(['--cd', '~', '-e', 'env', '-u', 'COLORTERM', '/bin/bash', '-l'])
  })

  it('refuses values that would need quoting instead of quoting them', () => {
    for (const bad of ['a b', 'a"b', "a'b", 'a\\b', 'a\nb', 'a\0b', 'a\tb', 'a\x1bb']) {
      expect(() => envArgs([['X', bad]])).toThrow(/unsafe env value/)
    }
    expect(() => envArgs([['BAD-NAME', 'x']])).toThrow(/unsafe env name/)
    expect(() => envArgs([['1X', 'x']])).toThrow(/unsafe env name/)
  })

  it('allows a cwd with spaces but not quotes, backslashes or control characters', () => {
    expect(isSafeLinuxCwd('/Users/u/Desktop/Acme Widgets LLC')).toBe(true)
    expect(isSafeLinuxCwd('~')).toBe(true)
    expect(isSafeLinuxCwd('relative/path')).toBe(false)
    expect(isSafeLinuxCwd('/a"b')).toBe(false)
    expect(isSafeLinuxCwd('/a\\b')).toBe(false)
    expect(isSafeLinuxCwd('/a\nb')).toBe(false)
    expect(() => wslSpawnArgs({ distro: null, cwd: 'C:\\x', shell: '/usr/bin/zsh', vars: [] })).toThrow(/cwd/)
  })

  it("allows a single quote, which a Windows command line leaves alone", () => {
    const cwd = "/Users/u/Desktop/Ann's Notes"
    expect(isSafeLinuxCwd(cwd)).toBe(true)
    const args = wslSpawnArgs({ distro: null, cwd, shell: '/usr/bin/zsh', vars: [] })
    expect(args.slice(0, 2)).toEqual(['--cd', cwd])
  })

  it('stamps the app run into the pane only when given one', () => {
    const base = { paneId: 'p', appVersion: '1', shimDir: null, userZdotdir: null, pidFile: null }
    expect(paneVars(base).some(([k]) => k === 'SEASHELL_APP_ID')).toBe(false)
    expect(paneVars({ ...base, appId: appInstanceId('win32', 4512) })).toContainEqual(['SEASHELL_APP_ID', 'win32-4512'])
  })

  it('refuses a relative or odd shell and a bad distro', () => {
    expect(() => wslSpawnArgs({ distro: null, cwd: '/', shell: 'zsh', vars: [] })).toThrow(/shell/)
    expect(() => wslSpawnArgs({ distro: 'a b', cwd: '/', shell: '/bin/zsh', vars: [] })).toThrow(/distro/)
  })

  it('sets the shim variables only together', () => {
    const none = paneVars({ paneId: 'p', appVersion: '1', shimDir: null, userZdotdir: '/h', pidFile: '/x' })
    expect(none.map(([k]) => k)).toEqual(['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'SEASHELL_PANE_ID'])
    const noHome = paneVars({ paneId: 'p', appVersion: '1', shimDir: '/s', userZdotdir: null, pidFile: null })
    expect(noHome.some(([k]) => k === 'ZDOTDIR')).toBe(false)
  })
})

describe('WSL paths', () => {
  it('maps Windows, UNC and Linux paths to the Linux side', () => {
    expect(toLinuxPath('C:\\Users\\josh\\Desktop')).toBe('/mnt/c/Users/josh/Desktop')
    expect(toLinuxPath('D:\\')).toBe('/mnt/d')
    expect(toLinuxPath('E:')).toBe('/mnt/e')
    expect(toLinuxPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\u')).toBe('/home/u')
    expect(toLinuxPath('\\\\wsl$\\Ubuntu\\tmp')).toBe('/tmp')
    expect(toLinuxPath('\\\\wsl.localhost\\Ubuntu')).toBe('/')
    expect(toLinuxPath('/Users/joshwald')).toBe('/Users/joshwald')
    expect(toLinuxPath('relative')).toBeNull()
    expect(toLinuxPath('\\\\server\\share')).toBeNull()
  })

  it('builds the UNC path Windows writes the shim through', () => {
    expect(wslUncPath('Ubuntu-24.04', '/Users/joshwald/.cache/seashell-win/zdotdir')).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\.cache\\seashell-win\\zdotdir'
    )
  })

  it('names the shim dir and one pid file per pane per app run', () => {
    expect(shimDirFor('/home/u/')).toBe('/home/u/.cache/seashell-win/zdotdir')
    expect(pidFileFor('/home/u', 77, 'drawer:abc/1')).toBe('/home/u/.cache/seashell-win/pids/77/pane-drawer_abc_1.pid')
    expect(paneFileKey('a-b_C9')).toBe('a-b_C9')
  })
})

describe('WSL probes', () => {
  it('decodes the UTF-16 distro list wsl.exe prints', () => {
    const raw = Buffer.from('Ubuntu-24.04\r\nDebian\r\n', 'utf16le')
    expect(parseDistroList(raw)).toEqual(['Ubuntu-24.04', 'Debian'])
  })

  it('decodes a UTF-8 list (WSL_UTF8=1) and tolerates default markers', () => {
    expect(parseDistroList(Buffer.from('* Ubuntu (Default)\nkali\n', 'utf8'))).toEqual(['Ubuntu', 'kali'])
    expect(parseDistroList('')).toEqual([])
  })

  it('reads home and login shell from the probe', () => {
    expect(parseHomeShellProbe('/Users/joshwald\n/usr/bin/zsh\n')).toEqual({ home: '/Users/joshwald', shell: '/usr/bin/zsh' })
    expect(parseHomeShellProbe('/home/u\r\n\r\n')).toEqual({ home: '/home/u', shell: null })
    expect(parseHomeShellProbe('')).toEqual({ home: null, shell: null })
    expect(parseHomeShellProbe('/home/with space\n/bin/zsh')).toEqual({ home: null, shell: '/bin/zsh' })
  })

  it('reads the pid file the shim writes', () => {
    expect(parsePidFile('4512 pts/3\n')).toEqual({ pid: 4512, tty: 'pts/3' })
    expect(parsePidFile('4512 /dev/pts/3')).toEqual({ pid: 4512, tty: 'pts/3' })
    expect(parsePidFile('4512 ')).toEqual({ pid: 4512, tty: null })
    expect(parsePidFile('4512 not-a-tty')).toEqual({ pid: 4512, tty: null })
    expect(parsePidFile('')).toBeNull()
    expect(parsePidFile('0 pts/1')).toBeNull()
    expect(parsePidFile('abc')).toBeNull()
  })
})

describe('the WSL ZDOTDIR shim', () => {
  const files = wslShimFiles()

  it('writes the same four files as the Mac shim', () => {
    expect(Object.keys(files).sort()).toEqual(['.zlogin', '.zprofile', '.zshenv', '.zshrc'])
  })

  it('records the shell pid and tty first thing, then forgets the pid file', () => {
    const env = files['.zshenv']!
    expect(env).toContain('print -r -- "$$ ${TTY#/dev/}" >| "$SEASHELL_PIDFILE"')
    expect(env.indexOf('SEASHELL_PIDFILE')).toBeLessThan(env.indexOf('. "${SEASHELL_USER_ZDOTDIR'))
    expect(env).toContain('unset SEASHELL_PIDFILE')
  })

  it('sources the real dotfiles, falling back to $HOME, and installs OSC 7', () => {
    expect(files['.zshrc']).toContain('[ -r "${SEASHELL_USER_ZDOTDIR:-$HOME}/.zshrc" ]')
    expect(files['.zshrc']).toContain('add-zsh-hook precmd _seashell_osc7')
    expect(files['.zshrc']).toContain("printf '\\e]7;file://%s%s\\a'")
  })

  it('has no CRs, since it is written from Windows', () => {
    for (const c of Object.values(files)) expect(c).not.toContain('\r')
  })
})
