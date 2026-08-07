import { describe, expect, it } from 'vitest'
import { joinWrappedRows, type BufferRow } from '../../src/renderer/lookout/tail.js'
import { extractQuestion } from '../../src/renderer/lookout/extract.js'

/**
 * Rows exactly as xterm hands them over: full-width and untrimmed for anything
 * that wrapped, and flagged as a continuation.
 */
function wrapAt(text: string, cols: number): BufferRow[] {
  const rows: BufferRow[] = []
  for (let i = 0; i < text.length; i += cols) {
    rows.push({ text: text.slice(i, i + cols), wrapped: i > 0 })
  }
  return rows.length ? rows : [{ text: '', wrapped: false }]
}

describe('joinWrappedRows', () => {
  it('leaves unwrapped rows alone', () => {
    expect(
      joinWrappedRows([
        { text: 'first', wrapped: false },
        { text: 'second', wrapped: false },
      ])
    ).toEqual(['first', 'second'])
  })

  /**
   * The defect this exists for. xterm splits at the pane's right edge, which
   * lands mid-word as often as not — so reading rows as lines and joining them
   * with a space produced "push t his straight to main". The extracted
   * question then changed every time the pane was resized, and the card store
   * compares question strings to decide whether a card's ask is still on
   * screen.
   */
  it('rejoins a word split across the wrap without inserting anything', () => {
    const sentence = 'Do you want me to push this straight to main now?'
    for (const cols of [20, 31, 37, 44, 61]) {
      expect(joinWrappedRows(wrapAt(sentence, cols))).toEqual([sentence])
    }
  })

  /**
   * When a line wraps ON a space, that space is a real cell at the end of the
   * row. Trimming each row before joining would weld the words together.
   */
  it('keeps the space a line wrapped on', () => {
    expect(
      joinWrappedRows([
        { text: 'push this straight to main ', wrapped: false },
        { text: 'now, or read the diff first?', wrapped: true },
      ])
    ).toEqual(['push this straight to main now, or read the diff first?'])
  })

  it('trims the assembled line, not each row', () => {
    expect(
      joinWrappedRows([
        { text: 'a line padded to full width      ', wrapped: false },
      ])
    ).toEqual(['a line padded to full width'])
  })

  // The read window can open in the middle of a wrapped paragraph, leaving a
  // continuation row with nothing above it to attach to.
  it('keeps a leading continuation row as its own line', () => {
    expect(
      joinWrappedRows([
        { text: 'tail end of a paragraph', wrapped: true },
        { text: 'next line', wrapped: false },
      ])
    ).toEqual(['tail end of a paragraph', 'next line'])
  })
})

describe('the extracted question survives a re-wrap', () => {
  const RULE = '─'.repeat(40)
  /** A claude input-box screen with `message` above it. */
  const screen = (message: string[]): string[] => [
    '',
    ...message,
    '',
    RULE,
    '❯ ',
    RULE,
    '  ? for shortcuts',
    '',
  ]

  /**
   * The end-to-end version of the same defect: the identical unanswered ask,
   * read at two pane widths, has to extract to the identical question. If it
   * does not, resizing a pane makes the store believe the screen moved on to a
   * different ask — and it retires the card that was sitting there, draft and
   * all.
   */
  it('is the same at every pane width', () => {
    const paragraph =
      '⏺ I finished the migration and every test passes. Do you want me to push this straight to main now, or would you rather read the diff first and push it yourself?'

    const atWidth = (cols: number): string | undefined =>
      extractQuestion(screen(joinWrappedRows(wrapAt(paragraph, cols))))?.question

    const reference = atWidth(200)
    expect(reference).toBeTruthy()
    for (let cols = 55; cols <= 94; cols++) {
      expect(atWidth(cols), `width ${cols}`).toBe(reference)
    }
  })
})
