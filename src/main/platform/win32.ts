import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KillRow } from '../monitor/procsweep.js'
import { foregroundIsClaude } from '../control/foreground.js'
import { procStartFromStat } from '../state/session-lookup.js'
import {
  appInstanceId,
  paneVars,
  parseDistroList,
  parseHomeShellProbe,
  parsePidFile,
  pidDirFor,
  pidFileFor,
  shimDirFor,
  toLinuxPath,
  wslShimFiles,
  wslSpawnArgs,
  wslUncPath,
  WSL_STATE_DIR,
} from '../../shared/wsl-shell.js'
import { wslDistro } from '../../shared/wsl-path.js'
import {
  notSupported,
  type KillRequest,
  type KillResult,
  type PaneShell,
  type PaneSpawnRequest,
  type PaneSpawnResult,
  type Platform,
  type ShellSpec,
} from './types.js'

/**
 * Windows: every pane runs inside WSL.
 *
 * node-pty spawns `wsl.exe` through ConPTY and wsl.exe starts the user's Linux
 * login shell, so a pane on Windows is the same zsh, the same dotfiles and the
 * same `claude` as on Linux. PowerShell is never used. Pane working
 * directories are Linux paths end to end; `--cd` takes them as they are.
 *
 * The consequence that shapes the rest of this file: the pty's own child is
 * wsl.exe, a Windows process that says nothing about what runs in the pane.
 * Everything that inspects processes therefore looks inside WSL instead:
 *
 *  - The ZDOTDIR shim is written into the WSL filesystem through
 *    `\\wsl.localhost\<distro>\...`, and its `.zshenv` records the shell's
 *    Linux pid and pts into a per-pane pid file. `paneShell` reads it back,
 *    and the pty manager roots metrics and session lookup at that pid.
 *  - The metrics sweep is `wsl.exe -e ps` with the Linux columns, fed to the
 *    same parser, so claude detection and the pane badges behave as on Linux.
 *  - The control socket's foreground check is `wsl.exe -e ps -t pts/N`.
 *  - Process start tokens are `/proc/<pid>/stat`, read by `wsl.exe -e cat`.
 *
 * The distro, the WSL home and the login shell are probed with two short
 * wsl.exe runs, asynchronously and early (`warmUp`, called from index.ts
 * before the window opens), so no IPC handler ever blocks on a cold WSL. Only
 * a probe that found the home is cached. A failed one (WSL still booting after
 * a reboot or `wsl --shutdown`) is retried with backoff, never kept for the
 * life of the app.
 *
 * What is still honestly missing:
 *  - **No verified kill.** Closing the pseudoconsole ends wsl.exe and the WSL
 *    session's pty, so the shell and its foreground job get SIGHUP. A process
 *    that detached survives and nothing here counts it.
 *  - **No terminal font.** The face darwin loads belongs to Terminal.app.
 */

/** Everything win32 does to the outside world, so tests can replace it. */
export interface WslIo {
  /** Absolute path to wsl.exe. */
  wslExe: string
  /**
   * Runs wsl.exe with argv and returns its stdout. Null when it could not run,
   * was stopped by the timeout, overflowed its buffer, or exited non-zero:
   * partial output from a cut-off `ps` is not a process table. A caller whose
   * command legitimately exits non-zero with complete output (`cat` of several
   * /proc files where one pid has gone) passes `acceptExitCode`.
   */
  run(args: string[], opts?: RunOptions): Promise<string | null>
  /** Same, synchronously and raw, for a probe asked for before `warmUp`. */
  runSync(args: string[]): Buffer | null
  /** Same, asynchronously and raw, for the startup probe. Falls back to
   *  `runSync` when absent (tests). */
  runRaw?(args: string[], timeoutMs: number): Promise<Buffer | null>
  /** Milliseconds, for the probe's retry backoff. Date.now when absent. */
  now?(): number
  readFile(p: string): Promise<string>
  writeFileAtomic(p: string, contents: string): void
  mkdirp(p: string): void
  isDir(p: string): boolean
  unlink(p: string): void
  readdir(p: string): string[]
  rmrf(p: string): void
  /** Whether a Windows pid is alive. */
  pidAlive(pid: number): boolean
  /** This app's own pid. */
  appPid: number
  /** The Windows home, which is where wsl.exe itself is started. */
  windowsHome: string
  /** A distro named by SEASHELL_WSL_DISTRO, which wins over the probe. */
  distroOverride?: string | null
}

