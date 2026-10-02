/**
 * [pure] The Windows build's pane spawn, worked out without touching Windows.
 *
 * On win32 every pane runs inside WSL: node-pty spawns `wsl.exe`, and wsl.exe
 * starts the user's Linux login shell. Two things make that harder than it
 * looks, and both are handled here so they can be tested on Linux:
 *
 *  - Windows environment variables do not reach the Linux side unless they are
 *    named in WSLENV, and WSLENV translates path-shaped values in ways that are
 *    easy to get wrong. So the pane's variables travel on the command line
 *    instead, through `env K=V ... <shell> -l` run by `wsl.exe -e`. `-e` runs
 *    the program directly with no shell in between, so nothing is re-parsed.
 *
 *  - node-pty turns the argv into one Windows command line, quoting an
 *    argument only when it contains a space or a quote. Every env value is
 *    therefore checked against a strict character set (no spaces, quotes,
 *    backslashes, NUL or control characters) and refused otherwise, so no
 *    value ever needs quoting and none can split or merge arguments.
 *
 * Nothing in this module runs a process or reads a file. Path translation
 * itself lives in wsl-path.ts; the two helpers below only adapt it.
 */

import { isLinuxPath, linuxToUnc, uncToLinux, windowsToMnt } from './wsl-path.js'

/** The shim and the pid files live under here, inside the WSL home. */
export const WSL_STATE_DIR = '.cache/seashell-win'

