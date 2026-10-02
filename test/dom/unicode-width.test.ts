import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { installUnicode } from '../../src/renderer/term/unicode.js'

/**
 * Cell widths must agree with the program drawing into the pane.
 *
 * Claude Code's fullscreen renderer keeps its own model of the screen and
 * repaints only the cells that changed, placed by its own width count. An emoji
 * with a variation selector (🌤️ in the weather statusline, ⚠️ in a warning) is
 * two cells to it. Under the Unicode 11 table xterm made it one, so every later
 * cell on that row sat one column left of where Claude believed it was, and the
 * next partial repaint landed on the wrong characters. It stayed scrambled until
 * a resize forced a full redraw.
 *
 * Expected widths are the ones Claude Code (string-width) produces.
 */
function cursorAfter(text: string): Promise<number> {
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 4 })
  installUnicode(term)
  return new Promise((resolve) => {
    term.write(text, () => {
      const x = term.buffer.active.cursorX
      term.dispose()
      resolve(x)
    })
  })
}

describe('pane cell widths', () => {
  const cases: Array<[string, string, number]> = [
    ['ascii', 'a', 1],
    ['CJK', '中', 2],
    ['wide emoji', '⚡', 2],
    ['weather emoji + VS16', '🌤️', 2],
    ['warning sign + VS16', '⚠️', 2],
    ['sun + VS16', '☀️', 2],
    ['skin tone modifier', '👍🏽', 2],
    ['ZWJ family', '👨‍👩‍👧', 2],
    ['flag', '🇺🇸', 2],
    ['Claude spinner glyph', '✻', 1],
    ['Claude tool bullet', '⏺', 1],
    ['Claude result elbow', '⎿', 1],
    ['box drawing', '╭─╮', 3],
  ]

  for (const [name, text, width] of cases) {
    it(`${name} takes ${width} cell(s)`, async () => {
      expect(await cursorAfter(text)).toBe(width)
    })
  }

  it('text after a VS16 emoji lands where the program put it', async () => {
    expect(await cursorAfter('🌤️+68°F')).toBe(2 + 5)
  })
})
