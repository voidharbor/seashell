import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { linux } from './linux.js'
import type { Platform } from './types.js'
import { appInstanceId, paneVars, pidDirFor, pidFileFor, shimDirFor, WSL_STATE_DIR, wslShimFiles } from '../../shared/wsl-shell.js'

/**
 * The native Windows shell's platform: Linux ptys, Linux fs and sweeps, with
 * the Windows pane identity contract on top (spec 4.4). Selected by
 * SEASHELL_HOST=native-win, never by process.platform.
 *
 * main runs inside WSL here, so everything process-shaped is plain Linux and
 * comes from `linux`. What is Windows-shaped is the identity a pane carries:
 * SEASHELL_APP_ID is `win32-<shell pid>` (send-to-pane.py routes on the
 * `win32` half), and the pid files live under the same
 * `~/.cache/seashell-win/pids/<shell pid>/` the Electron Windows build uses.
 */
export interface WslhostIo {
  /** SEASHELL_HOST_PID: the Windows pid of the native shell. */
  hostPid: number
  /** os.homedir(), the Linux home. */
  home: string
  appVersion: string
  mkdirp(dir: string): void
  writeFileAtomic(file: string, contents: string): void
  readdir(dir: string): string[]
  rmrf(dir: string): void
  /** Throws when the file cannot be read. */
  readFile(file: string): string
  unlink(file: string): void
  /** Removes an empty folder; a folder that is not empty, or is gone, is left as it is. */
  rmdirIfEmpty(dir: string): void
  /** tasklist.exe through /mnt/c; true on any error, so a live run is never swept. */
  windowsPidAlive(pid: number): boolean
  /**
   * SEASHELL_INSTALLED is '1': the shell runs from the installed path, or a
   * test run asked to be treated as installed (core_proc.cpp).
   */
  installed: boolean
  /** Runs `fn` once as the core exits (process 'exit': after main's drain, or the shim's cap). */
  onExit(fn: () => void): void
}

/** The four variables this platform adds on top of buildEnv. */
const EXTRA_KEYS = new Set(['SEASHELL_PIDFILE', 'SEASHELL_APP_ID', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'])

export function createWslhost(io: WslhostIo): Platform {
  let shimDir: string | null = null
  let exitArmed = false
  /** Pane id to the pid of the shell this core spawned for it (the `$$` its pid file records). */
  const spawned = new Map<string, number>()
  const home = io.home.replace(/\/+$/, '')
  const appId = appInstanceId('win32', io.hostPid)
  return {
    ...linux,
    controlTransport: 'tcp',
    paneAppId: appId,
    // Only the installed build checks, and only for the win-native zip: a
    // release with just the Mac zip leaves it idle, and it never installs
    // (canInstall is darwin only), so the banner offers the release page.
    updater: io.installed ? 'on' : 'off',
    updateChannel: 'win-native',
    terminalFontPath: () => null,

    installShellIntegration(): string | null {
      const dir = shimDirFor(home)
      try {
        io.mkdirp(dir)
        for (const [name, contents] of Object.entries(wslShimFiles())) io.writeFileAtomic(`${dir}/${name}`, contents)
        // Pid directories are keyed by Windows pids, so liveness is asked of Windows.
        const pidsRoot = `${home}/${WSL_STATE_DIR}/pids`
        io.mkdirp(pidsRoot)
        for (const name of io.readdir(pidsRoot)) {
          if (!/^\d+$/.test(name)) continue
          const other = Number(name)
          if (other !== io.hostPid && !io.windowsPidAlive(other)) io.rmrf(`${pidsRoot}/${name}`)
        }
        io.mkdirp(pidDirFor(home, io.hostPid))
        // At quit this core removes its own panes' pid files and then the host
        // folder only if that leaves it empty. A core the shell restarted at
        // once shares the folder and can mint the same pane ids, so a file goes
        // only when it still records the shell this core spawned for that pane.
        if (!exitArmed && Number.isInteger(io.hostPid) && io.hostPid > 0) {
          exitArmed = true
          const mine = pidDirFor(home, io.hostPid)
          io.onExit(() => {
            for (const [paneId, pid] of spawned) {
              const file = pidFileFor(home, io.hostPid, paneId)
              try {
                if (io.readFile(file).trim().split(/\s+/)[0] === String(pid)) io.unlink(file)
              } catch {
                /* gone already, or unreadable: left as it is */
              }
            }
            try {
              io.rmdirIfEmpty(mine)
            } catch {
              /* the next start's sweep removes it */
            }
          })
        }
        shimDir = dir
        return dir
      } catch (err) {
        console.warn('[seashell] could not write the WSL ZDOTDIR shim:', err)
        shimDir = null
        return null
      }
    },

    paneEnvExtras(paneId: string): Array<[string, string]> {
      // userZdotdir null: buildEnv already set the ZDOTDIR pair, paneVars must not
      // repeat it. pidFile stays out of the call too, since paneVars only emits it
      // alongside that pair; the real path is prepended below instead.
      const vars = paneVars({
        paneId,
        appVersion: io.appVersion,
        shimDir: null,
        userZdotdir: null,
        pidFile: null,
        appId,
      })
      const out = vars.filter(([k]) => EXTRA_KEYS.has(k))
      if (shimDir !== null) out.unshift(['SEASHELL_PIDFILE', pidFileFor(home, io.hostPid, paneId)])
      return out
    },

    paneSpawned(paneId: string, pid: number): void {
      spawned.set(paneId, pid)
    },
  }
}

function windowsPidAlive(pid: number): boolean {
  try {
    const out = execFileSync('/mnt/c/Windows/System32/tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new RegExp(`\\s${pid}\\s`).test(out)
  } catch {
    return true
  }
}

/** The real io for a host pid and a home; the unit tests point it at a temp home. */
export function nodeWslhostIo(hostPid: number, home: string): WslhostIo {
  return {
    hostPid,
    home,
    appVersion: process.env.SEASHELL_CORE_VERSION ?? '0.0.0',
    mkdirp: (d) => fs.mkdirSync(d, { recursive: true }),
    writeFileAtomic: (f, c) => {
      const tmp = `${f}.${process.pid}.tmp`
      fs.writeFileSync(tmp, c)
      fs.renameSync(tmp, f)
    },
    readdir: (d) => {
      try {
        return fs.readdirSync(d)
      } catch {
        return []
      }
    },
    rmrf: (d) => fs.rmSync(d, { recursive: true, force: true }),
    readFile: (f) => fs.readFileSync(f, 'utf8'),
    unlink: (f) => fs.unlinkSync(f),
    rmdirIfEmpty: (d) => {
      try {
        fs.rmdirSync(d)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw err
      }
    },
    windowsPidAlive,
    installed: process.env.SEASHELL_INSTALLED === '1',
    onExit: (fn) => {
      process.once('exit', fn)
    },
  }
}

/** Creating it does no I/O; the shim and the sweep wait for installShellIntegration. */
export const wslhost: Platform = createWslhost(nodeWslhostIo(Number(process.env.SEASHELL_HOST_PID) || process.ppid, os.homedir()))
