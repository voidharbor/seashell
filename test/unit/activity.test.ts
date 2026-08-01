import { describe, expect, it } from 'vitest'
import {
  BUSY_CPU_PERCENT,
  QUIET_OUTPUT_BYTES_PER_SEC,
  classifyActivity,
} from '../../src/main/monitor/activity.js'

const SWEEP = 5000

const classify = (
  nonShellCount: number,
  cpuPercent: number,
  outputBytes = 0,
  elapsedMs = SWEEP
): ReturnType<typeof classifyActivity> =>
  classifyActivity({ nonShellCount, cpuPercent, outputBytes, elapsedMs })

describe('classifyActivity', () => {
  it('is at a prompt when nothing but the shell is running', () => {
    expect(classify(0, 0)).toBe('PROMPT')
    // Even a busy shell is still just a shell — there is nothing to wait on.
    expect(classify(0, 90)).toBe('PROMPT')
  })

  it('is busy above the CPU threshold', () => {
    // §19.3 measured working agents at 23–28% of a core.
    expect(classify(1, 25)).toBe('BUSY')
    expect(classify(1, BUSY_CPU_PERCENT + 0.1)).toBe('BUSY')
  })

  it('is still when the program is cheap and silent', () => {
    // §19.3 measured idle agents at 1–3.7%.
    expect(classify(1, 2)).toBe('WAITING')
    expect(classify(1, BUSY_CPU_PERCENT)).toBe('WAITING')
  })

  /**
   * The signal CPU alone cannot provide. An agent thinking on a network round
   * trip burns almost nothing, so by CPU it is indistinguishable from an agent
   * that has stopped and is waiting on you. What separates them is that one of
   * them is still drawing.
   */
  it('treats a pane that is still painting as busy however cheap it is', () => {
    const spinnerBytes = 200 * (SWEEP / 1000)
    expect(classify(1, 1, spinnerBytes)).toBe('BUSY')
  })

  it('does not mistake a trickle for activity', () => {
    const trickle = 10 * (SWEEP / 1000)
    expect(classify(1, 1, trickle)).toBe('WAITING')
  })

  it('judges output as a rate, so a longer sweep is not automatically busy', () => {
    // The hidden-window cadence is 30s. The same quiet trickle must classify
    // the same way at either cadence — a fixed per-sweep budget would not.
    const bytesIn30s = 10 * 30
    expect(classify(1, 1, bytesIn30s, 30_000)).toBe('WAITING')

    const spinnerIn30s = 200 * 30
    expect(classify(1, 1, spinnerIn30s, 30_000)).toBe('BUSY')
  })

  it('pins the rate boundary itself', () => {
    const justUnder = QUIET_OUTPUT_BYTES_PER_SEC * (SWEEP / 1000)
    expect(classify(1, 1, justUnder)).toBe('WAITING')
    expect(classify(1, 1, justUnder + 1)).toBe('BUSY')
  })

  it('reads a pane it has never sampled before as busy, not waiting', () => {
    // No previous sample means no elapsed time. A pane that just spawned is
    // starting up; calling it "waiting for you" would glow it immediately.
    expect(classify(1, 0, 4096, 0)).toBe('BUSY')
    // But a genuinely silent one with no baseline is still silent.
    expect(classify(1, 0, 0, 0)).toBe('WAITING')
  })
})
