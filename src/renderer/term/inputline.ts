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

/**
 * Bytes that clear the line a shell is editing.
 *
 * `\x05` is Ctrl+E (move to end of line), `\x15` is Ctrl+U (kill backwards to
 * the start). Ctrl+U alone only kills back from wherever the cursor happens to
 * be, so going to the end first is what makes this delete the whole line rather
 * than the half behind the cursor.
 */
export const KILL_LINE = '\x05\x15'

export interface KillLineInput {
  key: string
  /** True only while the selection came from ⌘A's input-line select. */
  inputLineSelected: boolean
  /** True when a full-screen program has claimed the mouse — see below. */
  mouseReporting: boolean
  /** Any of meta/ctrl/alt held: the user asked for something else. */
  modified: boolean
}

/**
 * Whether a Backspace should clear the whole input line instead of one
 * character.
 *
 * A terminal selection is only a highlight — the shell has no idea it exists,
 * so Backspace sends one erase byte and the highlight disappears because the
 * buffer changed. That reads as "it unselected and deleted one character". The
 * only way to honour the selection is to send what the shell's own line editor
 * understands.
 *
 * Refusing while mouse reporting is on is the important guard. That flag means
 * a full-screen program is in control, and Ctrl+U is not "kill line" there —
 * in vim it is half a page up. Sending it because a highlight happened to be
 * on screen would silently do something the user never asked for, so in that
 * case the key falls through untouched.
 */
export function shouldKillLine(input: KillLineInput): boolean {
  if (!input.inputLineSelected) return false
  if (input.modified) return false
  if (input.mouseReporting) return false
  return input.key === 'Backspace' || input.key === 'Delete'
}
