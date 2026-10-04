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
  it('keeps every text token at WCAG 4.5 on its background for a black colorization', () => {
    const lum = (hex: string): number => {
      const n = Number.parseInt(hex.slice(-6), 16)
      const lin = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)
      return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
    }
    const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    const t = colorizationToTokens('#FF000000')
    // The frame is mid-grey: #1E1E1E reads 3.94 on it and white 4.23, so the text is pure black (4.96).
    expect(t.frame).toBe('#7B7B7B')
    expect(t.frameText).toBe('#000000')
    const pairs: Array<[keyof typeof t, keyof typeof t]> = [
      ['frameText', 'frame'], ['tabText', 'tabActive'], ['tabText', 'tabInactive'], ['titleText', 'titleBar'],
      ['titleText', 'panel'], ['titleText', 'body'], ['badgeText', 'badge'], ['badgeText', 'titleBar'],
      ['badgeText', 'panel'], ['badgeText', 'toastBg'], ['statusText', 'statusBg'], ['toastText', 'toastBg'],
      ['accentText', 'accent'],
    ]
    for (const [fg, bg] of pairs) expect(ratio(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    // Where the dark text already reads, it stays.
    expect(colorizationToTokens('#FF0078D7').frameText).toBe('#1E1E1E')
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
