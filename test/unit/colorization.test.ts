import { describe, expect, it } from 'vitest'
import { colorizationToTokens } from '../../src/core/controller/colorization.js'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

describe('colorizationToTokens (Review Focus 5)', () => {
  it('returns the spec table for the desktop color and for missing or malformed input', () => {
    const want = colorizationToTokens('#C8881798')
    expect(want.accent.toLowerCase()).toBe('#881798')
    expect(colorizationToTokens(undefined)).toEqual(want)
    expect(colorizationToTokens(null)).toEqual(want)
    expect(colorizationToTokens('purple')).toEqual(want)
    expect(colorizationToTokens('#12')).toEqual(want)
  })
  it('derives readable text for a light colorization', () => {
    const t = colorizationToTokens('#C8F0F0F0')
    expect(t.frameText).toBe('#1E1E1E')
  })
  it('darkens only the strip tokens when darkStrip is set', () => {
    const light = colorizationToTokens('#FF881798', false)
    expect(light.stripDark).toBe('0')
    expect(light.tabActive).toBe('#FFFFFF')
    const dark = colorizationToTokens('#FF881798', false, true)
    expect(dark).toMatchObject({
      frame: '#1F1F1F',
      frameText: '#F0F0F0',
      tabActive: '#2B2B2B',
      tabInactive: '#1A1A1A',
      tabText: '#F0F0F0',
      badge: '#3A3A3A',
      badgeText: '#D0D0D0',
      glassTint: '#8C000000',
      stripDark: '1',
    })
    expect(dark.body).toBe(light.body)
    expect(dark.panel).toBe(light.panel)
    expect(dark.accent).toBe(light.accent)
    // A derived colorization keeps its own body too.
    expect(colorizationToTokens('#C8107C10', false, true).body).toBe(colorizationToTokens('#C8107C10').body)
  })
  it('never throws', () => {
    for (const bad of ['', '#', '#GGGGGG', '#1234567890', 7 as never, {} as never]) expect(() => colorizationToTokens(bad)).not.toThrow()
  })
})

describe('shell:colorization fills model.tokens', () => {
  it('derives the tokens, carries composition, and falls back to the opaque 6.2 strip on a bad payload', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    expect(c.model().tokens).toEqual({ ...colorizationToTokens(null), composition: '1' })
    c.push('shell:colorization', { argb: '#C8107C10', opaque: false, composition: true })
    expect(c.model().tokens.accent).toBe('#107C10')
    expect(c.model().tokens.composition).toBe('1')
    c.push('shell:colorization', { argb: '#C8107C10', opaque: false, composition: false })
    expect(c.model().tokens.composition).toBe('0')
    // Review Focus 5: a missing or malformed colorization is the 6.2 table on the opaque strip.
    c.push('shell:colorization', null)
    expect(c.model().tokens).toEqual({ ...colorizationToTokens(null), composition: '0' })
    c.push('shell:colorization', { argb: 'purple', opaque: false, composition: true })
    expect(c.model().tokens).toEqual({ ...colorizationToTokens(null), composition: '0' })
    c.push('shell:colorization', { argb: '#C8881798', opaque: false, composition: true })
    expect(c.model().tokens.composition).toBe('1')
  })
})
