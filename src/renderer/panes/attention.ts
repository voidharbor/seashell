import type { PaneActivity } from '../../shared/ipc.js'

/**
 * Whether a pane should be asking for your eyes.
 *
 * Two things are worth interrupting for, and the monitor distinguishes them
 * (§10.3): a pane whose foreground program has gone still is **waiting** — an
 * agent sitting on a question — and a pane that has just dropped back to a
 * shell prompt has **finished** whatever it was running.
 *
 * `waiting` is a steady state, so it glows for as long as it lasts. `done` is
 * an event, so it glows briefly and stops; left on, every finished pane in the
 * tab would glow forever and the signal would mean nothing.
 *
 * A focused pane never glows. You are already looking at it, and a pulsing
 * border around the terminal you are typing into is an irritation, not
 * information.
 *
 * ---
 *
 * **Stillness must be sustained.** This is the half of the idle-detection fix
 * that does not belong in the monitor (the other half is `monitor/activity.ts`).
 *
 * A single quiet sample means nothing. An agent's CPU dips below the busy
 * threshold constantly during normal work — between tool calls, while waiting
 * on a round trip — and treating each dip as a fresh "started asking" edge is
 * what made the pane flap and the ping fire every few seconds. Requiring the
 * pane to hold still for `WAITING_SETTLE_MS` before it may ask is what turns
 * "not busy right now" into "it stopped, and it is waiting on you".
 *
 * Because the ping fires on the *transition* into attention, fixing the
 * flapping is also what stops the ping repeating. There is deliberately no
 * second rate limiter layered on top of it.
 *
 * Measured in elapsed milliseconds rather than in sweeps, because the monitor's
 * cadence is not constant — it slows down while the window is hidden — and a
 * count of ticks would silently mean a different amount of stillness depending
 * on whether anyone was looking.
 */
export type Attention = 'waiting' | 'done' | null

/** How long a "finished" pulse runs before it stops asking. */
export const DONE_ATTENTION_MS = 9000

/**
 * How long a pane must hold still before it is treated as waiting on you.
 *
 * Four sweeps at the visible-window cadence. Long enough that ordinary pauses
 * in an agent's work never reach it, short enough to still be useful. A calm
 * app that occasionally notices a prompt late is much better than one that
 * cries constantly — the previous behaviour was bad enough that the sleep
 * toggle was the only way to work.
 */
export const WAITING_SETTLE_MS = 20_000

export interface AttentionInput {
  previous: PaneActivity | undefined
  next: PaneActivity
  current: Attention
  focused: boolean
  /**
   * When this pane's current unbroken run of stillness began, or undefined if
   * it is not currently still. Carried on the pane between ticks.
   */
  waitingSince: number | undefined
  now: number
}

export interface AttentionOutcome {
  attention: Attention
  /** Stored back on the pane, so the next tick can measure the same run. */
  waitingSince: number | undefined
}

export function nextAttention(input: AttentionInput): AttentionOutcome {
  const still = input.next === 'WAITING'

  // Looking at it counts as acknowledging it — and resets the clock. Otherwise
  // clicking a glowing pane to dismiss it would re-glow a tick after you looked
  // away, since the underlying run of stillness never ended. Having been seen,
  // a pane has to go quiet all over again before it may ask twice.
  if (input.focused) return { attention: null, waitingSince: undefined }

  const waitingSince = still ? (input.waitingSince ?? input.now) : undefined

  // A pane that started working has, by definition, nothing to report yet.
  if (input.next === 'BUSY') return { attention: null, waitingSince }

  if (still) {
    const settled = input.now - (waitingSince ?? input.now) >= WAITING_SETTLE_MS
    // Until it settles the pane says nothing new. Whatever it was already
    // showing stands — a `done` pulse still expires on its own schedule.
    return { attention: settled ? 'waiting' : input.current, waitingSince }
  }

  if (input.next === 'PROMPT') {
    // Back at a prompt after running something: that is the finish event. A
    // pane that was already at a prompt has not just finished anything, so it
    // keeps whatever it had rather than re-triggering every tick.
    if (input.previous === 'BUSY' || input.previous === 'WAITING') {
      return { attention: 'done', waitingSince }
    }
    return { attention: input.current, waitingSince }
  }

  return { attention: input.current, waitingSince }
}

/** True once a finished pulse has run long enough to stop. */
export function doneExpired(setAt: number | undefined, now: number): boolean {
  if (setAt === undefined) return false
  return now - setAt >= DONE_ATTENTION_MS
}
