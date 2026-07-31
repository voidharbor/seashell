/**
 * Builds the environment for a pane's PTY root, which is always a login
 * shell (`/bin/zsh -l`) — see spec §6.1.
 *
 * This module is [pure]: it never reads `process.env` or calls into
 * `electron` (`app.getVersion()`) or Node's `crypto` (for a pane uuid)
 * itself. Everything environment-shaped that main would otherwise fetch is
 * instead passed in by the caller, so the merge/delete/set logic — the part
 * with actual rules to get right — is testable against a fabricated base env
 * with no process, app, or Electron involved.
 */

/** Inputs the (impure) caller in main must supply, since this module cannot
 * fetch any of them itself without breaking purity. */
export interface BuildEnvOptions {
  /** Base environment to start from, typically `process.env`. Never mutated. */
  baseEnv: NodeJS.ProcessEnv
  /** This pane's id, exposed to the shell as `SEASHELL_PANE_ID`. */
  paneId: string
  /** SeaShell's own version, e.g. from `app.getVersion()`. */
  appVersion: string
  /** Absolute path to the ZDOTDIR shim directory written once per app launch (§6.2). */
  zdotdirShimPath: string
  /**
   * Per-pane, explicit, unpersisted opt-out that sets `COLORTERM=truecolor`.
   * Defaults to `false`.
   *
   * The default (`COLORTERM` deleted) is deliberate, not an oversight: per
   * §6.1's resolved conflict, Claude Code 2.1.220's color-depth table checks
   * `TERM_PROGRAM` first (8-bit for `Apple_Terminal`, 24-bit for known
   * truecolor terminals), then falls through to `COLORTERM === 'truecolor'`
   * (24-bit), then `TERM.startsWith('xterm-256')` (8-bit). Setting
   * `COLORTERM=truecolor` would push Claude Code onto the 24-bit path and
   * render visibly different shades than Apple Terminal's default 8-bit
   * path — an instant fidelity violation. Plain `xterm-256color` with no
   * `COLORTERM` reproduces Apple Terminal's exact palette path instead.
   */
  truecolorOptOut?: boolean
}

/**
 * Returns a new environment object for a spawned login shell. Never mutates
 * `baseEnv` (or, transitively, `process.env`) — callers must be free to
 * inspect the original after calling this.
 */
export function buildEnv(options: BuildEnvOptions): NodeJS.ProcessEnv {
  const { baseEnv, paneId, appVersion, zdotdirShimPath, truecolorOptOut = false } = options
  const env: NodeJS.ProcessEnv = { ...baseEnv }

  // Strip anything that would leak Electron's or npm's own process identity
  // into a shell whose whole point is to look like a normal login shell.
  delete env.COLORTERM
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key.startsWith('npm_')) {
      delete env[key]
    }
  }

  // ZDOTDIR redirect: point zsh at SeaShell's shim dir, but remember the
  // user's real ZDOTDIR (falling back to $HOME, zsh's own default search
  // location) so the shim can source the user's real dotfiles first.
  const userZdotdir = env.ZDOTDIR ?? env.HOME ?? ''
  env.SEASHELL_USER_ZDOTDIR = userZdotdir
  env.ZDOTDIR = zdotdirShimPath

  env.TERM = 'xterm-256color'
  env.TERM_PROGRAM = 'SeaShell'
  env.TERM_PROGRAM_VERSION = appVersion
  env.SEASHELL_PANE_ID = paneId

  // Matches Terminal.app, which sets only LANG and leaves LC_ALL untouched.
  env.LANG = env.LANG ?? 'en_US.UTF-8'
  delete env.LC_ALL

  if (truecolorOptOut) {
    env.COLORTERM = 'truecolor'
  }

  return env
}
