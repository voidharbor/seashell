import fs from 'node:fs'
import path from 'node:path'
import { darwin } from './darwin.js'
import type { Platform, ShellSpec } from './types.js'

/**
 * Linux.
 *
 * Nearly everything darwin does is plain POSIX, and the two `ps` invocations
 * the sweeps use (`-axo pid,ppid,rss,pcpu,stat,comm` and
 * `-axo pid,ppid,pgid,tty`) parse identically under procps — so the kill
 * ladder, both sweeps and their guarantees are delegated to darwin rather than
 * duplicated. What genuinely differs is named below.
 *
 *  - **The shell.** `/bin/zsh -l` is a macOS fact; most Linux boxes have no
 *    zsh. The user's own `$SHELL` is the honest choice — it is the shell every
 *    other terminal would give them — with `/bin/bash` as the fallback because
 *    it exists everywhere that matters. Validated as an absolute existing path
 *    because env vars are inherited, not trusted.
 *
 *  - **cwd reporting is only real under zsh.** The integration is a ZDOTDIR
 *    shim; bash ignores ZDOTDIR entirely, so a bash user gets no OSC 7 and
 *    relative-path reveal resolves against the spawn directory. The capability
 *    flag is computed from the actual shell rather than asserted, so the
 *    degradation is visible instead of silently wrong.
 *
 *  - **No terminal font.** The face darwin loads belongs to Terminal.app.
 *    Returning null drops the renderer to its generic monospace fallback.
 */

function resolveShell(): ShellSpec {
  const fromEnv = process.env['SHELL']
  if (fromEnv && path.isAbsolute(fromEnv)) {
    try {
      fs.accessSync(fromEnv, fs.constants.X_OK)
      return { file: fromEnv, args: ['-l'] }
    } catch {
      /* fall through to bash */
    }
  }
  return { file: '/bin/bash', args: ['-l'] }
}

const shell = resolveShell()
const shellIsZsh = path.basename(shell.file) === 'zsh'

export const linux: Platform = {
  ...darwin,
  id: 'linux',

  capabilities: {
    ...darwin.capabilities,
    cwdReporting: shellIsZsh,
  },

  loginShell(): ShellSpec {
    return shell
  },

  /**
   * The shim is written regardless of shell: it costs one small directory, a
   * zsh user gets working cwd reporting from it, and bash ignores ZDOTDIR so
   * it is inert rather than harmful there.
   */

  terminalFontPath(): string | null {
    return null
  },
}
