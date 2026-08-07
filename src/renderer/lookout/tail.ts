import { terminals } from '../panes/PaneView.js'
import { TAIL_LINES } from './extract.js'

/** One row of the xterm buffer: its text, and whether it is the continuation
 *  of the row above rather than a line of its own. */
export interface BufferRow {
  /** UNTRIMMED cell contents — see joinWrappedRows for why the trim has to
   *  wait until the whole logical line is assembled. */
  text: string
  wrapped: boolean
}

/**
 * Rejoins rows that xterm split to fit the pane's width.
 *
 * The buffer stores what is on the SCREEN, so a paragraph the program emitted
 * as one long line is however many rows wide the pane happens to be, split
 * wherever the right-hand edge fell — mid-word as often as not. Reading those
 * rows as separate lines made the extracted question a function of pane width:
 * the same unanswered ask came out as "...push this straight to main..." at one
 * width and "...push t his straight to main..." at another.
 *
 * That is not a cosmetic difference. The card store compares question strings
 * to decide whether the screen still shows the ask a card was raised for, so a
 * re-wrap read as a NEW question — and re-wraps are ordinary: dragging the
 * sidebar, toggling it, resizing the window, ⌘+, or splitting another pane in
 * the tab all refit an unfocused pane that is sitting there waiting.
 *
 * The rows are joined with NO separator, because a wrapped row is the literal
 * continuation of the one above — there is no character between them. That is
 * also why `text` must arrive untrimmed: when a line wraps at a space, that
 * space occupies a real cell at the end of the row, and trimming each row
 * before joining would weld the two words together ("mainnow"). Trailing
 * whitespace is cut once, from the assembled line.
 */
export function joinWrappedRows(rows: BufferRow[]): string[] {
  const lines: string[] = []
  for (const row of rows) {
    // A wrapped first row means the window opened mid-paragraph; there is
    // nothing above to attach it to, so it stands as its own line.
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text
    else lines.push(row.text)
  }
  return lines.map((line) => line.replace(/\s+$/, ''))
}

/**
 * Reads the last `TAIL_LINES` rows of a pane's live xterm buffer, ANSI-free
 * (same as `Terminal#buffer.active` gives everywhere else in this codebase)
 * and with wrapped rows rejoined into the lines the program actually wrote.
 * Shared by the Task 6 detection effect and Task 7's `screenMode` callback in
 * app.tsx — both need the identical read before handing lines to
 * `extractQuestion`; only what each caller does with the result differs.
 *
 * Returns null when the pane has no mounted terminal — a preview pane, or a
 * paneId that no longer exists. Callers treat that the same as "no signal".
 */
export function readPaneTail(paneId: string): string[] | null {
  const term = terminals.get(paneId)?.term
  if (!term) return null
  const buf = term.buffer.active
  const rows: BufferRow[] = []
  for (let i = Math.max(0, buf.length - TAIL_LINES); i < buf.length; i++) {
    const line = buf.getLine(i)
    rows.push({
      // translateToString(false): untrimmed, so the space a line wrapped on is
      // still there to be joined. joinWrappedRows trims the finished line.
      text: line?.translateToString(false) ?? '',
      wrapped: line?.isWrapped ?? false,
    })
  }
  return joinWrappedRows(rows)
}
