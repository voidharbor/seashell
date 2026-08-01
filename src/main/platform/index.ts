import { darwin } from './darwin.js'
import { win32 } from './win32.js'
import type { Platform } from './types.js'

export type { Platform, PlatformCapabilities, ShellSpec, KillRequest, KillResult } from './types.js'

/**
 * Chosen once, at import.
 *
 * macOS is the fallback rather than a thrown error on purpose: Linux is close
 * enough to macOS on every axis this seam covers — `/bin/zsh` may not exist,
 * but POSIX signals, process groups, `ps` and a controlling tty all do — so it
 * degrades to "mostly works" instead of "refuses to start". That is a guess,
 * and an untested one; it is written down here rather than left implied.
 */
function select(): Platform {
  switch (process.platform) {
    case 'win32':
      return win32
    default:
      return darwin
  }
}

export const platform: Platform = select()
