import { describe, expect, it } from 'vitest'
import { createWin32, runResult, SWEEP_COLUMNS, type WslIo } from '../../src/main/platform/win32.js'
import { parsePsOutput, sumSubtreeRss } from '../../src/main/monitor/sweep-parse.js'

const HOME = '/Users/joshwald'
const UNC = '\\\\wsl.localhost\\Ubuntu-24.04'

/** A fake WSL: canned wsl.exe output and an in-memory UNC filesystem. */
function fakeIo(over: Partial<WslIo> & { outputs?: Record<string, string | null> } = {}) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const calls: string[][] = []
  const outputs = over.outputs ?? {}
  const io: WslIo = {
    wslExe: 'C:\\Windows\\System32\\wsl.exe',
    run: async (args) => {
      calls.push(args)
      const key = args.join(' ')
      for (const [k, v] of Object.entries(outputs)) if (key.includes(k)) return v
      return ''
    },
    runSync: (args) => {
      calls.push(args)
      if (args[0] === '-l') return Buffer.from('Ubuntu-24.04\r\n', 'utf16le')
      if (args.includes('sh')) return Buffer.from(`${HOME}\n/usr/bin/zsh\n`)
      return null
    },
    readFile: async (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    writeFileAtomic: (p, c) => void files.set(p, c),
    mkdirp: (p) => void dirs.add(p),
    isDir: (p) => dirs.has(p),
    unlink: (p) => void files.delete(p),
    readdir: (p) => [...dirs].filter((d) => d.startsWith(`${p}\\`)).map((d) => d.slice(p.length + 1)),
    rmrf: (p) => void dirs.delete(p),
    pidAlive: () => false,
    appPid: 4242,
    windowsHome: 'C:\\Users\\u',
    ...over,
  }
  return { io, files, dirs, calls }
}

// `ps -axo pid,ppid,rss,pcpu,stat,comm` as WSL prints it: a pane's zsh (812)
// running claude (900), which runs an MCP helper (950).
const PS = `    PID    PPID   RSS %CPU STAT COMMAND
      1       0  7616  0.0 Ss   systemd
    811       1  2000  0.0 Ss   init
    812     811  6000  0.1 Ss   zsh
    900     812 250000 12.0 Sl+ claude
    950     900 40000  0.5 Sl+  node
   1200       1  9000  0.0 S    sshd
`

describe('the win32 sweep runs ps inside WSL', () => {
  it('asks the distro for the same columns the Linux sweep uses', async () => {
    const { io, calls } = fakeIo({ outputs: { 'ps -axo': PS } })
    const w = createWin32(io)
    const out = await w.sweepMemory()
    expect(out).toBe(PS)
    expect(calls.at(-1)).toEqual(['-d', 'Ubuntu-24.04', '-e', 'ps', '-axo', SWEEP_COLUMNS])
    expect(SWEEP_COLUMNS).toBe('pid,ppid,rss,pcpu,stat,comm')
  })

  it('feeds the Linux parser, so a pane rooted at its Linux shell sees claude', async () => {
    const { io } = fakeIo({ outputs: { 'ps -axo': PS } })
    const tree = parsePsOutput(await createWin32(io).sweepMemory())
    const sum = sumSubtreeRss(tree, 812)
    expect(sum.pids.sort()).toEqual([812, 900, 950])
    expect(tree.rows.get(900)?.comm).toBe('claude')
  })

  it('reports no sample when wsl.exe cannot run', async () => {
    const { io } = fakeIo({ outputs: { 'ps -axo': null } })
    await expect(createWin32(io).sweepMemory()).resolves.toBe('')
  })

  it('declares metrics and cwd reporting, and still no verified kill', () => {
    const w = createWin32(fakeIo().io)
    expect(w.capabilities).toEqual({ verifiedKill: false, processMetrics: true, cwdReporting: true })
  })
})