export interface RunOptions {
  /** Keep stdout when the command exited non-zero on its own (never on a
   *  timeout, a signal or a buffer overflow). */
  acceptExitCode?: boolean
}

const RUN_TIMEOUT_MS = 8000
/** A cold WSL (systemd starting after a reboot) can take well over 8 s. */
const PROBE_TIMEOUT_MS = 30_000
/** Retry backoff after a failed probe, doubling up to the cap. */
const PROBE_RETRY_FIRST_MS = 2000
const PROBE_RETRY_MAX_MS = 60_000
const DEFAULT_SHELL = '/usr/bin/zsh'

/**
 * What an execFile callback means for `run`: stdout only for a clean exit, or
 * for a plain non-zero exit when the caller accepts one. A timeout, a signal
 * and maxBuffer all leave a partial stdout behind, which is never returned.
 * Exported for tests. [pure]
 */
export function runResult(err: unknown, stdout: unknown, opts?: RunOptions): string | null {
  if (typeof stdout !== 'string') return null
  if (!err) return stdout
  const e = err as { code?: unknown; killed?: unknown; signal?: unknown }
  const exitedNonZero = typeof e.code === 'number' && e.killed !== true && !e.signal
  return opts?.acceptExitCode && exitedNonZero ? stdout : null
}

