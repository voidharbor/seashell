/**
 * Where a renderer path crosses into fs or shell calls, and where an fs answer
 * crosses back.
 *
 * On win32 the renderer speaks Linux paths from inside WSL; Windows can only
 * open them as `C:\...` or `\\wsl.localhost\<distro>\...`. Everywhere else both
 * functions are the identity, so the Linux and macOS builds are untouched.
 *
 * The distro comes from one place: the win32 platform's startup probe
 * (`win32.info().distro`, the distro its panes run in). Only when that probe
 * found none does `SEASHELL_WSL_DISTRO` / the build default apply.
 */

import os from 'node:os'
import { linuxToWindows, windowsToLinux, wslDistro } from '../../shared/wsl-path.js'
import { platform as current } from '../platform/index.js'

function probedDistro(): string {
  const info = (current as { info?: () => { distro: string | null } }).info
  return info?.().distro ?? wslDistro()
}

/** Renderer path -> the path to hand fs / shell. */
export function toHostPath(
  p: string,
  platform: NodeJS.Platform = process.platform,
  distro?: string
): string {
  return platform === 'win32' ? linuxToWindows(p, distro ?? probedDistro()) : p
}

/** fs / shell path -> the path the renderer sees (and the guard reasons on). */
export function fromHostPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? windowsToLinux(p) : p
}

/**
 * The home directory as the renderer speaks it: on win32 the WSL user's Linux
 * home (the platform probe), so the explorer, the edit scope and `~` all land
 * where the panes do. Everywhere else, and if the probe found no home,
 * `os.homedir()`.
 */
export function rendererHome(): string {
  return current.homeDir?.() ?? os.homedir()
}
