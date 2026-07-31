import { describe, expect, it } from 'vitest'
import { inputLineSelection } from '../../src/renderer/term/inputline.js'

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
