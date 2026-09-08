/**
 * How often a download is allowed to speak. [pure]
 *
 * The read loop gets a chunk every few milliseconds, and every state it sends
 * crosses IPC and re-renders the whole renderer tree. The banner shows whole
 * percent, so anything finer than that is a redraw nobody can see. When the
 * release did not advertise a size there is no percent to move, and a plain
 * time gap stands in for one.
 */

export interface ProgressPoint {
  received: number
  total: number
  /** Any monotonic clock in milliseconds. */
  at: number
}

/** Longest a size-less download stays silent. */
export const UNKNOWN_TOTAL_MS = 100

function percent(p: ProgressPoint): number {
  return Math.floor((p.received / p.total) * 100)
}

/** Whether `next` is worth sending, given the last point that was sent. */
export function shouldEmitProgress(prev: ProgressPoint, next: ProgressPoint): boolean {
  if (next.total <= 0 || prev.total <= 0) return next.at - prev.at >= UNKNOWN_TOTAL_MS
  return percent(next) !== percent(prev)
}
