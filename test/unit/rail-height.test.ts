import { describe, expect, it } from 'vitest'
import {
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  clampRail,
  heightFromDrag,
} from '../../src/renderer/layout/rail.js'

describe('clampRail', () => {
  it('holds the range', () => {
    expect(clampRail(RAIL_MIN - 50)).toBe(RAIL_MIN)
    expect(clampRail(RAIL_MAX + 500)).toBe(RAIL_MAX)
    expect(clampRail(300)).toBe(300)
  })

  it('falls back rather than storing garbage', () => {
    expect(clampRail(Number.NaN)).toBe(RAIL_DEFAULT)
    expect(clampRail(Number.POSITIVE_INFINITY)).toBe(RAIL_DEFAULT)
  })
})

describe('heightFromDrag', () => {
  it('measures from the rail top, not the window top', () => {
    // Pointer 400px down the window, rail starts 100px down: 300px of rail.
    expect(heightFromDrag(400, 100, 1)).toBe(300)
  })

  it('divides the zoom back out so the stored height is zoom-independent', () => {
    // At 150% zoom a 450px rendered rail is a 300px base height — store the
    // base, or the zoom level gets baked into the preference.
    expect(heightFromDrag(550, 100, 1.5)).toBe(300)
  })

  it('treats a nonsense scale as 1 instead of dividing by zero', () => {
    expect(heightFromDrag(400, 100, 0)).toBe(300)
    expect(heightFromDrag(400, 100, Number.NaN)).toBe(300)
  })

  it('clamps a drag past either end', () => {
    expect(heightFromDrag(100, 100, 1)).toBe(RAIL_MIN) // dragged shut
    expect(heightFromDrag(99_999, 100, 1)).toBe(RAIL_MAX) // dragged off-screen
  })
})
