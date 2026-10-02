import { describe, expect, it } from 'vitest'
import { clampToWorkArea, parseSavedBounds } from '../../src/main/window-bounds.js'

// A 3440x1440 primary at 0,0 with a 1920x1080 display above it at 760,-1080.
const PRIMARY = { x: 0, y: 0, width: 3440, height: 1400 }
const PHILIPS = { x: 760, y: -1080, width: 1920, height: 1040 }

describe('clampToWorkArea', () => {
  it('leaves bounds that already fit untouched', () => {
    const b = { x: 100, y: 80, width: 1440, height: 900 }
    expect(clampToWorkArea(b, PRIMARY)).toEqual(b)
  })

  it('pulls a window out of the dead quadrant left of the upper display', () => {
    const r = clampToWorkArea({ x: 0, y: -900, width: 1440, height: 900 }, PHILIPS)
    expect(r).toEqual({ x: 760, y: -940, width: 1440, height: 900 })
  })

  it('slides a window hanging off the right and bottom back inside', () => {
    expect(clampToWorkArea({ x: 3000, y: 1000, width: 1440, height: 900 }, PRIMARY)).toEqual({
      x: 2000,
      y: 500,
      width: 1440,
      height: 900,
    })
  })

  it('shrinks a window larger than the work area to fit it', () => {
    expect(clampToWorkArea({ x: -50, y: -2000, width: 4000, height: 3000 }, PHILIPS)).toEqual(
      PHILIPS
    )
  })

  it('rounds fractional bounds to integers', () => {
    const r = clampToWorkArea({ x: 10.4, y: 20.6, width: 800.5, height: 600.2 }, PRIMARY)
    for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true)
  })
})

describe('parseSavedBounds', () => {
  it('reads valid bounds and the maximized flag', () => {
    expect(parseSavedBounds('{"x":1,"y":2,"width":3,"height":4,"maximized":true}')).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      maximized: true,
    })
    expect(parseSavedBounds('{"x":1,"y":2,"width":3,"height":4}')?.maximized).toBe(false)
  })

  it('rejects junk', () => {
    for (const text of [
      '',
      'nope',
      'null',
      '[]',
      '{"x":1,"y":2,"width":0,"height":4}',
      '{"x":"1","y":2,"width":3,"height":4}',
    ]) {
      expect(parseSavedBounds(text)).toBeNull()
    }
  })
})
