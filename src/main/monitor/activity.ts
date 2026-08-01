import type { PaneActivity } from '../../shared/ipc.js'

/**
 * Deciding what a pane is doing, from one sweep's worth of evidence.
 *
 * Pulled out of the monitor and made pure because the rule here was wrong for a
 * long time in a way that was invisible: `WAITING` used to mean nothing more
 * than "a non-shell process exists and CPU is low". That is the *resting state
 * of every agent*, not a request for attention, so every idle `claude` pane
 * glowed permanently and pinged every time its CPU crossed the threshold.
 *
 * The CPU threshold itself was never the problem — §19.3 measured idle agents
 * at 1–3.7% of a core against 23–28% while working, so 5% separates them
 * cleanly. What was wrong is that **"not busy" was treated as "wants you"**.
 *
 * Two things fix it, and only the first lives here:
 *
 *  1. A pane that is still *painting* is working, whatever its CPU says. An
 *     agent thinking on a network round trip burns almost no CPU while its
 *     spinner animates, and that is indistinguishable from a finished agent by
 *     CPU alone. Output volume cannot carry the decision by itself (§10.3 — a
 *     spinner emits bytes forever while doing nothing), but *combined* with low
 *     CPU it separates "waiting on the network" from "waiting on you", which
 *     CPU alone cannot.
 *
 *  2. Stillness has to be sustained before it means anything. That part is
 *     deliberately not here — it belongs to the renderer's attention state
 *     machine, which is where it can be tested as a sequence rather than as a
 *     single sample. See `renderer/panes/attention.ts`.
 */

/** Above this share of a core, a pane is working rather than waiting. §19.3. */
export const BUSY_CPU_PERCENT = 5

/**
 * Output a pane may produce and still count as still.
 *
 * A **rate**, not a per-sweep count, and that is deliberate: the sweep interval
 * is not constant — it stretches while the window is hidden — so a fixed byte
 * budget per sweep would quietly mean a different thing depending on whether
 * anyone was looking. This is the same trap §19.3 flags for CPU-fraction maths,
 * and it applies to any per-interval quantity.
 *
 * Not zero. A pane genuinely waiting at a prompt emits nothing at all, so
 * almost any positive value works; the slack just avoids reacting to a stray
 * cursor-position report. A spinner at any watchable frame rate clears this by
 * an order of magnitude.
 */
export const QUIET_OUTPUT_BYTES_PER_SEC = 50

export interface ActivityInput {
  /** Processes in the pane's subtree that are not the pane's own shell. */
  nonShellCount: number
  /** Summed `ps` pcpu across the subtree, as a percentage of one core. */
  cpuPercent: number
  /** Bytes the pane wrote to the terminal since the previous sweep. */
  outputBytes: number
  /** Real time since the previous sweep. Never the nominal interval. */
  elapsedMs: number
}

export function classifyActivity(input: ActivityInput): PaneActivity {
  // Nothing but the shell: there is no program to be waiting on.
  if (input.nonShellCount <= 0) return 'PROMPT'
  if (input.cpuPercent > BUSY_CPU_PERCENT) return 'BUSY'

  // Cheap on CPU but still drawing — a spinner, a progress bar, a stream being
  // rendered. Busy is the honest answer: it is mid-something, so it is not
  // waiting on the user. Erring this way is deliberate. Mistaking a working
  // pane for a waiting one nags; mistaking a waiting pane for a working one is
  // merely quiet, and a calm app that occasionally notices a prompt late beats
  // one that cries constantly.
  if (input.elapsedMs > 0) {
    const bytesPerSec = (input.outputBytes * 1000) / input.elapsedMs
    if (bytesPerSec > QUIET_OUTPUT_BYTES_PER_SEC) return 'BUSY'
  } else if (input.outputBytes > 0) {
    return 'BUSY'
  }

  return 'WAITING'
}
