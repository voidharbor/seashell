import { describe, expect, it } from 'vitest'
import { screenKindOf } from '../../src/main/lookout/screen-kind.js'

/**
 * Raw pty streams, not xterm-rendered buffers: these fixtures carry the ANSI
 * chrome ink actually emits (cursor hide, erase-line, SGR runs) around the
 * plain-text shapes verified in lookout-extract.test.ts. The parser under
 * test reads main's per-pane output tail, which never passes through a
 * terminal emulator, so the fixtures must not either.
 */

const SELECTOR_PAINT =
  '\x1b[?25l\x1b[2K\x1b[G' +
  'Quick safety check: Is this a project you created or one you trust?\r\n' +
  '\x1b[2K\x1b[36m❯ 1. Yes, I trust this folder\x1b[39m\r\n' +
  '\x1b[2K  2. No, exit\r\n' +
  '\x1b[2K\r\n' +
  '\x1b[2K\x1b[2mEnter to confirm · Esc to cancel\x1b[22m'

const INPUT_BOX_PAINT =
  '\x1b[2K\x1b[G⏺ I compared both options.\r\n\r\n' +
  'Want me to lock in option 2 and keep going?\r\n\r\n' +
  '╭──────────────────────────────────────╮\r\n' +
  '│ > \x1b[7m \x1b[27m                                  │\r\n' +
  '╰──────────────────────────────────────╯\r\n' +
  '  \x1b[2m? for shortcuts\x1b[22m'

const BORDERLESS_INPUT_PAINT =
  '\x1b[2K\x1b[G⏺ Done with the refactor.\r\n\r\n' +
  'Should I run the tests now?\r\n\r\n' +
  '\x1b[2K❯ \r\n' +
  '\x1b[2m? for shortcuts\x1b[22m'

describe('screenKindOf', () => {
  it('reads a selector paint as selector', () => {
    expect(screenKindOf(SELECTOR_PAINT)).toBe('selector')
  })

  it('reads an idle input-box paint as input', () => {
    expect(screenKindOf(INPUT_BOX_PAINT)).toBe('input')
  })

  it('reads the borderless input paint as input', () => {
    expect(screenKindOf(BORDERLESS_INPUT_PAINT)).toBe('input')
  })

  it('the most recent paint wins: selector answered, box repainted', () => {
    expect(screenKindOf(SELECTOR_PAINT + '\r\n' + INPUT_BOX_PAINT)).toBe('input')
  })

  it('the most recent paint wins: box replaced by a selector', () => {
    expect(screenKindOf(INPUT_BOX_PAINT + '\r\n' + SELECTOR_PAINT)).toBe('selector')
  })

  it('plain shell output is neither', () => {
    expect(screenKindOf('josh@mac ~ % ls\r\nfile.txt  notes.md\r\n')).toBeNull()
  })

  it('an empty tail is neither', () => {
    expect(screenKindOf('')).toBeNull()
  })

  it('a transcript line merely quoting the footer is not a selector', () => {
    // No option rows anywhere near the quoted footer text — a real selector
    // always paints its numbered options directly above the confirm hint.
    const quoted =
      '⏺ The pane shows a hint that says Enter to confirm at the bottom.\r\n\r\n' + INPUT_BOX_PAINT
    expect(screenKindOf(quoted)).toBe('input')
  })
})
