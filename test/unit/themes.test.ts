import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_TOKEN_KEYS, colorizationToTokens, resolveTheme, themeTokens, type ChromeTheme, type ChromeTokens } from '../../src/core/controller/colorization.js'
import { Controller } from '../../src/core/controller/controller.js'
import { coerceUiState } from '../../src/core/controller/ui-state.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const THEMES: readonly ChromeTheme[] = ['aero', 'aeroDark', 'graphite', 'mac', 'macDark', 'nautical', 'hacker', 'homebrew']

const lum = (hex: string): number => {
  const n = Number.parseInt(hex.slice(-6), 16)
  const lin = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

/**
 * Each text token and the surface it is painted on: scripts/native-colors.mjs's
 * pairs, then the faces that became tokens (menus, edit boxes, buttons, the
 * tooltip, the status bar's warning, the dark strip's zoom badge).
 */
const PAIRS: Array<[string, string]> = [
  ['frameText', 'frame'], ['tabText', 'tabActive'], ['tabText', 'tabInactive'], ['titleText', 'titleBar'],
  ['titleText', 'panel'], ['titleText', 'body'], ['badgeText', 'badge'], ['badgeText', 'titleBar'],
  ['badgeText', 'panel'], ['badgeText', 'toastBg'], ['statusText', 'statusBg'], ['toastText', 'toastBg'],
  ['accentText', 'accent'],
  ['titleText', 'titleSheen'], ['statusText', 'statusSheen'], ['warn', 'statusBg'], ['dangerText', 'toastBg'],
  ['tipText', 'tipBg'], ['menuText', 'menuBg'], ['menuText', 'menuHi'], ['menuGray', 'menuBg'], ['badgeText', 'menuBg'],
  ['editText', 'editBg'], ['editText', 'editMissBg'], ['editPlaceholder', 'editBg'], ['editText', 'checkTop'], ['editText', 'checkBottom'],
  ...(['btn0', 'btn1', 'btn2', 'btn3', 'btnHover0', 'btnHover1', 'btnHover2', 'btnHover3', 'btnPress0', 'btnPress1', 'btnPress2', 'btnPress3'].map(
    (b) => ['btnText', b] as [string, string],
  )),
]
/** Pairs that depend on the strip: the zoom badge and the tab rename box. */
const stripPairs = (t: ChromeTokens): Array<[string, string]> =>
  t.stripDark === '1' ? [['stripBadgeText', 'tabSheen'], ['toastText', 'editBg']] : [['tabText', 'editBg']]
/** Aero is frozen at 784beb5: its warning amber and danger text read 3.96 and 3.93 and stay that way. */
const AERO_AS_SHIPPED = new Set(['warn/statusBg', 'dangerText/toastBg'])

describe('the chrome themes', () => {
  it('define every token key in tokens.h format', () => {
    for (const theme of THEMES) {
      for (const dark of [false, true]) {
        const t = themeTokens(theme, '#C8881798', dark) as unknown as Record<string, string>
        for (const k of ALL_TOKEN_KEYS) {
          expect(t[k], `${theme}.${k}`).toMatch(k === 'glassTint' ? /^#[0-9A-F]{8}$/ : /^#[0-9A-F]{6}$/)
        }
        expect(t.stripDark).toMatch(/^[01]$/)
        expect(Number(t.radius)).toBeGreaterThanOrEqual(0)
        expect(Number(t.radius)).toBeLessThanOrEqual(24)
        expect(Number(t.glyphGlow)).toBeGreaterThanOrEqual(0)
        expect(Number(t.glyphGlow)).toBeLessThanOrEqual(1)
      }
    }
  })
  it('keep every text colour at WCAG 4.5 on its surface', () => {
    for (const theme of THEMES) {
      for (const [argb, dark] of [['#C8881798', false], ['#C8881798', true], ['#FF0078D7', false], ['#FF000000', true]] as const) {
        const t = themeTokens(theme, argb, dark) as unknown as Record<string, string> & ChromeTokens
        for (const [fg, bg] of [...PAIRS, ...stripPairs(t)]) {
          if (theme === 'aero' && AERO_AS_SHIPPED.has(`${fg}/${bg}`)) continue
          expect(ratio(t[fg]!, t[bg]!), `${theme} ${argb} ${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})

/** SPEC_TABLE at 784beb5, before the faces became tokens. */
const SPEC_784 = {
  frame: '#B685BD', frameText: '#1D0F22', tabActive: '#FFFFFF', tabInactive: '#DCDCDC', tabText: '#1D0F22', body: '#ECE2F0',
  panel: '#FAF5FC', panelBorder: '#8F5FA0', titleBar: '#EAD9F0', titleText: '#1D0F22', badge: '#E1D3E8', badgeText: '#5A3F66',
  divider: '#B48FC0', statusBg: '#ECECEC', statusText: '#1D0F22', toastBg: '#F0F0F0', toastText: '#1D0F22', accent: '#881798',
  accentText: '#FFFFFF', danger: '#FF5F56', selection: '#3399FF', glassTint: '#38881798',
}
/** colorizationToTokens('#FF0078D7') at 784beb5. */
const BLUE_784 = {
  frame: '#7BAFD8',
  frameText: '#1E1E1E',
  tabActive: '#FFFFFF',
  tabInactive: '#DCDCDC',
  tabText: '#1E1E1E',
  body: '#DFEBF4',
  panel: '#F4F9FD',
  panelBorder: '#538CB8',
  titleBar: '#D6E9F8',
  titleText: '#1E1E1E',
  badge: '#CFE1EF',
  badgeText: '#385974',
  divider: '#86B1D3',
  statusBg: '#ECECEC',
  statusText: '#1E1E1E',
  toastBg: '#F0F0F0',
  toastText: '#1E1E1E',
  accent: '#0078D7',
  accentText: '#000000',
  danger: '#FF5F56',
  selection: '#3399FF',
  glassTint: '#380078D7',
}
/** The literals the shell painted at 784beb5, which tokens.h now holds as these keys' defaults. */
const AERO_LITERALS = {
  tabSheen: '#FFFFFF', tabEdge: '#8E8F8F', stripBadgeText: '#D0D0D0', hoverFace: '#FFFFFF', titleSheen: '#FFFFFF',
  statusSheen: '#FFFFFF', statusSep: '#C0C0C0', warn: '#A86400', dangerText: '#CC4C45', shadow: '#000000', cardBorder: '#A0A0A0',
  tipBg: '#FFFFFF', tipBorder: '#767676', tipText: '#575757', menuBg: '#F0F0F0', menuBorder: '#979797', menuHi: '#DCEBFC',
  menuHiBorder: '#7DA2CE', menuSep: '#E0E0E0', menuSepShine: '#FFFFFF', menuText: '#1E1E1E', menuGray: '#6D6D6D',
  editBg: '#FFFFFF', editText: '#1E1E1E', editBorder: '#ABADB3', editFocus: '#3C7FB1', editPlaceholder: '#6D6D6D',
  editMissBg: '#FFD9D9', editMissBorder: '#E04040', checkTop: '#DCDCDC', checkBottom: '#FFFFFF', checkBorder: '#8E8F8F',
  dotTrack: '#E6E6E6', scrollTrack: '#F0F0F0', scrollLine: '#E3E3E3', scrollArrow: '#4D4D4D', scrollArrowHot: '#1C4E7C',
  scrollThumbTop: '#F0F0F0', scrollThumbBottom: '#E3E3E3', scrollThumbBorder: '#A0A0A0', scrollThumbHot: '#DCEBFC',
  scrollThumbHotBorder: '#7DA2CE', scrollGrip: '#8A8A8A', scrollGripHot: '#5B7FA6', scrollGripShine: '#FFFFFF',
  btn0: '#F2F2F2', btn1: '#EBEBEB', btn2: '#DDDDDD', btn3: '#CFCFCF', btnBorder: '#707070',
  btnHover0: '#EAF6FD', btnHover1: '#D9F0FC', btnHover2: '#BEE6FD', btnHover3: '#A7D9F5', btnHoverBorder: '#3C7FB1',
  btnPress0: '#E5F4FC', btnPress1: '#C4E5F6', btnPress2: '#98D1EF', btnPress3: '#68B3DB', btnPressBorder: '#2C628B',
  btnDisabled: '#F4F4F4', btnDisabledBorder: '#ADB2B5', btnShine: '#FFFFFF', btnText: '#1E1E1E', btnDisabledText: '#838383',
}

describe('Aero', () => {
  it('is the 784beb5 table, with the literals as the new keys and the softer glyph glow', () => {
    expect(themeTokens('aero', null)).toEqual({ ...SPEC_784, ...AERO_LITERALS, stripDark: '0', radius: '6', glyphGlow: '0.65' })
    expect(themeTokens('aero', '#C8881798')).toEqual(themeTokens('aero', null))
    expect(colorizationToTokens(null)).toEqual(themeTokens('aero', null))
  })
  it('derives a non-default colorization exactly as 784beb5 did', () => {
    expect(themeTokens('aero', '#FF0078D7')).toEqual({ ...BLUE_784, ...AERO_LITERALS, stripDark: '0', radius: '6', glyphGlow: '0.65' })
  })
  it('darkens only the strip under the dark tab strip, and drops the glow there', () => {
    const light = themeTokens('aero', '#FF0078D7')
    const dark = themeTokens('aero', '#FF0078D7', true)
    expect(dark).toMatchObject({ tabSheen: '#3A3A3A', tabEdge: '#0A0A0A', glassTint: '#8C000000', stripDark: '1', glyphGlow: '0' })
    for (const k of ['body', 'panel', 'menuBg', 'editBg', 'btn0', 'toastBg', 'scrollTrack', 'accent'] as const) expect(dark[k]).toBe(light[k])
  })
})

describe('Aero Dark and the ported themes', () => {
  it('Aero Dark is dark top to bottom and takes the colorization accent', () => {
    const t = themeTokens('aeroDark', '#FF0078D7')
    expect(t).toMatchObject({ frame: '#1F1F1F', tabActive: '#2B2B2B', glassTint: '#8C000000', stripDark: '1', glyphGlow: '0' })
    expect(t.accent).toBe('#0078D7')
    expect(themeTokens('aeroDark', null).accent).toBe('#881798')
    for (const k of ['body', 'panel', 'titleBar', 'toastBg', 'statusBg', 'menuBg', 'editBg', 'tipBg', 'scrollTrack', 'btn2', 'checkBottom'] as const) {
      expect(lum(t[k]), k).toBeLessThan(0.05)
    }
  })
  it('the ported themes keep their Electron colours and radius', () => {
    expect(themeTokens('nautical', '#FF0078D7')).toMatchObject({ body: '#0D1A1C', accent: '#D0A63A', panelBorder: '#22393B', radius: '5', stripDark: '1' })
    expect(themeTokens('hacker', null)).toMatchObject({ accent: '#00FF41', radius: '0', glassTint: '#8C050505' })
    expect(themeTokens('homebrew', null)).toMatchObject({ accent: '#28FE14', radius: '4' })
    expect(themeTokens('macDark', null)).toMatchObject({ body: '#2A2A2C', radius: '10', stripDark: '1', glyphGlow: '0' })
    expect(themeTokens('mac', null)).toMatchObject({ body: '#F2F2F5', radius: '10', stripDark: '0', glyphGlow: '0.65' })
    // The colorization does not reach a ported theme.
    expect(themeTokens('mac', '#FF0078D7')).toEqual(themeTokens('mac', null))
  })
  it('Graphite is flat dark grey, its own accent, no glass and no colorization', () => {
    const t = themeTokens('graphite', '#FF881798')
    expect(t).toMatchObject({ frame: '#1C1D20', tabActive: '#26272B', body: '#111214', accent: '#2563EB', stripDark: '1', glyphGlow: '0', flatFrame: '1' })
    expect(themeTokens('graphite', '#FF0078D7')).toEqual(t)
    for (const k of ['frame', 'body', 'panel', 'titleBar', 'toastBg', 'statusBg', 'menuBg', 'editBg', 'tipBg', 'scrollTrack', 'btn2', 'checkBottom'] as const) {
      expect(lum(t[k]), k).toBeLessThan(0.05)
    }
    // Nothing in the table carries the plum.
    for (const v of Object.values(t)) expect(v).not.toMatch(/881798/i)
    expect(themeTokens('aeroDark', null).flatFrame).toBeUndefined()
  })
  it('System resolves by the Windows app theme', () => {
    expect(resolveTheme('system', false)).toBe('aero')
    expect(resolveTheme('system', true)).toBe('aeroDark')
    expect(resolveTheme('mac', true)).toBe('mac')
  })
})

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, target: string) => c.event({ type: 'click', target, x: 0, y: 0, button: 0, mods })

describe('the theme setting', () => {
  it('a saved Electron theme with no native theme stays Aero', async () => {
    for (const theme of ['nautical', 'macDark', 'hacker', 'retro', 'homebrew']) {
      expect(coerceUiState({ settings: { theme } }).settings.nativeTheme).toBe('aero')
    }
    expect(coerceUiState({ settings: { theme: 'nautical', nativeTheme: 'macDark' } }).settings.nativeTheme).toBe('macDark')
    expect(coerceUiState({ settings: { nativeTheme: 'purple' } }).settings.nativeTheme).toBe('aero')
    // Through the controller's boot: the ui-state file holds the Electron default.
    const f = fakeDeps()
    const { userData } = f.handlers['app:getPaths']!(undefined) as { userData: string }
    writeFileSync(join(userData, 'ui-state.json'), JSON.stringify({ tutorialSeen: true, settings: { theme: 'nautical', tabStrip: 'dark' } }))
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.push('shell:colorization', { argb: '#FF881798', opaque: false, composition: true, appsDark: false })
    expect(c.uiState().settings.tabStrip).toBe('dark') // the file was read
    expect(c.uiState().settings.nativeTheme).toBe('aero')
    expect(c.model().tokens).toEqual({ ...themeTokens('aero', '#FF881798', true), composition: '1' })
  })
  it('System flips live with appsDark, and a pinned theme does not', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.settings')
    click(c, 'sheet:settings:theme:system')
    expect(c.uiState().settings.nativeTheme).toBe('system')
    c.push('shell:colorization', { argb: '#FF0078D7', opaque: false, composition: true, appsDark: false })
    expect(c.model().tokens.body).toBe(themeTokens('aero', '#FF0078D7').body)
    c.push('shell:colorization', { argb: '#FF0078D7', opaque: false, composition: true, appsDark: true })
    expect(c.model().tokens).toMatchObject({ body: '#202020', accent: '#0078D7', stripDark: '1', composition: '1' })
    c.push('shell:colorization', { argb: '#FF0078D7', opaque: false, composition: true, appsDark: false })
    expect(c.model().tokens.stripDark).toBe('0')
    click(c, 'sheet:settings:theme:aeroDark')
    expect(c.model().tokens.body).toBe('#202020')
    click(c, 'sheet:settings:accent:0a84ff')
    expect(c.model().tokens.accent).toBe('#0a84ff') // the Settings accent still wins
    click(c, 'sheet:settings:theme:nautical')
    expect(c.model().tokens).toMatchObject({ body: '#0D1A1C', accent: '#0a84ff' })
    click(c, 'sheet:settings:accent:default')
    expect(c.model().tokens.accent).toBe('#D0A63A')
    expect(c.uiState().settings.nativeTheme).toBe('nautical')
  })
  it('Graphite turns the glass off even with DWM composition on', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.settings')
    click(c, 'sheet:settings:theme:graphite')
    expect(c.uiState().settings.nativeTheme).toBe('graphite')
    expect(c.model().tokens).toMatchObject({ flatFrame: '1', composition: '0' })
    c.push('shell:colorization', { argb: '#FF881798', opaque: false, composition: true, appsDark: false })
    expect(c.model().tokens).toMatchObject({ frame: '#1C1D20', flatFrame: '1', composition: '0' })
    click(c, 'sheet:settings:theme:aero')
    expect(c.model().tokens.composition).toBe('1')
    expect(c.model().tokens.flatFrame).toBeUndefined()
  })
})

describe('tokens.h', () => {
  const h = readFileSync(join(__dirname, '../../native/shell/src/ui/tokens.h'), 'utf8')
  it('declares and parses every key, its default the Aero value', () => {
    const decl = new Map<string, string>()
    for (const line of h.split('\n')) {
      const m = /^\s*uint32_t\s+([^;]+);/.exec(line)
      if (!m) continue
      for (const part of m[1]!.split(',')) {
        const [name, value] = part.split('=').map((x) => x.trim())
        decl.set(name!, value!)
      }
    }
    const aero = themeTokens('aero', null) as unknown as Record<string, string>
    for (const k of ALL_TOKEN_KEYS) {
      const want = `0x${aero[k]!.slice(1)}`
      expect(decl.get(k), `tokens.h ${k}`).toBe(want)
      expect(h, `fromModel ${k}`).toContain(`rgb("${k}", t.${k})`)
    }
    expect(decl.size).toBe(ALL_TOKEN_KEYS.length)
    expect(h).toMatch(/float glyphGlow = 0\.65f;/)
    expect(h).toContain('tokens.find("glyphGlow")')
  })
})