describe('the win32 foreground check asks ps inside WSL', () => {
  it('passes the pane pts to ps -t and reads it with the shared classifier', async () => {
    const { io, calls } = fakeIo({ outputs: { 'ps -t pts/3': 'Ss   -zsh\nSl+  claude --resume x\n' } })
    const w = createWin32(io)
    await expect(w.checkForeground!('pts/3')).resolves.toBe(true)
    expect(calls.at(-1)).toEqual(['-d', 'Ubuntu-24.04', '-e', 'ps', '-t', 'pts/3', '-o', 'stat=,command='])
  })

  it('refuses a shell in the foreground', async () => {
    const { io } = fakeIo({ outputs: { 'ps -t': 'Ss+  -zsh\n' } })
    await expect(createWin32(io).checkForeground!('pts/3')).resolves.toBe(false)
  })

  it('refuses anything that is not a pts name without running ps', async () => {
    const { io, calls } = fakeIo()
    const w = createWin32(io)
    w.info()
    const before = calls.length
    await expect(w.checkForeground!('pts/3; rm -rf /')).resolves.toBe(false)
    await expect(w.checkForeground!('ttys004')).resolves.toBe(false)
    expect(calls.length).toBe(before)
  })
})

describe('the win32 pane spawn', () => {
  it('probes the distro, home and shell once', () => {
    const { io, calls } = fakeIo()
    const w = createWin32(io)
    expect(w.info()).toEqual({ distro: 'Ubuntu-24.04', home: HOME, shell: '/usr/bin/zsh' })
    w.info()
    w.loginShell()
    expect(calls.length).toBe(2)
  })

  it('writes the shim through the UNC path and returns its Linux path', () => {
    const { io, files, dirs } = fakeIo()
    dirs.add(`${UNC}\\Users\\joshwald\\.cache\\seashell-win\\pids\\17`)
    const w = createWin32(io)
    const shim = w.installShellIntegration()
    expect(shim).toBe(`${HOME}/.cache/seashell-win/zdotdir`)
    expect(files.get(`${UNC}\\Users\\joshwald\\.cache\\seashell-win\\zdotdir\\.zshrc`)).toContain('_seashell_osc7')
    expect(files.get(`${UNC}\\Users\\joshwald\\.cache\\seashell-win\\zdotdir\\.zshenv`)).toContain('SEASHELL_PIDFILE')
    // A dead app run's pid directory is cleared, this run's is made.
    expect(dirs.has(`${UNC}\\Users\\joshwald\\.cache\\seashell-win\\pids\\17`)).toBe(false)
    expect(dirs.has(`${UNC}\\Users\\joshwald\\.cache\\seashell-win\\pids\\4242`)).toBe(true)
  })

  it('spawns wsl.exe with the Linux cwd and the pane variables on the command line', () => {
    const { io, dirs } = fakeIo()
    dirs.add(`${UNC}\\Users\\joshwald\\Desktop`)
    const w = createWin32(io)
    const shim = w.installShellIntegration()
    const spec = w.paneSpawn!({ paneId: 'p1', cwd: '/Users/joshwald/Desktop', appVersion: '0.5.0', shellIntegration: shim, env: { A: '1' } })
    expect(spec).toEqual({
      ok: true,
      file: 'C:\\Windows\\System32\\wsl.exe',
      cwd: 'C:\\Users\\u',
      env: { A: '1' },
      args: [
        '-d', 'Ubuntu-24.04', '--cd', '/Users/joshwald/Desktop', '-e', 'env', '-u', 'COLORTERM',
        `ZDOTDIR=${HOME}/.cache/seashell-win/zdotdir`,
        `SEASHELL_USER_ZDOTDIR=${HOME}`,
        `SEASHELL_PIDFILE=${HOME}/.cache/seashell-win/pids/4242/pane-p1.pid`,
        'TERM=xterm-256color', 'TERM_PROGRAM=SeaShell', 'TERM_PROGRAM_VERSION=0.5.0', 'SEASHELL_PANE_ID=p1',
        'SEASHELL_APP_ID=win32-4242',
        '/usr/bin/zsh', '-l',
      ],
    })
  })

  it('opens the Windows home as the WSL home and maps drive paths', () => {
    const { io, dirs } = fakeIo()
    dirs.add(`${UNC}\\Users\\joshwald`)
    dirs.add(`${UNC}\\mnt\\c\\Work`)
    const w = createWin32(io)
    const home = w.paneSpawn!({ paneId: 'p', cwd: 'C:\\Users\\u', appVersion: '1', shellIntegration: null, env: {} })
    expect(home.ok && home.args.slice(2, 4)).toEqual(['--cd', HOME])
    const drive = w.paneSpawn!({ paneId: 'p', cwd: 'C:\\Work', appVersion: '1', shellIntegration: null, env: {} })
    expect(drive.ok && drive.args.slice(2, 4)).toEqual(['--cd', '/mnt/c/Work'])
  })

  it('refuses a cwd that is not a directory inside WSL', () => {
    const w = createWin32(fakeIo().io)
    expect(w.paneSpawn!({ paneId: 'p', cwd: '/nope', appVersion: '1', shellIntegration: null, env: {} })).toEqual({
      ok: false,
      message: 'not a directory: /nope',
    })
  })

  it('drops the shim rather than the pane when a value would need quoting', () => {
    const { io, dirs } = fakeIo()
    dirs.add(`${UNC}\\tmp`)
    const w = createWin32(io)
    const spec = w.paneSpawn!({ paneId: 'has space', cwd: '/tmp', appVersion: '1', shellIntegration: '/s', env: {} })
    // The pane id itself cannot cross, so the pane is refused, loudly.
    expect(spec.ok).toBe(false)
    const ok = w.paneSpawn!({ paneId: 'p', cwd: '/tmp', appVersion: '1', shellIntegration: '/odd dir', env: {} })
    expect(ok.ok && ok.args.some((a) => a.startsWith('ZDOTDIR='))).toBe(false)
  })

  it('clears a restarted pane pid file and reads the new one back', async () => {
    const { io, files, dirs } = fakeIo()
    dirs.add(`${UNC}\\tmp`)
    const pidWin = `${UNC}\\Users\\joshwald\\.cache\\seashell-win\\pids\\4242\\pane-p1.pid`
    files.set(pidWin, '111 pts/1\n')
    const w = createWin32(io)
    w.paneSpawn!({ paneId: 'p1', cwd: '/tmp', appVersion: '1', shellIntegration: w.installShellIntegration(), env: {} })
    expect(files.has(pidWin)).toBe(false)
    await expect(w.paneShell!('p1')).resolves.toBeNull()
    files.set(pidWin, '812 pts/3\n')
    await expect(w.paneShell!('p1')).resolves.toEqual({ pid: 812, tty: 'pts/3' })
  })

  it('never roots a pane at PowerShell', () => {
    const w = createWin32(fakeIo().io)
    expect(w.loginShell().file.toLowerCase()).toContain('wsl.exe')
    expect(w.loginShell().file.toLowerCase()).not.toContain('powershell')
  })

  it('points claude state at the WSL home through UNC', () => {
    const w = createWin32(fakeIo().io)
    expect(w.claudeHome!()).toBe(`${UNC}\\Users\\joshwald`)
    expect(w.homeDir!()).toBe(HOME)
  })

  it('falls back to the default distro and ~ when the probe fails', () => {
    const { io } = fakeIo({ runSync: () => null })
    const w = createWin32(io)
    expect(w.info()).toEqual({ distro: null, home: null, shell: '/usr/bin/zsh' })
    expect(w.installShellIntegration()).toBeNull()
    const spec = w.paneSpawn!({ paneId: 'p', cwd: 'C:\\Users\\u', appVersion: '1', shellIntegration: null, env: {} })
    expect(spec.ok && spec.args).toEqual(['--cd', '~', '-e', 'env', '-u', 'COLORTERM', 'TERM=xterm-256color', 'TERM_PROGRAM=SeaShell', 'TERM_PROGRAM_VERSION=1', 'SEASHELL_PANE_ID=p', 'SEASHELL_APP_ID=win32-4242', '/usr/bin/zsh', '-l'])
  })
})

