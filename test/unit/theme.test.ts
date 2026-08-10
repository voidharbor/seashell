import { describe, expect, it } from 'vitest'
import { ALL_TOKEN_KEYS, readableOn, themeVars, type ThemeChoice } from '../../src/renderer/theme/apply.js'
import {
  CRT,
  PALETTES,
  PANE_STYLES,
  THEMES,
  THEME_ORDER,
  THEME_PANE_STYLE,
} from '../../src/renderer/theme/tokens.js'
import { coerceSettings, DEFAULT_SETTINGS } from '../../src/renderer/settings/settings.js'

const choice = (over: Partial<ThemeChoice> = {}): ThemeChoice => ({
  theme: 'nautical',
  paneStyle: 'theme',
  palette: 'native',
  crt: 'theme',
  accent: null,
  ...over,
})

describe('theme data', () => {
  it('has every theme the picker offers', () => {
    for (const key of THEME_ORDER) expect(THEMES[key], key).toBeDefined()
    expect(THEME_ORDER).toHaveLength(7)
  })

  it('gives every theme the tokens the stylesheet cannot do without', () => {
    // A theme missing one of these paints nothing for a whole surface, and the
    // :root default underneath it would be the previous theme's colour family.
    const required = ['--chrome', '--line', '--text', '--termBg', '--termFg', '--accent', '--paneBg']
    for (const key of THEME_ORDER) {
      for (const token of required) {
        expect(THEMES[key].vars[token], `${key} is missing ${token}`).toBeTruthy()
      }
    }
  })
})

describe('themeVars', () => {
  it('resolves a theme to its own tokens', () => {
    expect(themeVars(choice({ theme: 'homebrew' }))['--termFg']).toBe('#28fe14')
    expect(themeVars(choice({ theme: 'mac' }))['--chrome']).toBe('#f2f2f5')
  })

  it('lets a terminal palette override the theme, and drags the pane with it', () => {
    const v = themeVars(choice({ theme: 'mac', palette: 'amber' }))
    expect(v['--termFg']).toBe(PALETTES.amber['--termFg'])
    // Or the pane paints the theme's terminal colour behind a different one.
    expect(v['--paneBg']).toBe(PALETTES.amber['--termBg'])
  })

  it('uses each theme’s own frame treatment for paneStyle "theme"', () => {
    // Retro is a bezel; asking for the theme default must produce bezel's tokens.
    const v = themeVars(choice({ theme: 'retro', paneStyle: 'theme' }))
    expect(THEME_PANE_STYLE.retro).toBe('bezel')
    expect(v['--paneFramePad']).toBe(PANE_STYLES.bezel.vars['--paneFramePad'])
  })

  it('lets an explicit frame beat the theme default', () => {
    const v = themeVars(choice({ theme: 'retro', paneStyle: 'slab' }))
    expect(v['--paneRadius']).toBe('0px')
    expect(v['--paneShadow']).toBe('none')
  })

  it('turns CRT on for retro by default, and nowhere else', () => {
    expect(themeVars(choice({ theme: 'retro' }))['--scanImg']).toBe(CRT['--scanImg'])
    expect(themeVars(choice({ theme: 'mac' }))['--scanImg']).toBeUndefined()
  })

  it('runs CRT over any theme when asked, which is the point of it being separate', () => {
    const v = themeVars(choice({ theme: 'macDark', crt: 'on' }))
    expect(v['--scanImg']).toBe(CRT['--scanImg'])
    // The glow follows that theme's terminal colour, not retro's phosphor.
    expect(v['--glow']).toContain(THEMES.macDark.vars['--termFg']!)
  })

  it('turns CRT off for retro when asked', () => {
    expect(themeVars(choice({ theme: 'retro', crt: 'off' }))['--scanImg']).toBeUndefined()
  })

  it('applies an accent across every token that carries it', () => {
    const v = themeVars(choice({ accent: '#e5533d' }))
    expect(v['--accent']).toBe('#e5533d')
    expect(v['--select']).toBe('#e5533d')
    expect(v['--primaryBg']).toBe('#e5533d')
    expect(v['--tabOnMark']).toContain('#e5533d')
    // A gradient left over from the theme would sit on top of the flat accent.
    expect(v['--primaryImg']).toBe('none')
  })

  it('keeps the primary button’s label readable whatever the accent', () => {
    // Luminance, not a hand-picked pairing: yellow needs dark text, blue light.
    expect(themeVars(choice({ accent: '#c9a227' }))['--primaryText']).toBe(readableOn('#c9a227'))
    expect(themeVars(choice({ accent: '#0a84ff' }))['--primaryText']).toBe('#ffffff')
    expect(readableOn('#ffffff')).toBe('#141414')
    expect(readableOn('#000000')).toBe('#ffffff')
  })

  it('falls back to a real theme rather than painting nothing', () => {
    const v = themeVars(choice({ theme: 'not-a-theme' as never }))
    expect(v['--chrome']).toBeTruthy()
  })
})

