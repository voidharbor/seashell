import { describe, expect, it } from 'vitest'
import {
  PANE_COLORS,
  isPaneColorKey,
  nextAutoColor,
  paneColorHex,
} from '../../src/renderer/panes/colors.js'

describe('pane colour palette', () => {
  it('has unique keys and unique hexes', () => {
    expect(new Set(PANE_COLORS.map((c) => c.key)).size).toBe(PANE_COLORS.length)
    expect(new Set(PANE_COLORS.map((c) => c.hex)).size).toBe(PANE_COLORS.length)
  })

  it('uses well-formed 6-digit hex', () => {
    for (const c of PANE_COLORS) {
      expect(c.hex, c.key).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  /**
   * A tag colour has to be visible against the chrome it sits on (#0a0f0a) or
   * the feature does nothing. This is the same class of mistake as the close
   * buttons, which shipped in a colour that was technically present and
   * practically invisible.
   */
  it('is bright enough to read against the pane chrome', () => {
    const luminance = (hex: string): number => {
      const v = (i: number): number => {
        const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * v(0) + 0.7152 * v(1) + 0.0722 * v(2)
    }
    // Contrast against the chrome background, which is very near black.
    const bg = luminance('#0A0F0A')
    for (const c of PANE_COLORS) {
      const ratio = (luminance(c.hex) + 0.05) / (bg + 0.05)
      expect(ratio, `${c.key} contrast ${ratio.toFixed(2)}`).toBeGreaterThan(3)
    }
  })

  it('does not reuse the terminal foreground green, which would read as text recolouring', () => {
    expect(PANE_COLORS.map((c) => c.hex.toUpperCase())).not.toContain('#28FE14')
  })
})

describe('paneColorHex', () => {
  it('resolves a known key', () => {
    expect(paneColorHex('blue')).toBe('#5A8DEE')
  })

  it('treats untagged and unknown alike, so a stale key degrades to no tag', () => {
    expect(paneColorHex(undefined)).toBeNull()
    expect(paneColorHex('')).toBeNull()
    expect(paneColorHex('chartreuse')).toBeNull()
  })
})

describe('isPaneColorKey', () => {
  it('accepts only palette keys', () => {
    expect(isPaneColorKey('red')).toBe(true)
    expect(isPaneColorKey('mauve')).toBe(false)
    expect(isPaneColorKey(null)).toBe(false)
    expect(isPaneColorKey(7)).toBe(false)
  })
})

describe('nextAutoColor', () => {
  it('starts at the first colour when nothing is taken', () => {
    expect(nextAutoColor([])).toBe(PANE_COLORS[0]!.key)
  })

  it('never repeats a colour already on screen', () => {
    const taken: string[] = []
    for (let i = 0; i < PANE_COLORS.length; i += 1) {
      const next = nextAutoColor(taken)
      expect(taken).not.toContain(next)
      taken.push(next)
    }
    expect(taken.length).toBe(PANE_COLORS.length)
  })

  it('skips over gaps rather than counting positions', () => {
    // Second colour freed: it should be reused before moving further along.
    const taken = [PANE_COLORS[0]!.key, PANE_COLORS[2]!.key]
    expect(nextAutoColor(taken)).toBe(PANE_COLORS[1]!.key)
  })

  it('ignores untagged panes and unknown keys', () => {
    expect(nextAutoColor([undefined, 'chartreuse', undefined])).toBe(PANE_COLORS[0]!.key)
  })

  /**
   * A tab caps at six panes and the palette has seven, so exhaustion is only
   * reachable if the cap changes. It still must not return something invalid.
   */
  it('wraps to the oldest colour once every one is taken', () => {
    const all = PANE_COLORS.map((c) => c.key)
    expect(nextAutoColor(all)).toBe(all[0])
  })
})
