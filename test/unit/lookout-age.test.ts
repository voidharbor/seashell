import { describe, expect, it } from 'vitest'
import { ageLabel } from '../../src/renderer/lookout/age.js'

const T = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

describe('ageLabel', () => {
  it('reads "now" for anything under a minute', () => {
    expect(ageLabel(T, T)).toBe('now')
    expect(ageLabel(T, T + 59_999)).toBe('now')
  })
  it('counts whole minutes up to an hour', () => {
    expect(ageLabel(T, T + MIN)).toBe('1m')
    expect(ageLabel(T, T + 59 * MIN)).toBe('59m')
  })
  it('switches to hours, dropping a zero minute part', () => {
    expect(ageLabel(T, T + HOUR)).toBe('1h')
    expect(ageLabel(T, T + HOUR + 5 * MIN)).toBe('1h 5m')
    expect(ageLabel(T, T + 2 * HOUR)).toBe('2h')
  })
  it('collapses anything a day old', () => {
    expect(ageLabel(T, T + 24 * HOUR)).toBe('1d+')
    expect(ageLabel(T, T + 400 * HOUR)).toBe('1d+')
  })
  /**
   * `createdAt` is stamped in main and read in the renderer. They share a wall
   * clock, but a card can still be a millisecond "in the future" at the render
   * that first shows it. "-0m" is worse than nothing, so nothing is what the
   * caller gets.
   */
  it('says nothing rather than a negative age', () => {
    expect(ageLabel(T + 5_000, T)).toBeNull()
  })
  it('says nothing for a nonsense timestamp', () => {
    expect(ageLabel(Number.NaN, T)).toBeNull()
    expect(ageLabel(T, Number.NaN)).toBeNull()
  })
})
