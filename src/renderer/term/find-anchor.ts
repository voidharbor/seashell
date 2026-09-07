/**
 * Whether the user's search match needs putting back, and whether doing so
 * should move the viewport. [pure]
 *
 * The search addon registers `onWriteParsed` and `onResize` handlers that, 200ms
 * after any pty write, drop its cached term and re-run the search with scrolling
 * suppressed. In a pane that keeps printing, that re-run can land on a different
 * match, and with no selection to work from it walks to the far end of the
 * buffer. The user's match is gone and nothing scrolls it back.
 *
 * PaneTerminal pins the match the user landed on to an xterm marker and calls
 * this whenever the addon reports new results. Keeping the decision here means
 * it can be exercised without an xterm, a canvas or a pty.
 */
export interface AnchorInput {
  /**
   * The row and column of the match the user last landed on, or null when there
   * is none. `disposed` is the marker's own flag: it flips once the row falls
   * out of scrollback, and the anchor is then meaningless.
   */
  anchor: { line: number; col: number; disposed: boolean } | null
  /** Where the terminal's selection starts now, or null when there is none. */
  selection: { line: number; col: number } | null
  /** The buffer row at the top of the viewport now. */
  viewportY: number
  /** The buffer row at the top of the viewport when the last find ran. */
  findViewportY: number
  /** Viewport height in rows. */
  rows: number
}

export interface AnchorAction {
  /** Re-select the anchored match. */
  restore: boolean
  /** Scroll it back into view as well. */
  scroll: boolean
}

const NOTHING: AnchorAction = { restore: false, scroll: false }

export function anchorAction(input: AnchorInput): AnchorAction {
  const { anchor, selection } = input
  if (!anchor || anchor.disposed) return NOTHING
  // The addon left the match where the user put it. Nothing to undo.
  if (selection && selection.line === anchor.line && selection.col === anchor.col) return NOTHING

  const onScreen = anchor.line >= input.viewportY && anchor.line < input.viewportY + input.rows
  // A user who scrolled away since the find asked to be somewhere else. Put the
  // selection back so the next Enter steps from the right place, but leave the
  // viewport alone.
  const userScrolled = input.viewportY !== input.findViewportY
  return { restore: true, scroll: !onScreen && !userScrolled }
}
