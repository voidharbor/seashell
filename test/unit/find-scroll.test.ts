import { describe, expect, it } from 'vitest'
import { targetScrollLine } from '../../src/renderer/term/find-scroll.js'

describe('targetScrollLine', () => {
  it('returns null when the row is already visible', () => {
    expect(targetScrollLine(105, 100, 40)).toBeNull()
    expect(targetScrollLine(100, 100, 40)).toBeNull()
    expect(targetScrollLine(139, 100, 40)).toBeNull()
  })
  it('centres a row above the viewport', () => {
    expect(targetScrollLine(17, 2000, 40)).toBe(0)
    expect(targetScrollLine(500, 2000, 40)).toBe(480)
  })
  it('centres a row below the viewport', () => {
    expect(targetScrollLine(2500, 100, 40)).toBe(2480)
  })
  it('never goes negative', () => {
    expect(targetScrollLine(5, 100, 40)).toBe(0)
  })
})
