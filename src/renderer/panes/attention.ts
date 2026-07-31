import type { PaneActivity } from '../../shared/ipc.js'

/**
 * Whether a pane should be asking for your eyes.
 *
 * Two things are worth interrupting for, and the monitor already distinguishes
 * them (§10.3): a pane whose foreground program is idle is **waiting** — an
 * agent sitting on a question — and a pane that has just dropped back to a
 * shell prompt has **finished** whatever it was running.
 *
 * `WAITING` is a steady state, so it glows for as long as it lasts. `done` is an
 * event, so it glows briefly and stops; left on, every finished pane in the tab
 * would glow forever and the signal would mean nothing.
 *
 * A focused pane never glows. You are already looking at it, and a pulsing
 * border around the terminal you are typing into is an irritation, not
 * information.
 */
export type Attention = 'waiting' | 'done' | null

/** How long a "finished" pulse runs before it stops asking. */
export const DONE_ATTENTION_MS = 9000

export interface AttentionInput {
  previous: PaneActivity | undefined
  next: PaneActivity
  current: Attention
  focused: boolean
}

export function nextAttention(input: AttentionInput): Attention {
  // Looking at it counts as acknowledging it.
  if (input.focused) return null

  // A pane that started working has, by definition, nothing to report yet.
  if (input.next === 'BUSY') return null

  if (input.next === 'WAITING') return 'waiting'

  if (input.next === 'PROMPT') {
    // Back at a prompt after running something: that is the finish event. A
    // pane that was already at a prompt has not just finished anything, so it
    // keeps whatever it had rather than re-triggering every tick.
    if (input.previous === 'BUSY' || input.previous === 'WAITING') return 'done'
    return input.current
  }

  return input.current
}

/** True once a finished pulse has run long enough to stop. */
export function doneExpired(setAt: number | undefined, now: number): boolean {
  if (setAt === undefined) return false
  return now - setAt >= DONE_ATTENTION_MS
}
