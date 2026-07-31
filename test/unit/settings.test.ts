import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, coerceSettings } from '../../src/renderer/settings/settings.js'

/**
 * Settings are merged over the defaults rather than trusted, so a value written
 * by an older build — or hand-edited — can never leave a setting missing or the
 * wrong type. A missing boolean read as `undefined` would silently disable a
 * feature the user never turned off.
 */
describe('coerceSettings', () => {
  it('returns the defaults for anything unusable', () => {
    expect(coerceSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(coerceSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(coerceSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(coerceSettings([])).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps stored booleans', () => {
    const stored = { ...DEFAULT_SETTINGS, attentionGlow: false, autoTitlePanes: false }
    expect(coerceSettings(stored)).toEqual(stored)
  })

  it('fills in a key an older build never wrote', () => {
    const partial = { attentionGlow: false }
    const result = coerceSettings(partial)
    expect(result.attentionGlow).toBe(false)
    expect(result.autoTitlePanes).toBe(DEFAULT_SETTINGS.autoTitlePanes)
  })

  it('ignores values of the wrong type rather than adopting them', () => {
    const result = coerceSettings({ attentionGlow: 'yes', autoTitlePanes: 1 })
    expect(result.attentionGlow).toBe(DEFAULT_SETTINGS.attentionGlow)
    expect(result.autoTitlePanes).toBe(DEFAULT_SETTINGS.autoTitlePanes)
  })

  it('drops keys that are not settings', () => {
    const result = coerceSettings({ ...DEFAULT_SETTINGS, evil: true })
    expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })

  it('every default is on, so a fresh install shows the features', () => {
    expect(Object.values(DEFAULT_SETTINGS).every((v) => v === true)).toBe(true)
  })
})