function defaultIo(): WslIo {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  const wslExe = path.win32.join(root, 'System32', 'wsl.exe')
  return {
    wslExe,
    run: (args, opts) =>
      new Promise((resolve) => {
        execFile(
          wslExe,
          args,
          { windowsHide: true, timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
          (err, stdout) => resolve(runResult(err, stdout, opts))
        )
      }),
    runRaw: (args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(
          wslExe,
          args,
          { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'buffer' },
          (err, stdout) => resolve(err || !Buffer.isBuffer(stdout) ? null : stdout)
        )
      }),
    now: () => Date.now(),
    runSync: (args) => {
      try {
        return execFileSync(wslExe, args, { windowsHide: true, timeout: RUN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return null
      }
    },
    readFile: (p) => fs.promises.readFile(p, 'utf8'),
    writeFileAtomic: (target, contents) => {
      try {
        if (fs.readFileSync(target, 'utf8') === contents) return
      } catch {
        /* missing: write it */
      }
      const tmp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(tmp, contents, 'utf8')
      try {
        fs.renameSync(tmp, target)
      } catch (err) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* nothing further */
        }
        throw err
      }
    },
    mkdirp: (p) => void fs.mkdirSync(p, { recursive: true }),
    isDir: (p) => {
      try {
        return fs.statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    unlink: (p) => {
      try {
        fs.unlinkSync(p)
      } catch {
        /* already gone */
      }
    },
    readdir: (p) => {
      try {
        return fs.readdirSync(p)
      } catch {
        return []
      }
    },
    rmrf: (p) => {
      try {
        fs.rmSync(p, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    appPid: process.pid,
    windowsHome: os.homedir(),
    distroOverride: process.env['SEASHELL_WSL_DISTRO']?.trim() ? wslDistro() : null,
  }
}

/** What the startup probe learned. */
export interface WslInfo {
  distro: string | null
  /** The WSL user's home, or null when the probe failed. */
  home: string | null
  /** The WSL user's login shell. zsh when the probe could not say. */
  shell: string
}

/** The columns the Linux sweep asks `ps` for (procsweep.ts, psSweepMemory). */
export const SWEEP_COLUMNS = 'pid,ppid,rss,pcpu,stat,comm'

/**
 * `cat /proc/a/stat /proc/b/stat ...` output, one stat line per live pid, to
 * pid -> start token. The pid is the first field of each line, so a pid that
 * vanished between the call and the read simply has no line. [pure]
 */
export function parseStatBatch(stdout: string, wanted: readonly number[]): Map<number, string> {
  const want = new Set(wanted)
  const out = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const m = /^(\d+) \(/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (!want.has(pid)) continue
    const token = procStartFromStat(line)
    if (token !== undefined) out.set(pid, token)
  }
  return out
}

/** Builds the Windows platform over `io`. Exported for tests. */
export function createWin32(io: WslIo): Platform & {
  /** The probe: cached once it found the home, otherwise the last failure. */
  info(): WslInfo
  /** Runs the probe asynchronously (deduplicated) and resolves once it settles. */
  warmUp(): Promise<void>
} {
  /** Only ever a probe that found the WSL home. */
  let cached: WslInfo | null = null
  /** The last failed probe and when it may be retried. */
  let failed: { info: WslInfo; retryAt: number; delay: number } | null = null
  let inflight: Promise<void> | null = null
  const now = (): number => (io.now ? io.now() : Date.now())
  const unknown = (): WslInfo => ({ distro: io.distroOverride ?? null, home: null, shell: DEFAULT_SHELL })

  const probeArgs = (distro: string | null): string[] => [
    ...(distro ? ['-d', distro] : []),
    '-e',
    'sh',
    '-c',
    'echo $HOME; getent passwd $(id -un) | cut -d: -f7',
  ]

  const result = (distro: string | null, probed: Buffer | null): WslInfo => {
    const { home, shell } = parseHomeShellProbe(probed ? probed.toString('utf8') : '')
    return { distro, home, shell: shell ?? DEFAULT_SHELL }
  }

  /** Keeps a success for good; a failure only until its backoff runs out. */
  const settle = (got: WslInfo): WslInfo => {
    if (got.home !== null) {
      cached = got
      failed = null
      return got
    }
    const delay = failed ? Math.min(failed.delay * 2, PROBE_RETRY_MAX_MS) : PROBE_RETRY_FIRST_MS
    failed = { info: got, retryAt: now() + delay, delay }
    return got
  }

  const probeSync = (): WslInfo => {
    let distro = io.distroOverride ?? null
    if (distro === null) {
      const listed = io.runSync(['-l', '-q'])
      distro = listed ? (parseDistroList(listed)[0] ?? null) : null
    }
    return result(distro, io.runSync(probeArgs(distro)))
  }

  const probeAsync = async (): Promise<WslInfo> => {
    if (!io.runRaw) return probeSync()
    let distro = io.distroOverride ?? null
    if (distro === null) {
      const listed = await io.runRaw(['-l', '-q'], PROBE_TIMEOUT_MS)
      distro = listed ? (parseDistroList(listed)[0] ?? null) : null
    }
    return result(distro, await io.runRaw(probeArgs(distro), PROBE_TIMEOUT_MS))
  }

  const warmUp = (): Promise<void> => {
    if (cached) return Promise.resolve()
    // A failed probe backs off; asking again early just answers with it.
    if (!inflight && failed && now() < failed.retryAt) return Promise.resolve()
    inflight ??= probeAsync()
      .then(settle, () => settle(unknown()))
      .then(() => undefined)
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  /**
   * Never blocks while an async probe is running or a failed one is backing
   * off: it answers with what is known and lets the retry run in the
   * background. The synchronous probe runs only when nothing ever warmed it.
   */
  const info = (): WslInfo => {
    if (cached) return cached
    if (failed) {
      if (now() >= failed.retryAt) void warmUp()
      return failed.info
    }
    if (inflight) return unknown()
    return settle(probeSync())
  }

  /** `-d <distro>` or nothing, for every wsl.exe run. */
  const target = (): string[] => {
    const d = info().distro
    return d ? ['-d', d] : []
  }

  /** A Linux path as Windows reaches it, or null without a distro. */
  const unc = (linuxPath: string): string | null => {
    const d = info().distro
    return d ? wslUncPath(d, linuxPath) : null
  }

  return {
    id: 'win32',

    capabilities: {
      verifiedKill: false,
      processMetrics: true,
      cwdReporting: true,
    },

    info,
    warmUp,

    /** The generic form, for display. Panes use `paneSpawn`. */
    loginShell(): ShellSpec {
      const { shell } = info()
      return { file: io.wslExe, args: [...target(), '-e', shell, '-l'] }
    },

    /**
     * Writes the shim under `~/.cache/seashell-win/zdotdir` in the WSL home and
     * returns its LINUX path, which is what ZDOTDIR must hold. Also clears pid
     * directories left by app runs that are no longer alive.
     */
    installShellIntegration(): string | null {
      const { home } = info()
      if (home === null) return null
      const shimLinux = shimDirFor(home)
      const shimWin = unc(shimLinux)
      if (shimWin === null) return null
      try {
        io.mkdirp(shimWin)
        for (const [name, contents] of Object.entries(wslShimFiles())) {
          io.writeFileAtomic(`${shimWin}\\${name}`, contents)
        }
        const pidsRoot = unc(`${home}/${WSL_STATE_DIR}/pids`)
        const mine = unc(pidDirFor(home, io.appPid))
        if (pidsRoot && mine) {
          for (const name of io.readdir(pidsRoot)) {
            const other = Number(name)
            if (Number.isInteger(other) && other !== io.appPid && !io.pidAlive(other)) {
              io.rmrf(`${pidsRoot}\\${name}`)
            }
          }
          io.mkdirp(mine)
        }
        return shimLinux
      } catch (err) {
        console.warn('[seashell] could not write the WSL ZDOTDIR shim:', err)
        return null
      }
    },

    paneSpawn(req: PaneSpawnRequest): PaneSpawnResult {
      const { home, shell, distro } = info()

      // The renderer's default cwd is the app's home, which on Windows is the
      // Windows profile; the pane's home is the WSL one.
      let linuxCwd: string | null
      if (req.cwd === io.windowsHome) linuxCwd = home ?? '~'
      else linuxCwd = toLinuxPath(req.cwd)
      if (linuxCwd === null) return { ok: false, message: `not a directory: ${req.cwd}` }
      if (linuxCwd !== '~') {
        const where = unc(linuxCwd)
        if (where !== null && !io.isDir(where)) return { ok: false, message: `not a directory: ${linuxCwd}` }
      }

      const pidFile = home !== null && req.shellIntegration !== null ? pidFileFor(home, io.appPid, req.paneId) : null
      if (pidFile !== null) {
        // A restarted pane must not read its previous shell's pid.
        const old = unc(pidFile)
        if (old) io.unlink(old)
      }

      const build = (withShim: boolean): string[] =>
        wslSpawnArgs({
          distro,
          cwd: linuxCwd!,
          shell,
          vars: paneVars({
            paneId: req.paneId,
            appVersion: req.appVersion,
            shimDir: withShim ? req.shellIntegration : null,
            userZdotdir: withShim ? home : null,
            pidFile: withShim ? pidFile : null,
            appId: appInstanceId('win32', io.appPid),
          }),
        })

      let args: string[]
      try {
        args = build(true)
      } catch {
        try {
          // An odd home or pane id costs the shim, not the pane.
          args = build(false)
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) }
        }
      }
      return { ok: true, file: io.wslExe, args, cwd: io.windowsHome, env: req.env }
    },

    async paneShell(paneId: string): Promise<PaneShell | null> {
      const { home } = info()
      if (home === null) return null
      const p = unc(pidFileFor(home, io.appPid, paneId))
      if (p === null) return null
      try {
        return parsePidFile(await io.readFile(p))
      } catch {
        return null
      }
    },

    async checkForeground(ttyName: string): Promise<boolean> {
      if (!/^pts\/\d+$/.test(ttyName)) return false
      const out = await io.run([...target(), '-e', 'ps', '-t', ttyName, '-o', 'stat=,command='])
      return out !== null && foregroundIsClaude(out)
    },

    claudeHome(): string | null {
      const { home } = info()
      return home === null ? null : unc(home)
    },

    homeDir(): string | null {
      return info().home
    },

    async sweepMemory(): Promise<string> {
      return (await io.run([...target(), '-e', 'ps', '-axo', SWEEP_COLUMNS])) ?? ''
    },

    /** claude inside WSL is a Linux process and records field 22 of its stat. */
    async processStartTokens(pids: number[]): Promise<Map<number, string>> {
      const list = pids.filter((p) => Number.isInteger(p) && p > 0)
      if (list.length === 0) return new Map()
      // cat exits 1 when a pid vanished between the list and the read; the
      // lines for the others are complete, so that exit is accepted.
      const out = await io.run([...target(), '-e', 'cat', ...list.map((p) => `/proc/${p}/stat`)], {
        acceptExitCode: true,
      })
      return out === null ? new Map() : parseStatBatch(out, list)
    },

    sweepForKill(): Promise<KillRow[]> {
      // killPaneTree below does not walk process groups. Rejecting rather than
      // returning [] means a future caller finds out instead of reaping nothing.
      return Promise.reject(notSupported('process-group sweeping', 'win32'))
    },

    /**
     * Closes the pseudoconsole: wsl.exe exits and the Linux side of the pane
     * gets SIGHUP. `survivors: 0` means none counted, not none exist; that is
     * what `capabilities.verifiedKill: false` says.
     */
    async killPaneTree(req: KillRequest): Promise<KillResult> {
      try {
        req.killPty()
      } catch {
        /* already gone */
      }
      return Promise.resolve({ survivors: 0 })
    },

    terminalFontPath(): string | null {
      return null
    },
  }
}

export const win32 = createWin32(defaultIo())
