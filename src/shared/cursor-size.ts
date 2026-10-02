/**
 * [pure] The mouse pointer size to pin under WSLg, or null to leave it alone.
 *
 * Chromium on X11 picks its pointer size the way libXcursor does: the
 * XCURSOR_SIZE env, then the Xcursor.size resource, then Xft.dpi, and last
 * the screen's shorter side divided by 48. WSLg sets none of the first three,
 * and its X screen spans every monitor, so a 3440x1440 display with a 1080p
 * one stacked above it is a 3440x2520 screen: 2520 / 48 = 52, and the theme's
 * nearest size is 48px, twice the normal pointer.
 *
 * A real Linux desktop answers through its own settings, so only WSL is
 * pinned, and an XCURSOR_SIZE the user already set always wins.
 */

export const WSL_CURSOR_SIZE = '24'

export function wslCursorSize(
  platform: string,
  osRelease: string,
  env: Record<string, string | undefined>,
): string | null {
  if (platform !== 'linux') return null
  if (env.XCURSOR_SIZE) return null
  if (!/microsoft|wsl/i.test(osRelease)) return null
  return WSL_CURSOR_SIZE
}
