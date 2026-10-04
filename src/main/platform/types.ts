import type { KillRow } from '../monitor/procsweep.js'
import type { UpdateChannel } from '../update/check.js'

/**
 * The platform boundary.
 *
 * SeaShell is a macOS app in ways that are not incidental: panes are rooted at
 * `/bin/zsh -l`, the kill ladder is POSIX signals aimed at process groups, the
 * working-directory reporting is a ZDOTDIR shim, the process sweeps shell out
 * to `ps`, and the terminal font is read out of Terminal.app's own bundle.
 * None of those exist on Windows.
 *
 * Everything genuinely OS-specific is named here so that a port is a matter of
 * writing one more file rather than hunting through the main process. Note what
 * is deliberately *absent*: `shell.openPath` and `shell.showItemInFolder` are
 * Electron's own cross-platform APIs and need no abstraction, and the path
 * guards around them are about executable content rather than about macOS.
 */

export interface ShellSpec {
  /** Absolute path to the binary. Never a shell string. */
  file: string
  args: string[]
}

export interface KillRequest {
  shellPid: number
  /** The pane's controlling terminal, where the platform has such a concept. */
  ttyName: string | null
  /** The pty handle's own kill, as the last rung. */
  killPty: () => void
}

export interface KillResult {
  /**
   * Processes still alive after the ladder ran. Must never be optimistic — a
   * pane reported clean while an agent survives is the exact failure this app
   * exists to prevent. Platforms that cannot count honestly say so through
   * `capabilities.verifiedKill` instead of guessing zero.
   */
  survivors: number
}

/**
 * What a platform can actually do, stated rather than assumed.
 *
 * This exists so that an unfinished port degrades visibly instead of quietly.
 * A build that launches, spawns a shell, and silently leaks every process it
 * ever started is worse than one that admits the gap.
 */
export interface PlatformCapabilities {
  /** Whether `killPaneTree` can verify that nothing outlived the pane. */
  verifiedKill: boolean
  /** Whether per-pane memory and CPU sampling works. */
  processMetrics: boolean
  /** Whether the shell reports its working directory as it changes. */
  cwdReporting: boolean
}

/** What the pty manager knows when it opens a pane. */
export interface PaneSpawnRequest {
  paneId: string
  /** The requested working directory, as the renderer sent it. */
  cwd: string
  appVersion: string
  /** Whatever `installShellIntegration` returned. */
  shellIntegration: string | null
  /** The environment `buildEnv` produced for the pty process itself. */
  env: NodeJS.ProcessEnv
}

/** The full pty spawn for one pane, or why the pane cannot open. */
export type PaneSpawnResult =
  | { ok: true; file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
  | { ok: false; message: string }

/** The process that really is a pane's shell, where that is not the pty's child. */
export interface PaneShell {
  pid: number
  /** In `ps -o tty` form, e.g. `pts/3`. */
  tty: string | null
}

export interface Platform {
  readonly id: NodeJS.Platform
  readonly capabilities: PlatformCapabilities

  /** 'tcp' selects the loopback-plus-token control endpoint on any OS (the native Windows shell runs main inside WSL). */
  readonly controlTransport?: 'tcp' | 'unix'

  /** Extra pane environment, applied after buildEnv. The wslhost platform stamps the Windows pane identity here. */
  paneEnvExtras?(paneId: string): Array<[string, string]>

  /** The SEASHELL_APP_ID this platform stamps on its panes itself, so session lookup matches the registry entries they write (wslhost). */
  readonly paneAppId?: string

  /**
   * 'off' skips main's update check (wslhost: every native Windows shell but
   * the installed one, so a scratch or dev build never shows the banner).
   * Absent means on.
   */
  readonly updater?: 'on' | 'off'

  /** The release asset the update check looks for. Absent means 'universal'. */
  readonly updateChannel?: UpdateChannel

  /**
   * Optional: the whole spawn for a pane, cwd validation included. Absent
   * means the default (`loginShell()` in the requested cwd). win32 uses it to
   * run every pane through wsl.exe with the Linux cwd on the command line.
   */
  paneSpawn?(req: PaneSpawnRequest): PaneSpawnResult

  /**
   * Optional: the pane's real shell pid and tty, when the pty's own child is
   * a launcher (win32: wsl.exe). Null until the shell has reported itself.
   * Pids from here are the ones `sweepMemory` and `processStartTokens` see.
   */
  paneShell?(paneId: string): Promise<PaneShell | null>

  /**
   * Optional: whether claude owns the foreground of `ttyName`, for platforms
   * where `ps` is not local (win32 asks inside WSL). Absent means the default
   * check in control/foreground-check.ts.
   */
  checkForeground?(ttyName: string): Promise<boolean>

  /**
   * Optional: the directory holding `.claude/`, when it is not `os.homedir()`
   * (win32: the WSL home as a `\\wsl.localhost\` path).
   */
  claudeHome?(): string | null

  /** Optional: the home a pane opens in by default, when it is not `os.homedir()`. */
  homeDir?(): string | null

  /**
   * Optional: learns, asynchronously, whatever `claudeHome`, `homeDir` and
   * `paneSpawn` depend on (win32: the WSL distro, home and shell), so no IPC
   * handler blocks on it. Safe to call repeatedly; it resolves once the
   * attempt settles, successful or not.
   */
  warmUp?(): Promise<void>

  /** The shell every pane is rooted at. */
  loginShell(): ShellSpec

  /**
   * Installs whatever makes the shell report its working directory, returning
   * a value to pass to `buildEnv`, or null when the platform has none.
   */
  installShellIntegration(): string | null

  /** `ps`-shaped stdout for the metrics parser. Empty string means no sample. */
  sweepMemory(): Promise<string>

  /** The wider sweep the kill ladder walks. */
  sweepForKill(): Promise<KillRow[]>

  /**
   * The start time of each live pid, spelled exactly the way claude records it
   * as `procStart` in ~/.claude/sessions/<pid>.json, so a pid file can be
   * proven to belong to the process that holds that pid now. Dead pids are
   * absent. A platform that cannot spell it returns an empty map, which turns
   * the process lane of session lookup off rather than letting it guess.
   */
  processStartTokens(pids: number[]): Promise<Map<number, string>>

  /** Ends a pane and everything it started. */
  killPaneTree(req: KillRequest): Promise<KillResult>

  /** The terminal face to load, or null to fall back to a generic monospace. */
  terminalFontPath(): string | null
}

/** Thrown by a platform for something it genuinely cannot do. */
export function notSupported(what: string, platform: NodeJS.Platform): Error {
  return new Error(`${what} is not supported on ${platform}`)
}
