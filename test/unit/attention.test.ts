import { describe, expect, it } from 'vitest'
import {
  DONE_ATTENTION_MS,
  WAITING_SETTLE_MS,
  doneExpired,
  nextAttention,
  type Attention,
} from '../../src/renderer/panes/attention.js'
import type { PaneActivity } from '../../src/shared/ipc.js'

/** One tick, for the cases where the settle clock is not what is being tested. */
const at = (
  previous: PaneActivity | undefined,
  next: PaneActivity,
  current: Attention = null,
  focused = false
): Attention =>
  nextAttention({
    previous,
    next,
    current,
    focused,
    // Already settled, so these cases read as they did before the debounce
    // existed and keep testing the transition rules rather than the clock.
    waitingSince: 0,
    now: WAITING_SETTLE_MS,
  }).attention

/**
 * Drives a sequence of sweeps the way the reducer does, carrying `waitingSince`
 * and `current` forward. The original bug was only ever visible as a sequence —
 * any single sample looked perfectly reasonable — so this is the shape most of
 * these tests need.
 */
function run(
  states: PaneActivity[],
  opts: { stepMs?: number; focused?: boolean } = {}
): Attention[] {
  const step = opts.stepMs ?? 5000
  let current: Attention = null
  let waitingSince: number | undefined
  let previous: PaneActivity | undefined
  const out: Attention[] = []

  states.forEach((next, i) => {
    const outcome = nextAttention({
      previous,
      next,
      current,
      focused: opts.focused ?? false,
      waitingSince,
      now: i * step,
    })
    current = outcome.attention
    waitingSince = outcome.waitingSince
    previous = next
    out.push(outcome.attention)
  })

  return out
}

describe('nextAttention', () => {
  it('glows once a foreground program has been still long enough', () => {
    expect(at('BUSY', 'WAITING')).toBe('waiting')
    expect(at('WAITING', 'WAITING')).toBe('waiting')
  })

  it('glows when work finishes and the shell comes back', () => {
    expect(at('BUSY', 'PROMPT')).toBe('done')
    expect(at('WAITING', 'PROMPT')).toBe('done')
  })

  it('does not re-trigger for a pane that was already idle at a prompt', () => {
    // Otherwise every idle pane would re-arm on every metrics tick and the
    // whole grid would pulse permanently.
    expect(at('PROMPT', 'PROMPT')).toBeNull()
    expect(at('PROMPT', 'PROMPT', 'done')).toBe('done')
  })

  it('clears once a pane starts working again', () => {
    expect(at('WAITING', 'BUSY', 'waiting')).toBeNull()
    expect(at('PROMPT', 'BUSY', 'done')).toBeNull()
  })

  it('never glows the pane you are looking at', () => {
    expect(at('BUSY', 'WAITING', null, true)).toBeNull()
    expect(at('BUSY', 'PROMPT', 'done', true)).toBeNull()
  })

  it('treats a first sighting with no previous state sensibly', () => {
    expect(at(undefined, 'WAITING')).toBe('waiting')
    // No previous state means nothing is known to have finished.
    expect(at(undefined, 'PROMPT')).toBeNull()
  })
})

/**
 * The reported bug, pinned.
 *
 * `WAITING` used to mean only "a non-shell process exists and CPU is low",
 * which is the resting state of every agent. The pane therefore glowed forever
 * and re-pinged on every dip below the CPU threshold, to the point where the
 * sleep toggle was the only way to work.
 */
describe('stillness has to be sustained', () => {
  it('stays silent for a pane that has only just gone quiet', () => {
    // Four sweeps at 5s is 15s of stillness — not yet enough.
    expect(run(['BUSY', 'WAITING', 'WAITING', 'WAITING'])).toEqual([null, null, null, null])
  })

  it('asks once the stillness actually lasts', () => {
    const seen = run(['BUSY', 'WAITING', 'WAITING', 'WAITING', 'WAITING', 'WAITING'])
    expect(seen.at(-1)).toBe('waiting')
    // And only after the settle window, never before it.
    expect(seen.slice(0, 4)).toEqual([null, null, null, null])
  })

  it('never glows an agent that dips below the CPU threshold between tool calls', () => {
    // The exact flap that made this fire every few seconds: an agent's CPU
    // crosses the busy line constantly during normal work.
    const flapping: PaneActivity[] = [
      'BUSY', 'WAITING', 'BUSY', 'WAITING', 'BUSY', 'WAITING', 'BUSY', 'WAITING', 'BUSY',
    ]
    expect(run(flapping).every((a) => a === null)).toBe(true)
  })

  it('restarts the clock whenever the pane does anything at all', () => {
    // Three sweeps still, one blip of work, three more still: no single run
    // reaches the threshold, so nothing asks.
    const seen = run(['WAITING', 'WAITING', 'WAITING', 'BUSY', 'WAITING', 'WAITING', 'WAITING'])
    expect(seen.every((a) => a === null)).toBe(true)
  })

  it('measures elapsed time, not sweeps, so a slower cadence still settles', () => {
    // The monitor stretches to 30s while the window is hidden. Two sweeps that
    // far apart are genuinely a minute of stillness and must count.
    const seen = run(['BUSY', 'WAITING', 'WAITING'], { stepMs: 30_000 })
    expect(seen.at(-1)).toBe('waiting')
  })
})

/**
 * The ping fires on the transition into attention, so the number of times
 * attention *starts* is exactly the number of pings the user hears. That is the
 * symptom Josh reported, so it is worth asserting directly rather than
 * inferring it from the states.
 */
describe('how often it would ping', () => {
  const pings = (seen: Attention[]): number =>
    seen.filter((a, i) => a !== null && (i === 0 || seen[i - 1] === null)).length

  it('does not ping at all through a long working stretch', () => {
    const working: PaneActivity[] = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? 'BUSY' : 'WAITING'
    )
    expect(pings(run(working))).toBe(0)
  })

  it('pings once when an agent genuinely stops and waits', () => {
    const seen = run(['BUSY', ...Array.from({ length: 20 }, (): PaneActivity => 'WAITING')])
    expect(pings(seen)).toBe(1)
  })
})

describe('looking at a pane', () => {
  it('resets the clock, so dismissing it does not re-glow moments later', () => {
    // Settled and glowing...
    const settled = nextAttention({
      previous: 'WAITING',
      next: 'WAITING',
      current: null,
      focused: false,
      waitingSince: 0,
      now: WAITING_SETTLE_MS,
    })
    expect(settled.attention).toBe('waiting')

    // ...you click it, which acknowledges it and drops the run...
    const looked = nextAttention({
      previous: 'WAITING',
      next: 'WAITING',
      current: settled.attention,
      focused: true,
      waitingSince: settled.waitingSince,
      now: WAITING_SETTLE_MS + 5000,
    })
    expect(looked.attention).toBeNull()
    expect(looked.waitingSince).toBeUndefined()

    // ...and looking away starts a fresh settle window rather than glowing
    // again on the very next tick.
    const away = nextAttention({
      previous: 'WAITING',
      next: 'WAITING',
      current: null,
      focused: false,
      waitingSince: looked.waitingSince,
      now: WAITING_SETTLE_MS + 10_000,
    })
    expect(away.attention).toBeNull()
  })
})

describe('doneExpired', () => {
  it('stops asking after the window passes', () => {
    expect(doneExpired(1000, 1000 + DONE_ATTENTION_MS)).toBe(true)
    expect(doneExpired(1000, 1000 + DONE_ATTENTION_MS - 1)).toBe(false)
  })

  it('never expires something that was never set', () => {
    expect(doneExpired(undefined, Date.now())).toBe(false)
  })
})