/**
 * The bug the design handoff calls out by name, and the reason applyTheme has a
 * removal pass at all.
 */
describe('switching themes leaves nothing behind', () => {
  it('knows every key any theme, frame, palette or CRT preset can set', () => {
    const every = new Set<string>()
    for (const t of Object.values(THEMES)) Object.keys(t.vars).forEach((k) => every.add(k))
    for (const p of Object.values(PANE_STYLES)) Object.keys(p.vars).forEach((k) => every.add(k))
    for (const p of Object.values(PALETTES)) Object.keys(p).forEach((k) => every.add(k))
    Object.keys(CRT).forEach((k) => every.add(k))

    for (const key of every) {
      expect(ALL_TOKEN_KEYS, `${key} would survive a theme switch`).toContain(key)
    }
  })

  it('covers the exact token the handoff was bitten by', () => {
    // Nautical defines --barShadow; macOS Light does not. Without it in the
    // removal set, switching left a teal hairline across the macOS tab bar.
    expect(THEMES.nautical.vars['--barShadow']).toBeTruthy()
    expect(THEMES.mac.vars['--barShadow']).toBeUndefined()
    expect(ALL_TOKEN_KEYS).toContain('--barShadow')
  })
})

/**
 * The 9px gutter between panes is narrower than any believable pane shadow,
 * so it accumulates BOTH neighbours' shadows at close range. The heavy
 * floating shadow turned every gutter into a dark channel, and the 1px
 * divider line painted chrome down the middle of it — together they read as
 * black lines running between panes that are supposed to sit cleanly on the
 * desk. The line is gone for every theme now (styles.css paints the divider
 * transparent at rest, accent on hover), so no theme may reintroduce one as
 * a token.
 */
describe('panes sit on a clean desk', () => {
  it('lets no theme or frame paint a resting divider line', () => {
    for (const key of THEME_ORDER) {
      expect(
        themeVars(choice({ theme: key }))['--dividerLine'],
        `${key} paints a divider line`
      ).toBeUndefined()
    }
    for (const [name, style] of Object.entries(PANE_STYLES)) {
      expect(style.vars['--dividerLine'], `${name} paints a divider line`).toBeUndefined()
    }
  })

  it('uses a contact shadow tight enough to leave the gutter readable', () => {
    // Measured on macOS Light at 1x: the old 32px/40% shadow pair dropped the
    // #e8e8ec gutter to ~150 grey. A blur under half the gutter width keeps
    // the desk visible between panes while the panes still read as lifted.
    const shadow = PANE_STYLES.floating.vars['--paneShadow']!
    const blurs = [...shadow.matchAll(/\d+px (\d+)px/g)].map((m) => Number(m[1]))
    expect(blurs.length).toBeGreaterThan(0)
    for (const blur of blurs) expect(blur).toBeLessThanOrEqual(8)
  })
})

/**
 * Appearance settings are enums, and coerceSettings used to copy booleans and
 * nothing else. Without widening it, every theme would silently reset to the
 * default on the next launch.
 */
describe('appearance settings survive a round trip', () => {
  it('keeps a stored theme, palette, frame and accent', () => {
    const stored = {
      ...DEFAULT_SETTINGS,
      theme: 'hacker',
      palette: 'amber',
      paneStyle: 'slab',
      crt: 'on',
      accent: '#0a84ff',
    }
    expect(coerceSettings(stored)).toMatchObject({
      theme: 'hacker',
      palette: 'amber',
      paneStyle: 'slab',
      crt: 'on',
      accent: '#0a84ff',
    })
  })

  it('refuses a value that is not one of the known keys', () => {
    const out = coerceSettings({ theme: 'evil', palette: 'nope', accent: '#ff0000', crt: 'maybe' })
    expect(out.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(out.palette).toBe(DEFAULT_SETTINGS.palette)
    expect(out.crt).toBe(DEFAULT_SETTINGS.crt)
    // An arbitrary hex is not in the fixed palette, so it is not adopted.
    expect(out.accent).toBeNull()
  })

  it('still handles the boolean settings it always did', () => {
    expect(coerceSettings({ attentionSound: true }).attentionSound).toBe(true)
    expect(coerceSettings({ attentionGlow: false }).attentionGlow).toBe(false)
  })

  it('accepts a null accent, which means the theme’s own', () => {
    expect(coerceSettings({ ...DEFAULT_SETTINGS, accent: null }).accent).toBeNull()
  })
})
