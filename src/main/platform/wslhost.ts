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
  /** tasklist.exe through /mnt/c; true on any error, so a live run is never swept. */
  windowsPidAlive(pid: number): boolean
}

/** The four variables this platform adds on top of buildEnv. */
const EXTRA_KEYS = new Set(['SEASHELL_PIDFILE', 'SEASHELL_APP_ID', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'])

export function createWslhost(io: WslhostIo): Platform {
  let shimDir: string | null = null
  const home = io.home.replace(/\/+$/, '')
  const appId = appInstanceId('win32', io.hostPid)
  return {
    ...linux,
    controlTransport: 'tcp',
    paneAppId: appId,
    // Plan decision 6: today's checker would offer the Linux AppImage; the
    // banner is built and tested with an injected state instead.
    updater: 'off',
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

/** Creating it does no I/O; the shim and the sweep wait for installShellIntegration. */
export const wslhost: Platform = createWslhost({
  hostPid: Number(process.env.SEASHELL_HOST_PID) || process.ppid,
  home: os.homedir(),
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
  windowsPidAlive,
})
