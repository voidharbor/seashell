/**
 * The xterm palette the next terminal should be built with.
 *
 * Module state rather than a prop, for the same reason `setHostname` in
 * PaneView is: a pane's terminal is constructed once, in an effect keyed on the
 * pane and its restart generation. Threading the palette in as a prop would put
 * it in that dependency list, so changing theme would dispose and rebuild every
 * terminal in the window and take all the scrollback with it.
 *
 * Instead a theme change pushes the new palette onto the terminals that already
 * exist (`setTheme`, which only swaps the colour table), and leaves this holder
 * for the ones built afterwards.
 */

import type { ITheme } from '@xterm/xterm'
import { TERMINAL_APP_PALETTE } from '../term/palette.js'

let current: ITheme = TERMINAL_APP_PALETTE

export function currentXtermTheme(): ITheme {
  return current
}

export function setCurrentXtermTheme(theme: ITheme): void {
  current = theme
}
