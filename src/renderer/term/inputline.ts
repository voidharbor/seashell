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
 * Bytes that clear what ⌘A selected.
 *
 * `\x15` is Ctrl+U — kill backwards from the cursor to the start of the line.
 * That is exactly the extent `inputLineSelection` highlights, since the
 * selection runs from the line start *to the cursor*. Deleting precisely what
 * is highlighted is also the least surprising behaviour.
 *
 * A leading `\x05` (Ctrl+E, end of line) was tried, to catch text sitting after
 * the cursor. It is not worth it: Ctrl+E is not universally "end of line" — some
 * programs bind it to open $EDITOR — and text beyond the cursor was never part
 * of the selection anyway, so removing it would delete something the user could
 * not see was selected.
 */
export const KILL_LINE = '\x15'

export interface KillLineInput {
  key: string
  /** True only while the selection came from ⌘A's input-line select. */
  inputLineSelected: boolean
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
 * `inputLineSelected` is the whole guard, and it is a strong one: it is true
 * only between a ⌘A input-line select and the very next keystroke. The user
 * pressed select-all and then immediately pressed delete. There is no reading
 * of that other than "replace this line".
 *
 * Two cleverer guards were tried and both failed the same way — by trying to
 * infer the user's context and getting it wrong in the pane that matters:
 *
 *   - mouse reporting: agents enable mouse tracking, so this switched the
 *     feature off in exactly the panes it was written for.
 *   - the alternate screen buffer: same outcome for any agent that draws on it.
 *
 * Both were guessing at whether Ctrl+U means "kill line" here. The honest
 * answer is that it does in every line editor the user will press ⌘A in — a
 * shell, an agent prompt, a REPL. The one place it means something else is a
 * full-screen editor, where nobody reaches for select-all-then-delete to clear
 * an input line, because there is no input line. That residual risk is smaller
 * than the certainty of the feature not working at all.
 */
export function shouldKillLine(input: KillLineInput): boolean {
  if (!input.inputLineSelected) return false
  if (input.modified) return false
  return input.key === 'Backspace' || input.key === 'Delete'
}
