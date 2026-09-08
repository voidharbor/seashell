import type { PaneActivity } from '../../shared/ipc.js'

/**
 * Whether a pane should be asking for your eyes.
 *
 * `waiting` is an EVENT now, not an inference. It is set by the reducer when
 * the pane's program rings the terminal bell (`pane.bell`) while the pane is
 * unfocused and its foreground is not the bare shell. Claude Code rings on a
 * permission prompt and on an idle prompt after a turn, once its notification
 * channel is the terminal bell; other programs ring when they mean it. The
 * old rule, twenty seconds of low CPU, was the resting state of every idle
 * agent, so every finished pane glowed like one asking a question.
 *
 * This function only carries a set `waiting` forward and decides `done`:
 *  - focused clears everything (looking at it is acknowledging it),
 *  - a program that goes back to work (BUSY) has nothing to ask yet,
 *  - returning to the shell prompt after running something pulses `done`.
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
  if (input.focused) return null
  if (input.next === 'BUSY') return null
  if (input.next === 'PROMPT') {
    if (input.previous === 'BUSY' || input.previous === 'WAITING') return 'done'
    return input.current === 'done' ? 'done' : null
  }
  // WAITING: carry a bell-set waiting forward; never create one here.
  return input.current === 'waiting' ? 'waiting' : input.current === 'done' ? 'done' : null
}

/** True once a finished pulse has run long enough to stop. */
export function doneExpired(setAt: number | undefined, now: number): boolean {
  if (setAt === undefined) return false
  return now - setAt >= DONE_ATTENTION_MS
}