describe('the win32 probe when WSL is cold', () => {
  it('does not keep a failed probe: it retries after the backoff and then caches the success', async () => {
    let t = 0
    let up = false
    const { io, calls } = fakeIo({
      now: () => t,
      runSync: (args) => {
        calls.push(args)
        if (!up) return null
        if (args[0] === '-l') return Buffer.from('Ubuntu-24.04\r\n', 'utf16le')
        return Buffer.from(`${HOME}\n/usr/bin/zsh\n`)
      },
    })
    const w = createWin32(io)
    expect(w.info().home).toBeNull()
    expect(w.claudeHome!()).toBeNull()
    const afterFail = calls.length
    // Inside the backoff nothing is run again.
    up = true
    t = 1000
    expect(w.info().home).toBeNull()
    expect(calls.length).toBe(afterFail)
    // Past it, the retry runs in the background and its success sticks.
    t = 5000
    w.info()
    await w.warmUp()
    expect(w.info().home).toBe(HOME)
    expect(w.claudeHome!()).toBe(`${UNC}\\Users\\joshwald`)
    const settled = calls.length
    t = 10_000_000
    w.info()
    expect(calls.length).toBe(settled)
  })

  it('warms up asynchronously with the long timeout, and never blocks while that runs', async () => {
    let release: (b: Buffer | null) => void = () => {}
    const timeouts: number[] = []
    const { io, calls } = fakeIo({
      runRaw: (args, timeoutMs) => {
        timeouts.push(timeoutMs)
        if (args[0] === '-l') return Promise.resolve(Buffer.from('Ubuntu-24.04\r\n', 'utf16le'))
        return new Promise((r) => (release = r))
      },
    })
    const w = createWin32(io)
    const warming = w.warmUp()
    await Promise.resolve()
    // While the probe is out, answers come back at once and nothing sync runs.
    expect(w.info().home).toBeNull()
    expect(calls.length).toBe(0)
    release(Buffer.from(`${HOME}\n/usr/bin/zsh\n`))
    await warming
    expect(w.info()).toEqual({ distro: 'Ubuntu-24.04', home: HOME, shell: '/usr/bin/zsh' })
    expect(Math.min(...timeouts)).toBeGreaterThan(8000)
    expect(calls.length).toBe(0)
  })

  it('stamps the app run into every pane it spawns', () => {
    const { io, dirs } = fakeIo()
    dirs.add(`${UNC}\\tmp`)
    const spec = createWin32(io).paneSpawn!({ paneId: 'p', cwd: '/tmp', appVersion: '1', shellIntegration: null, env: {} })
    expect(spec.ok && spec.args).toContain('SEASHELL_APP_ID=win32-4242')
  })
})

