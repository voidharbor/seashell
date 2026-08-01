import type { KillRow } from '../monitor/procsweep.js'

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

export interface Platform {
  readonly id: NodeJS.Platform
  readonly capabilities: PlatformCapabilities

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

  /** Ends a pane and everything it started. */
  killPaneTree(req: KillRequest): Promise<KillResult>

  /** The terminal face to load, or null to fall back to a generic monospace. */
  terminalFontPath(): string | null
}

/** Thrown by a platform for something it genuinely cannot do. */
export function notSupported(what: string, platform: NodeJS.Platform): Error {
  return new Error(`${what} is not supported on ${platform}`)
}
