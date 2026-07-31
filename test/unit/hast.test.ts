import { describe, expect, it } from 'vitest'
import { parseStyle } from '../../src/renderer/viewer/hast.js'

/**
 * The viewer renders untrusted file contents under a CSP with no unsafe-inline.
 * parseStyle is the only place a highlighter-supplied string becomes applied
 * CSS, so it is the boundary worth testing hardest.
 */
describe('parseStyle', () => {
  it('maps the token properties a theme legitimately uses', () => {
    expect(parseStyle('color:#79C0FF')).toEqual({ color: '#79C0FF' })
    expect(parseStyle('font-style:italic;font-weight:bold')).toEqual({
      fontStyle: 'italic',
      fontWeight: 'bold',
    })
  })

  it('drops properties outside the allowlist', () => {
    expect(parseStyle('position:fixed;color:#fff')).toEqual({ color: '#fff' })
    expect(parseStyle('top:0;left:0;z-index:9999')).toBeUndefined()
    expect(parseStyle('behavior:url(#x)')).toBeUndefined()
  })

  it('rejects values that could reference or inject anything', () => {
    expect(parseStyle('background-color:url(http://evil/x)')).toBeUndefined()
    expect(parseStyle('color:expression(alert(1))')).toBeUndefined()
    expect(parseStyle('color:<script>')).toBeUndefined()
  })

  it('returns undefined rather than an empty object for nothing usable', () => {
    expect(parseStyle('')).toBeUndefined()
    expect(parseStyle('garbage')).toBeUndefined()
    expect(parseStyle(undefined)).toBeUndefined()
    expect(parseStyle(42)).toBeUndefined()
    expect(parseStyle('color:')).toBeUndefined()
  })

  it('ignores an absurdly long declaration outright', () => {
    expect(parseStyle('color:' + '#aabbcc'.repeat(200))).toBeUndefined()
  })

  it('keeps the good declarations when mixed with rejected ones', () => {
    expect(parseStyle('color:#fff;position:absolute;font-weight:600')).toEqual({
      color: '#fff',
      fontWeight: '600',
    })
  })
})
