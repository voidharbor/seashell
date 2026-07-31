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
 * Works out which directory holds the user's *real* zsh dotfiles.
 *
 * The subtle case is SeaShell launched from inside a SeaShell pane — running
 * `npm run dev`, or opening the app from a terminal it is already hosting. The
 * new main process then inherits `ZDOTDIR` pointing at SeaShell's own shim, and
 * taking that at face value makes the shim source itself: `.zshrc` sources
 * `$SEASHELL_USER_ZDOTDIR/.zshrc`, which is the same file, forever. zsh reports
 * the result as "job table full or recursion limit exceeded" — an error that
 * names neither the shim nor the nesting, on a shell that still reaches a
 * prompt with none of the user's configuration loaded.
 *
 * `SEASHELL_USER_ZDOTDIR` is the reliable escape: if it is present we are
 * nested, and it already holds the answer the outer instance worked out.
 * Otherwise an inherited `ZDOTDIR` is trusted only when it is not our own shim,
 * and `$HOME` — zsh's own default search location — is the fallback.
 */
export function resolveUserZdotdir(
  env: NodeJS.ProcessEnv,
  zdotdirShimPath: string
): string {
  const home = env.HOME ?? ''

  // Nested launch: the outer instance already recorded the real location.
  const recorded = env.SEASHELL_USER_ZDOTDIR
  if (recorded && !isShimPath(recorded, zdotdirShimPath)) return recorded

  const inherited = env.ZDOTDIR
  if (inherited && !isShimPath(inherited, zdotdirShimPath)) return inherited

  return home
}

/** Compares without trailing separators so `/x/shim` and `/x/shim/` match. */
function isShimPath(candidate: string, shim: string): boolean {
  if (shim === '') return false
  const strip = (s: string): string => s.replace(/\/+$/, '')
  return strip(candidate) === strip(shim)
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
  env.SEASHELL_USER_ZDOTDIR = resolveUserZdotdir(env, zdotdirShimPath)
  env.ZDOTDIR = zdotdirShimPath

  // This pane's id must never leak from the inherited environment — a nested
  // launch would otherwise hand the new pane the id of the pane it started in.
  // It is set explicitly further down.
  delete env.SEASHELL_PANE_ID

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
