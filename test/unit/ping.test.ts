import { describe, expect, it } from 'vitest'
import { PING_MIN_GAP_MS, shouldPing } from '../../src/renderer/panes/ping.js'

/**
 * The rate limit is the part with a real rule. Six panes finishing at once is
 * one event to a human, and six overlapping pings is just noise — so the gap is
 * enforced globally rather than per pane, and callers are free to fire per pane
 * without coordinating.
 */
describe('shouldPing', () => {
  it('always allows the first ping', () => {
    expect(shouldPing(1000, null)).toBe(true)
  })

  it('suppresses a second ping inside the gap', () => {
    expect(shouldPing(1000 + PING_MIN_GAP_MS - 1, 1000)).toBe(false)
  })

  it('allows one again once the gap has passed', () => {
    expect(shouldPing(1000 + PING_MIN_GAP_MS, 1000)).toBe(true)
  })

  it('collapses a burst of panes into a single ping', () => {
    const start = 5000
    let last: number | null = null
    let sounded = 0
    // Six panes reporting attention within the same tick.
    for (let i = 0; i < 6; i += 1) {
      const now = start + i * 3
      if (shouldPing(now, last)) {
        sounded += 1
        last = now
      }
    }
    expect(sounded).toBe(1)
  })

  it('does not go silent if the clock jumps backwards', () => {
    // A backwards jump would otherwise make `now - lastAt` negative forever.
    expect(shouldPing(500, 9000)).toBe(true)
  })

  it('honours an explicit gap', () => {
    expect(shouldPing(1050, 1000, 100)).toBe(false)
    expect(shouldPing(1100, 1000, 100)).toBe(true)
  })
})

/**
 * Sleep has to silence the ping too. This mirrors the gate in app.tsx rather
 * than reaching into the component, because the rule — sound is subordinate to
 * glow — is the thing worth pinning, not the wiring.
 */
function audible(attentionGlow: boolean, attentionSound: boolean): boolean {
  return attentionGlow && attentionSound
}

describe('sleep gating', () => {
  it('is silent while asleep even with sound enabled', () => {
    expect(audible(false, true)).toBe(false)
  })

  it('is silent when sound is off but awake', () => {
    expect(audible(true, false)).toBe(false)
  })

  it('sounds only when awake and enabled', () => {
    expect(audible(true, true)).toBe(true)
  })
})