describe('wsl.exe output that was cut off', () => {
  it('is never returned: a timeout, a signal or maxBuffer gives null', () => {
    const partial = '    PID    PPID\n    812     811'
    expect(runResult(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM', code: null }), partial)).toBeNull()
    expect(runResult(Object.assign(new Error('m'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), partial)).toBeNull()
    expect(runResult(Object.assign(new Error('e'), { code: 'ENOENT' }), '')).toBeNull()
    expect(runResult(Object.assign(new Error('x'), { code: 1 }), partial)).toBeNull()
  })

  it('keeps complete output from a plain non-zero exit only when the caller accepts one', () => {
    const out = '900 (claude) S 812\n'
    expect(runResult(null, out)).toBe(out)
    expect(runResult(Object.assign(new Error('x'), { code: 1 }), out, { acceptExitCode: true })).toBe(out)
    expect(
      runResult(Object.assign(new Error('t'), { code: 1, killed: true }), out, { acceptExitCode: true })
    ).toBeNull()
  })

  it('reports no sweep when ps did not finish, so no tick or lookup judges a pane from it', async () => {
    const { io } = fakeIo({ run: async () => null })
    await expect(createWin32(io).sweepMemory()).resolves.toBe('')
  })

  it('accepts the exit of a cat batch where one pid has gone', async () => {
    const seen: Array<{ acceptExitCode?: boolean } | undefined> = []
    const { io } = fakeIo({
      run: async (args, opts) => {
        seen.push(opts)
        return args.includes('cat') ? '' : null
      },
    })
    await createWin32(io).processStartTokens([900, 901])
    expect(seen.at(-1)).toEqual({ acceptExitCode: true })
  })
})
