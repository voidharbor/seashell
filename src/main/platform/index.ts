import { darwin } from './darwin.js'
import { linux } from './linux.js'
import { win32 } from './win32.js'
import type { Platform } from './types.js'

export type { Platform, PlatformCapabilities, ShellSpec, KillRequest, KillResult } from './types.js'

/**
 * Chosen once, at import.
 *
 * darwin stays the default for the long tail of BSDs: POSIX signals, process
 * groups, `ps` and a controlling tty all exist there, so it degrades to
 * "mostly works" instead of "refuses to start". Linux gets its own entry
 * because the one thing darwin hardcodes — `/bin/zsh -l` — is reliably absent
 * on Linux, which would have made every pane dead on arrival.
 */
function select(): Platform {
  switch (process.platform) {
    case 'win32':
      return win32
    case 'linux':
      return linux
    default:
      return darwin
  }
}

export const platform: Platform = select()
