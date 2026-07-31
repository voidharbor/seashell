import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebar,
  widthFromDrag,
} from '../../src/renderer/layout/sidebar.js'

describe('clampSidebar', () => {
  it('holds the width inside the usable range', () => {
    expect(clampSidebar(0)).toBe(SIDEBAR_MIN)
    expect(clampSidebar(-400)).toBe(SIDEBAR_MIN)
    expect(clampSidebar(99999)).toBe(SIDEBAR_MAX)
    expect(clampSidebar(300)).toBe(300)
  })

  it('falls back to the default for a corrupt value', () => {
    expect(clampSidebar(Number.NaN)).toBe(SIDEBAR_DEFAULT)
    expect(clampSidebar(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT)
  })

  it('returns whole pixels', () => {
    expect(Number.isInteger(clampSidebar(240.7))).toBe(true)
  })
})

describe('widthFromDrag', () => {
  /**
   * The point of dividing by the scale: the stored width is a base width at
   * zoom 1. Storing the rendered width instead would bake the zoom level into
   * the preference, so a sidebar sized at 150% zoom would come back two thirds
   * as wide at 100%.
   */
  it('divides the rendered drag back out by the zoom scale', () => {
    expect(widthFromDrag(300, 1)).toBe(300)
    expect(widthFromDrag(450, 1.5)).toBe(300)
    expect(widthFromDrag(255, 0.85)).toBe(300)
  })

  it('round-trips a width across a zoom change', () => {
    const scale = 1.32
    const base = 340
    // Dragging to where `base` renders at this scale must store `base` again.
    expect(widthFromDrag(base * scale, scale)).toBe(base)
  })

  it('still clamps after scaling', () => {
    expect(widthFromDrag(20, 1)).toBe(SIDEBAR_MIN)
    expect(widthFromDrag(5000, 1)).toBe(SIDEBAR_MAX)
    // A tiny scale must not turn a normal drag into an absurd width.
    expect(widthFromDrag(300, 0.01)).toBe(SIDEBAR_MAX)
  })

  it('treats a nonsense scale as 1 rather than dividing by zero', () => {
    expect(widthFromDrag(300, 0)).toBe(300)
    expect(widthFromDrag(300, -2)).toBe(300)
    expect(widthFromDrag(300, Number.NaN)).toBe(300)
  })
})
