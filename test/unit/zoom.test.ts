import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ZOOM_INDEX,
  ZOOM_LEVELS,
  clampIndex,
  levelAt,
} from '../../src/renderer/term/zoom.js'

/**
 * The ladder's whole reason to exist is that an arbitrary font size produces
 * sub-pixel cell drift in the WebGL renderer. If a size ever creeps in whose
 * scaled advance is not near a pixel boundary, the symptom is misaligned
 * box-drawing borders — visually subtle, and very hard to trace back here.
 * So the property is asserted directly rather than trusted to review.
 */
const SF_MONO_ADVANCE_EM = 0.61816
const DPR = 2

function residualDistance(px: number): number {
  const scaled = px * SF_MONO_ADVANCE_EM * DPR
  const frac = scaled - Math.floor(scaled)
  return Math.min(frac, 1 - frac)
}

describe('zoom ladder', () => {
  it('only contains font sizes that land near a device-pixel boundary', () => {
    for (const level of ZOOM_LEVELS) {
      expect(
        residualDistance(level.font),
        `${level.font}px has residual distance ${residualDistance(level.font).toFixed(3)}`
      ).toBeLessThan(0.22)
    }
  })

  it('excludes 14px, the size whose residual made it unusable', () => {
    expect(ZOOM_LEVELS.map((l) => l.font)).not.toContain(14)
  })

  it('is strictly increasing in both font size and chrome scale', () => {
    for (let i = 1; i < ZOOM_LEVELS.length; i += 1) {
      expect(ZOOM_LEVELS[i]!.font).toBeGreaterThan(ZOOM_LEVELS[i - 1]!.font)
      expect(ZOOM_LEVELS[i]!.ui).toBeGreaterThan(ZOOM_LEVELS[i - 1]!.ui)
    }
  })

  it('scales chrome more gently than text', () => {
    const first = ZOOM_LEVELS[0]!
    const last = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!
    const fontRatio = last.font / first.font
    const uiRatio = last.ui / first.ui
    expect(uiRatio).toBeLessThan(fontRatio)
  })

  it('defaults to 13px at chrome scale 1', () => {
    expect(levelAt(DEFAULT_ZOOM_INDEX)).toEqual({ font: 13, ui: 1.0 })
  })
})

describe('clampIndex', () => {
  it('clamps rather than wrapping at both ends', () => {
    expect(clampIndex(-5)).toBe(0)
    expect(clampIndex(ZOOM_LEVELS.length + 5)).toBe(ZOOM_LEVELS.length - 1)
  })

  it('treats any non-finite value as corrupt and returns the default', () => {
    expect(clampIndex(Number.NaN)).toBe(DEFAULT_ZOOM_INDEX)
    expect(clampIndex(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM_INDEX)
    expect(clampIndex(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_ZOOM_INDEX)
  })

  it('never returns an index levelAt cannot resolve', () => {
    for (const raw of [-100, -1, 0, 3, 99, 1e9]) {
      expect(levelAt(clampIndex(raw))).toBeDefined()
    }
  })
})
