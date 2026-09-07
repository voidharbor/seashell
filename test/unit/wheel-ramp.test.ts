import { describe, expect, it } from 'vitest'
import { WHEEL_RAMP_DEFAULTS, WheelRamp } from '../../src/renderer/term/wheel-ramp.js'

/** Feed `n` events of `dy` px every `gapMs`, return the last multiplier. */
function drive(ramp: WheelRamp, n: number, dy: number, gapMs: number, start = 1000): number {
  let m = 1
  for (let i = 0; i < n; i += 1) m = ramp.feed(dy, 0, start + i * gapMs)
  return m
}

describe('WheelRamp', () => {
  it('is exactly 1 on the first event and for slow, deliberate scrolling', () => {
    const r = new WheelRamp()
    expect(r.feed(3, 0, 1000)).toBe(1)
    // 4 px every 16 ms is 0.25 px/ms, well under the onset.
    expect(drive(r, 30, 4, 16)).toBe(1)
  })

  it('ramps above 1 on a fast flick and reaches the ceiling', () => {
    const r = new WheelRamp()
    const m = drive(r, 40, 120, 8) // 15 px/ms
    expect(m).toBeGreaterThan(1)
    expect(m).toBe(WHEEL_RAMP_DEFAULTS.ceiling)
  })

  it('grows monotonically while the flick continues', () => {
    const r = new WheelRamp()
    const a = drive(r, 5, 60, 8)
    const b = drive(r, 5, 60, 8, 1000 + 5 * 8)
    expect(b).toBeGreaterThanOrEqual(a)
  })

  it('resets to 1 after a pause longer than the decay', () => {
    const r = new WheelRamp()
    expect(drive(r, 40, 120, 8)).toBe(WHEEL_RAMP_DEFAULTS.ceiling)
    expect(r.feed(120, 0, 1000 + 40 * 8 + WHEEL_RAMP_DEFAULTS.decayMs + 1)).toBe(1)
  })

  it('normalises line and page delta modes into pixels', () => {
    const r = new WheelRamp()
    // 3 lines every 8 ms in DOM_DELTA_LINE mode is ~48 px per 8 ms = 6 px/ms.
    const m = (() => {
      let v = 1
      for (let i = 0; i < 30; i += 1) v = r.feed(3, 1, 1000 + i * 8)
      return v
    })()
    expect(m).toBeGreaterThan(1)
  })
})
