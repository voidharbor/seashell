/**
 * [pure] The scrollbar SeaShell draws for a program that owns its own history.
 *
 * Claude Code's fullscreen mode (and anything else on the alternate screen with
 * mouse reporting on) keeps its transcript itself. xterm has no scrollback for
 * it, so xterm's own scrollbar is an empty full-height track that scrolls
 * nothing. The only thing that moves such a program is what the wheel sends it:
 * one mouse-wheel report per notch.
 *
 * So this bar works in wheel notches. Every action it takes is some number of
 * notches up or down, and its thumb shows how many notches the pane has been
 * scrolled up since it was last at the bottom. The program never says where it
 * is, so that position is an estimate, and the model is built to fail soft: the
 * offset never goes below the bottom, the range only grows, and returning to
 * the bottom (a submit, leaving the alternate screen) resets it.
 */

export interface AppScrollState {
  /** Notches above the live bottom. */
  offset: number
  /** Notches the track stands for. Grows as the user scrolls further up. */
  range: number
}

/** Smallest range, so the first few notches visibly move the thumb. */
export const MIN_RANGE = 24
/** Headroom kept above the furthest point reached, so the thumb never pins. */
const HEADROOM = 4
/** Notches one screenful is treated as, which sets the thumb's size. */
const VIEW_NOTCHES = 6
/** Notches a click on the track sends, and each repeat while it is held. */
export const PAGE_NOTCHES = 5
export const MIN_THUMB_PX = 24

export function initialScroll(): AppScrollState {
  return { offset: 0, range: MIN_RANGE }
}

/** Positive is up (older), negative is down. */
export function applyNotches(s: AppScrollState, notches: number): AppScrollState {
  const offset = Math.max(0, s.offset + notches)
  return { offset, range: Math.max(s.range, offset + HEADROOM) }
}

export interface Thumb {
  top: number
  height: number
}

export function thumbGeometry(s: AppScrollState, trackPx: number): Thumb {
  if (trackPx <= 0) return { top: 0, height: 0 }
  const height = Math.min(
    trackPx,
    Math.max(MIN_THUMB_PX, Math.round((trackPx * VIEW_NOTCHES) / (s.range + VIEW_NOTCHES)))
  )
  const travel = trackPx - height
  const fromBottom = Math.min(1, s.offset / s.range)
  return { top: Math.round(travel * (1 - fromBottom)), height }
}

/**
 * Notches to send for a thumb drag: where the thumb now is, relative to where
 * the drag started, turned back into an offset. `dy` is pointer travel in px,
 * positive downward.
 */
export function dragNotches(start: AppScrollState, current: AppScrollState, dy: number, trackPx: number): number {
  const travel = trackPx - thumbGeometry(start, trackPx).height
  if (travel <= 0) return 0
  const target = Math.max(0, Math.round(start.offset - (dy / travel) * start.range))
  return target - current.offset
}

/** Where a press on the track landed, relative to the thumb. */
export function trackSide(s: AppScrollState, trackPx: number, y: number): 'above' | 'below' | 'thumb' {
  const t = thumbGeometry(s, trackPx)
  if (y < t.top) return 'above'
  if (y > t.top + t.height) return 'below'
  return 'thumb'
}
