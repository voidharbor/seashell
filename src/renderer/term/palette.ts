import type { ITheme } from '@xterm/xterm'

/**
 * Apple Terminal's "Homebrew" profile — green on black.
 *
 * This is the reference because it is what this machine actually uses:
 * `defaults read com.apple.Terminal "Default Window Settings"` returns
 * Homebrew for both the default and startup window. Matching Basic would have
 * meant SeaShell looked nothing like the terminal sitting next to it.
 *
 * Homebrew does not override the 16 ANSI colors, so those still inherit
 * Terminal.app's hardcoded defaults; only foreground, cursor and background
 * differ. Its real background is translucent black, flattened here to opaque
 * #000000: SeaShell does not do window transparency. (`allowTransparency` is
 * on, but that is a glyph-rasterization choice and not a see-through window —
 * see the note on it in terminal.ts. The black is painted by .pane__term and
 * .drawer__term instead of by the atlas.)
 *
 * Known accepted deviation: Homebrew carries a separate `TextBoldColor`
 * (#00FF00) and xterm's ITheme has no slot for it, so bold text renders in the
 * normal foreground green rather than the brighter one.
 *
 * Main sets `force-color-profile=srgb` before app ready, because Terminal's
 * NSColor archives are device RGB while Chromium would otherwise composite in
 * the display's P3 profile.
 */
export const TERMINAL_APP_PALETTE: ITheme = {
  background: '#000000',
  foreground: '#28FE14',
  cursor: '#38FE27',
  cursorAccent: '#000000',
  selectionBackground: '#255A1E',

  black: '#000000',
  red: '#C23621',
  green: '#25BC24',
  yellow: '#ADAD27',
  blue: '#492EE1',
  magenta: '#D338D3',
  cyan: '#33BBC8',
  white: '#CBCCCD',

  brightBlack: '#818383',
  brightRed: '#FC391F',
  brightGreen: '#31E722',
  brightYellow: '#EAEC23',
  brightBlue: '#5833FF',
  brightMagenta: '#F935F8',
  brightCyan: '#14F0F0',
  brightWhite: '#E9EBEB',
}

/** Terminal.app's own private face. See loadTerminalFont(). */
export const FONT_FAMILY = '"SF Mono Terminal", Menlo, "Apple Symbols", monospace'

/**
 * 13px is not a free choice. The WebGL renderer computes
 * `device.char.width = Math.floor(charWidth * dpr)`, so a large fractional
 * residual accumulates into visible cell drift. For SF Mono Terminal
 * (advance 0.61816 em) at DPR 2 the residual is: 11px→0.600, 12px→0.836,
 * 13px→0.072, 14px→0.308. 13px is the clean one.
 */
export const FONT_SIZE = 13

/** Menlo is only clean at 10px or 15px; 15px is the readable fallback. */
export const FALLBACK_FONT_SIZE = 15
