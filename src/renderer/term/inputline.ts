/**
 * Works out what ⌘A should select.
 *
 * Selecting the entire scrollback — xterm's `selectAll`, and Terminal.app's
 * behaviour — is close to useless in a pane running an agent: you get thousands
 * of lines of transcript when what you wanted was the prompt you are halfway
 * through typing. This narrows it to the line you are actually editing.
 *
 * The wrapping is the fiddly part. A long prompt occupies several buffer rows,
 * and each continuation row is flagged `isWrapped`; walking back to the first
 * unwrapped row gives the start of the logical line. The selection then runs
 * from there to the cursor, which is where the text the user has typed ends.
 *
 * Known limit: without shell-integration prompt marks (OSC 133) there is no way
 * to know where the prompt ends and the input begins, so the selection starts at
 * the beginning of the line and therefore includes the prompt itself. That is
 * still far closer to "the thing I am typing" than the whole buffer, and it
 * degrades honestly rather than guessing at prompt widths.
 */

export interface InputLineInput {
  /** Absolute buffer row of the cursor (`baseY + cursorY`). */
  cursorRow: number
  /** Cursor column within its row. */
  cursorCol: number
  /** Terminal width in cells. */
  cols: number
  /** Whether the buffer row at this absolute index is a wrapped continuation. */
  isWrapped: (row: number) => boolean
}

export interface InputLineSelection {
  /** Absolute buffer row to start the selection on. */
  row: number
  /** Column to start at — always the line start. */
  col: number
  /** Number of cells to select, spanning wrapped rows. */
  length: number
}

/**
 * Returns null when there is nothing to select — an empty prompt at column 0.
 * The caller falls back to selecting the whole buffer, so ⌘A never does nothing.
 */
export function inputLineSelection(input: InputLineInput): InputLineSelection | null {
  const { cursorRow, cursorCol, cols } = input
  if (!Number.isFinite(cursorRow) || !Number.isFinite(cursorCol) || cols <= 0) return null

  // Walk back over continuation rows to the first row of the logical line.
  let start = cursorRow
  // Guard the walk: a corrupt buffer must not spin here.
  let guard = 0
  while (start > 0 && input.isWrapped(start) && guard < 10_000) {
    start -= 1
    guard += 1
  }

  const rowsSpanned = cursorRow - start
  const length = rowsSpanned * cols + cursorCol
  if (length <= 0) return null

  return { row: start, col: 0, length }
}
