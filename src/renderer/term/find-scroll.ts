/**
 * Where to scroll so a search match sits mid-viewport, or null when it is
 * already on screen. [pure]
 *
 * The search addon has its own copy of this and does not always run it. Its
 * internal re-search, fired 200ms after any write or resize, reselects the
 * active match with scrolling suppressed, so the match can end up off screen
 * with nothing to bring it back. Owning the scroll here makes the jump
 * deterministic regardless of what the addon did or skipped.
 */
export function targetScrollLine(row: number, viewportY: number, rows: number): number | null {
  if (row >= viewportY && row < viewportY + rows) return null
  return Math.max(0, row - Math.floor(rows / 2))
}
