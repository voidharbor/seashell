import type { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

/**
 * Cell widths by grapheme cluster, the way the programs in a pane count them.
 *
 * The Unicode 11 table this replaced measured code points one at a time, so an
 * emoji followed by a variation selector (🌤️, ⚠️, ☀️) was one cell, a skin-tone
 * emoji four and a ZWJ family six. Claude Code counts each as two. Its
 * fullscreen renderer repaints only changed cells at positions from its own
 * count, so one such glyph on a row shifted everything after it by a column and
 * the next partial repaint wrote over the wrong characters: the "scrambled until
 * I resize the pane" bug, since only a resize makes it redraw the whole screen.
 * The weather emoji in the statusline was enough to set it off, which is why it
 * came and went. unicode-width.test.ts pins the widths.
 */
export const UNICODE_VERSION = '15-graphemes'

export function installUnicode(term: Terminal): void {
  term.loadAddon(new UnicodeGraphemesAddon())
  term.unicode.activeVersion = UNICODE_VERSION
}
