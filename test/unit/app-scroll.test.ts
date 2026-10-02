import { describe, expect, it } from 'vitest'
import {
  MIN_RANGE,
  MIN_THUMB_PX,
  applyNotches,
  dragNotches,
  initialScroll,
  thumbGeometry,
  trackSide,
} from '../../src/renderer/term/app-scroll.js'

describe('app scroll model', () => {
  it('starts at the bottom with the thumb resting on the end of the track', () => {
    const s = initialScroll()
    expect(s.offset).toBe(0)
    const t = thumbGeometry(s, 600)
    expect(t.top + t.height).toBe(600)
  })

  it('never scrolls below the bottom', () => {
    expect(applyNotches(initialScroll(), -3).offset).toBe(0)
  })

  it('moves the thumb up as the pane scrolls up', () => {
    const a = thumbGeometry(applyNotches(initialScroll(), 2), 600)
    const b = thumbGeometry(applyNotches(initialScroll(), 10), 600)
    expect(b.top).toBeLessThan(a.top)
  })

  it('grows the range instead of pinning the thumb at the top', () => {
    const s = applyNotches(initialScroll(), MIN_RANGE + 10)
    expect(s.range).toBeGreaterThan(s.offset)
    expect(thumbGeometry(s, 600).top).toBeGreaterThanOrEqual(0)
  })

  it('keeps the thumb grabbable on a short track', () => {
    expect(thumbGeometry(applyNotches(initialScroll(), 500), 100).height).toBe(MIN_THUMB_PX)
  })

  it('turns a drag up into notches up, and back down to zero', () => {
    const start = initialScroll()
    const up = dragNotches(start, start, -200, 600)
    expect(up).toBeGreaterThan(0)
    const moved = applyNotches(start, up)
    expect(dragNotches(start, moved, 0, 600)).toBe(-up)
  })

  it('sends nothing for a drag that ends where it started', () => {
    const s = applyNotches(initialScroll(), 7)
    expect(dragNotches(s, s, 0, 600)).toBe(0)
  })

  it('tells a press above, on and below the thumb apart', () => {
    const s = applyNotches(initialScroll(), 12)
    const t = thumbGeometry(s, 600)
    expect(trackSide(s, 600, t.top - 5)).toBe('above')
    expect(trackSide(s, 600, t.top + 1)).toBe('thumb')
    expect(trackSide(s, 600, t.top + t.height + 5)).toBe('below')
  })
})
