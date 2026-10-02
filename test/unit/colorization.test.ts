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
  it('never throws', () => {
    for (const bad of ['', '#', '#GGGGGG', '#1234567890', 7 as never, {} as never]) expect(() => colorizationToTokens(bad)).not.toThrow()
  })
})

describe('shell:colorization fills model.tokens', () => {
  it('derives the tokens, carries composition, and falls back on a bad payload', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    expect(c.model().tokens).toEqual({ ...colorizationToTokens(null), composition: '1' })
    c.push('shell:colorization', { argb: '#C8107C10', opaque: false, composition: true })
    expect(c.model().tokens.accent).toBe('#107C10')
    expect(c.model().tokens.composition).toBe('1')
    c.push('shell:colorization', { argb: '#C8107C10', opaque: false, composition: false })
    expect(c.model().tokens.composition).toBe('0')
    c.push('shell:colorization', null)
    expect(c.model().tokens).toEqual({ ...colorizationToTokens(null), composition: '1' })
  })
})