export interface WslSpawnInput {
  /** The distro to run in, or null to let wsl.exe use its default. */
  distro: string | null
  /** The Linux working directory, absolute, or `~`. */
  cwd: string
  /** The Linux login shell, absolute, e.g. `/usr/bin/zsh`. */
  shell: string
  /** Variables set for the shell, in order. Validated, never quoted. */
  vars: ReadonlyArray<readonly [string, string]>
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Characters that survive a Windows command line and `env` untouched. */
const VALUE_RE = /^[A-Za-z0-9_.\/:@%+,~-]*$/

/** True when `value` can cross as a bare argument. [pure] */
export function isSafeEnvValue(value: string): boolean {
  return VALUE_RE.test(value)
}

/**
 * `K=V` arguments for `env`. Throws on any key or value that would need
 * quoting, rather than quoting it: a refused pane is visible, a mis-split
 * argument is not. [pure]
 */
export function envArgs(vars: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = []
  for (const [key, value] of vars) {
    if (!KEY_RE.test(key)) throw new Error(`unsafe env name for WSL: ${JSON.stringify(key)}`)
    if (!isSafeEnvValue(value)) throw new Error(`unsafe env value for WSL ${key}: ${JSON.stringify(value)}`)
    out.push(`${key}=${value}`)
  }
  return out
}

/**
 * A Linux cwd as `--cd` will take it. Spaces are allowed (real project folders
 * have them, and node-pty quotes such an argument correctly), and so is a
 * single quote, which means nothing on a Windows command line (`Ann's Notes`
 * is a real folder). Double quotes, backslashes, NUL and control characters
 * are not, because those are what a Windows command line would reinterpret.
 * [pure]
 */
export function isSafeLinuxCwd(cwd: string): boolean {
  if (cwd === '~') return true
  if (!cwd.startsWith('/')) return false
  // eslint-disable-next-line no-control-regex
  return !/["\\\x00-\x1f\x7f]/.test(cwd)
}

/**
 * The argv after `wsl.exe`. `COLORTERM` is unset explicitly, matching the
 * macOS pane (see buildEnv in pty/env.ts for why truecolor must stay off).
 * [pure]
 */
export function wslSpawnArgs(input: WslSpawnInput): string[] {
  const { distro, cwd, shell, vars } = input
  if (!isSafeLinuxCwd(cwd)) throw new Error(`unsafe Linux cwd: ${JSON.stringify(cwd)}`)
  if (!shell.startsWith('/') || !isSafeEnvValue(shell)) throw new Error(`unsafe Linux shell: ${JSON.stringify(shell)}`)
  const args: string[] = []
  if (distro !== null) {
    if (!isSafeEnvValue(distro) || distro === '') throw new Error(`unsafe distro name: ${JSON.stringify(distro)}`)
    args.push('-d', distro)
  }
  args.push('--cd', cwd, '-e', 'env', '-u', 'COLORTERM', ...envArgs(vars), shell, '-l')
  return args
}

export interface PaneVarsInput {
  paneId: string
  appVersion: string
  /** Linux path of the ZDOTDIR shim, or null when it could not be written. */
  shimDir: string | null
  /** The WSL user's home, which is where their own zsh dotfiles are. */
  userZdotdir: string | null
  /** Linux path the shim records the shell pid into, or null. */
  pidFile: string | null
  /** This app run's identity (`appInstanceId`), or null to leave it out. */
  appId?: string | null
}

/**
 * Which SeaShell run a pane belongs to, as `<platform>-<pid>`, e.g.
 * `win32-4512`. Exported into every Windows pane as SEASHELL_APP_ID so the
 * c-assistant hook can record it: pane ids are only unique within one run, and
 * the Windows exe and a Linux SeaShell share one ~/.claude/session-registry.
 * send-to-pane.py routes on the platform half, and the session lookup only
 * credits a registry entry to a pane of the run that wrote it. [pure]
 */
export function appInstanceId(platform: string, pid: number): string {
  return `${platform}-${pid}`
}

/**
 * The variables a WSL pane gets, the Linux-side twin of buildEnv. The shim
 * variables are only set together: ZDOTDIR without a place to find the real
 * dotfiles would load none of them. [pure]
 */
export function paneVars(input: PaneVarsInput): Array<[string, string]> {
  const vars: Array<[string, string]> = []
  if (input.shimDir !== null && input.userZdotdir !== null) {
    vars.push(['ZDOTDIR', input.shimDir], ['SEASHELL_USER_ZDOTDIR', input.userZdotdir])
    if (input.pidFile !== null) vars.push(['SEASHELL_PIDFILE', input.pidFile])
  }
  vars.push(
    ['TERM', 'xterm-256color'],
    ['TERM_PROGRAM', 'SeaShell'],
    ['TERM_PROGRAM_VERSION', input.appVersion],
    ['SEASHELL_PANE_ID', input.paneId]
  )
  if (input.appId) vars.push(['SEASHELL_APP_ID', input.appId])
  return vars
}

/** A pane id as a file name: anything outside [A-Za-z0-9_-] becomes `_`. [pure] */
export function paneFileKey(paneId: string): string {
  return paneId.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** `<home>/.cache/seashell-win/pids/<app pid>`, one directory per app run. [pure] */
export function pidDirFor(home: string, appPid: number): string {
  return `${home.replace(/\/+$/, '')}/${WSL_STATE_DIR}/pids/${appPid}`
}

/** `<home>/.cache/seashell-win/zdotdir`. [pure] */
export function shimDirFor(home: string): string {
  return `${home.replace(/\/+$/, '')}/${WSL_STATE_DIR}/zdotdir`
}

/** The pid file one pane's shell writes. [pure] */
export function pidFileFor(home: string, appPid: number, paneId: string): string {
  return `${pidDirFor(home, appPid)}/pane-${paneFileKey(paneId)}.pid`
}

/**
 * What the shim writes: `<shell pid> <tty>`, e.g. `4512 pts/3`. The tty is in
 * `ps -o tty` form so the control socket can hand it to `ps -t`. [pure]
 */
export function parsePidFile(text: string): { pid: number; tty: string | null } | null {
  const m = /^\s*(\d+)(?:\s+(\S+))?\s*$/.exec(text)
  if (!m) return null
  const pid = Number(m[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const raw = m[2]?.replace(/^\/dev\//, '')
  const tty = raw && /^pts\/\d+$/.test(raw) ? raw : null
  return { pid, tty }
}

/**
 * `wsl.exe -l -q` output: UTF-16LE with CRLF unless WSL_UTF8 is set. The
 * default distro is listed first; a `*` or `(Default)` marker is tolerated in
 * case the verbose form is ever fed in. [pure]
 */
export function parseDistroList(raw: Uint8Array | string): string[] {
  let text: string
  if (typeof raw === 'string') {
    text = raw
  } else {
    const buf = Buffer.from(raw)
    const nuls = buf.filter((b) => b === 0).length
    text = nuls > 0 && nuls * 3 >= buf.length ? buf.toString('utf16le') : buf.toString('utf8')
  }
  const out: string[] = []
  for (const line of text.replace(/\0/g, '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const name = line.replace(/\r/g, '').replace(/^\s*\*\s*/, '').replace(/\s*\(Default\)\s*$/i, '').trim()
    if (name !== '') out.push(name)
  }
  return out
}

/** The `echo $HOME; <login shell>` probe: line one the home, line two the shell. [pure] */
export function parseHomeShellProbe(stdout: string): { home: string | null; shell: string | null } {
  const [home, shell] = stdout.replace(/\r/g, '').split('\n').map((s) => s.trim())
  return {
    home: home && home.startsWith('/') && isSafeEnvValue(home) ? home : null,
    shell: shell && shell.startsWith('/') && isSafeEnvValue(shell) ? shell : null,
  }
}

/**
 * A path as the WSL side sees it. `C:\x` becomes `/mnt/c/x`, a
 * `\\wsl.localhost\<distro>\x` (or `\\wsl$\...`) path becomes `/x`, and a
 * Linux path is returned as is. Anything else is null. [pure]
 */
export function toLinuxPath(p: string): string | null {
  if (p === '~' || isLinuxPath(p)) return p
  return windowsToMnt(p) ?? uncToLinux(p)?.path ?? null
}

/** `\\wsl.localhost\<distro>\home\u\x` for a Linux path. [pure] */
export function wslUncPath(distro: string, linuxPath: string): string {
  return linuxToUnc(distro, linuxPath)
}

/**
 * The ZDOTDIR shim, as file name -> contents. The same shim the Mac and Linux
 * builds write (pty/zdotdir.ts), with two additions for WSL:
 *
 *  - `.zshenv` records the shell's pid and tty into `$SEASHELL_PIDFILE`, first
 *    thing, before any user config can fail. Main reads it back through the
 *    UNC path: on Windows the pty's own child is wsl.exe, so that file is the
 *    only way to learn which Linux process is the pane's shell. The variable is
 *    unset straight after so nothing the shell starts inherits it.
 *  - `$SEASHELL_USER_ZDOTDIR` falls back to `$HOME`. [pure]
 */
export function wslShimFiles(): Record<string, string> {
  const user = '${SEASHELL_USER_ZDOTDIR:-$HOME}'
  const files: Record<string, string> = {}
  for (const name of ['.zshenv', '.zprofile', '.zlogin']) {
    const lines = [`# SeaShell shim (WSL): sources your real ${name} and nothing else.`]
    if (name === '.zshenv') {
      lines.push(
        'if [[ -n "$SEASHELL_PIDFILE" ]]; then',
        '  print -r -- "$$ ${TTY#/dev/}" >| "$SEASHELL_PIDFILE" 2>/dev/null',
        '  unset SEASHELL_PIDFILE',
        'fi'
      )
    }
    lines.push(`[ -r "${user}/${name}" ] && . "${user}/${name}"`, '')
    files[name] = lines.join('\n')
  }
  files['.zshrc'] = [
    '# SeaShell shim (WSL): your .zshrc runs first, then SeaShell adds a cwd hook.',
    `[ -r "${user}/.zshrc" ] && . "${user}/.zshrc"`,
    '',
    'autoload -Uz add-zsh-hook 2>/dev/null && {',
    '  _seashell_osc7() {',
    `    printf '\\e]7;file://%s%s\\a' "\${HOST}" "\${(j::)\${(@)\${(s::)PWD}/(#b)([^A-Za-z0-9_.!~*\\'\\-\\/])/%$(([##16]#match[1]))}}"`,
    '  }',
    '  add-zsh-hook precmd _seashell_osc7',
    '}',
    '',
  ].join('\n')
  return files
}
