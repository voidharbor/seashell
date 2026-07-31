import { describe, expect, it } from 'vitest'
import { KILL_LINE, inputLineSelection, shouldKillLine } from '../../src/renderer/term/inputline.js'

/** Rows listed here are wrapped continuations of the row above. */
const wrapped = (...rows: number[]) => (row: number): boolean => rows.includes(row)
const none = (): boolean => false

describe('inputLineSelection', () => {
  it('selects from the line start to the cursor on a single row', () => {
    expect(
      inputLineSelection({ cursorRow: 40, cursorCol: 12, cols: 80, isWrapped: none })
    ).toEqual({ row: 40, col: 0, length: 12 })
  })

  /**
   * The case that matters: a long agent prompt occupies several buffer rows, and
   * selecting only the cursor's row would grab the tail of what was typed.
   */
  it('walks back over wrapped rows to the real start of the line', () => {
    expect(
      inputLineSelection({ cursorRow: 42, cursorCol: 10, cols: 80, isWrapped: wrapped(41, 42) })
    ).toEqual({ row: 40, col: 0, length: 2 * 80 + 10 })
  })

  it('stops at the first unwrapped row, not at the top of the buffer', () => {
    const sel = inputLineSelection({
      cursorRow: 30,
      cursorCol: 5,
      cols: 100,
      isWrapped: wrapped(30),
    })
    expect(sel).toEqual({ row: 29, col: 0, length: 105 })
  })

  it('returns null for an empty prompt so the caller can fall back', () => {
    expect(inputLineSelection({ cursorRow: 10, cursorCol: 0, cols: 80, isWrapped: none })).toBeNull()
  })

  it('refuses nonsense geometry rather than producing a bad selection', () => {
    expect(
      inputLineSelection({ cursorRow: Number.NaN, cursorCol: 4, cols: 80, isWrapped: none })
    ).toBeNull()
    expect(inputLineSelection({ cursorRow: 5, cursorCol: 4, cols: 0, isWrapped: none })).toBeNull()
  })

  it('terminates on a buffer that claims every row is wrapped', () => {
    // A corrupt or hostile buffer must not spin the renderer.
    const sel = inputLineSelection({
      cursorRow: 500,
      cursorCol: 3,
      cols: 80,
      isWrapped: () => true,
    })
    expect(sel).not.toBeNull()
    expect(sel!.row).toBe(0)
  })
})

/**
 * Why this exists: a terminal selection is only a highlight. The shell never
 * learns about it, so Backspace sends one erase byte and the highlight vanishes
 * because the buffer changed — which reads as "it unselected and deleted a
 * single character". Honouring the selection means sending what the shell's own
 * line editor understands instead.
 */
describe('shouldKillLine', () => {
  const base = {
    key: 'Backspace',
    inputLineSelected: true,
    mouseReporting: false,
    modified: false,
  }

  it('kills the line for Backspace and Delete after a Cmd+A input select', () => {
    expect(shouldKillLine(base)).toBe(true)
    expect(shouldKillLine({ ...base, key: 'Delete' })).toBe(true)
  })

  it('does nothing special without an input-line selection', () => {
    expect(shouldKillLine({ ...base, inputLineSelected: false })).toBe(false)
  })

  it('leaves ordinary typing alone', () => {
    for (const key of ['a', 'Enter', 'ArrowLeft', 'Tab', 'Escape']) {
      expect(shouldKillLine({ ...base, key }), key).toBe(false)
    }
  })

  /**
   * The guard that matters most. Mouse reporting means a full-screen program is
   * driving, and Ctrl+U is not "kill line" there — in vim it scrolls half a
   * page. Acting on a stale highlight would do something never asked for.
   */
  it('refuses inside a program that has claimed the mouse', () => {
    expect(shouldKillLine({ ...base, mouseReporting: true })).toBe(false)
  })

  it('refuses when a modifier is held, since that is a different request', () => {
    expect(shouldKillLine({ ...base, modified: true })).toBe(false)
  })
})

describe('KILL_LINE', () => {
  it('goes to end of line before killing backwards', () => {
    // Ctrl+U alone would only kill behind the cursor, leaving the tail.
    expect(KILL_LINE).toBe('\x05\x15')
  })
})
