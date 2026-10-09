/**
 * The chrome's token table from the desktop colorization (redesign spec 6.2).
 * The keys are the shell's `Tokens` (native/shell/src/ui/tokens.h). Colors are
 * `#RRGGBB`; `glassTint` is `#AARRGGBB`.
 *
 * `#881798` (and anything missing or malformed) is the spec 6.2 and 6.3 table
 * itself. Any other colorization goes through the derivation below, whose
 * weights reproduce that table for `#881798` to within a few levels per channel:
 * the Win7 balances 8 / afterglow 43 / blur 49 put `frame` at 43 percent of the
 * colorization over the Win7 base grey `#D9D9D9`; the tinted surfaces are the
 * colorization at a small weight over a light grey; the Win7 control faces of
 * 6.3 (tabs, status bar, cards) stay as they are; text is `#1E1E1E` or white,
 * whichever reads better on its background, or pure black or white where
 * neither reaches the WCAG 4.5 contrast ratio (a mid-grey frame).
 *
 * The other themes (themeTokens) fill the same keys: Aero Dark from fixed
 * dark surfaces under the colorization's accent, and ports of the Electron
 * themes' colours.
 */
import type { NativeThemeKey } from '../../renderer/settings/settings.js'
import { THEMES } from '../../renderer/theme/tokens.js'

const TOKEN_KEYS = [
  'frame', 'frameText', 'tabActive', 'tabInactive', 'tabText', 'body', 'panel', 'panelBorder', 'titleBar', 'titleText',
  'badge', 'badgeText', 'divider', 'statusBg', 'statusText', 'toastBg', 'toastText', 'accent', 'accentText', 'danger',
  'selection', 'glassTint',
] as const

/**
 * The faces the 6.3 controls used to paint as literals (menus, edit boxes,
 * scrollbars, buttons, cards, the dark strip's tab edges): one key each, so a
 * theme reaches every surface. Aero's values are those literals.
 */
const FACE_KEYS = [
  'tabSheen', 'tabEdge', 'stripBadgeText', 'hoverFace', 'titleSheen', 'statusSheen', 'statusSep', 'warn', 'dangerText',
  'shadow', 'cardBorder', 'tipBg', 'tipBorder', 'tipText',
  'menuBg', 'menuBorder', 'menuHi', 'menuHiBorder', 'menuSep', 'menuSepShine', 'menuText', 'menuGray',
  'editBg', 'editText', 'editBorder', 'editFocus', 'editPlaceholder', 'editMissBg', 'editMissBorder',
  'checkTop', 'checkBottom', 'checkBorder', 'dotTrack',
  'scrollTrack', 'scrollLine', 'scrollArrow', 'scrollArrowHot', 'scrollThumbTop', 'scrollThumbBottom', 'scrollThumbBorder',
  'scrollThumbHot', 'scrollThumbHotBorder', 'scrollGrip', 'scrollGripHot', 'scrollGripShine',
  'btn0', 'btn1', 'btn2', 'btn3', 'btnBorder', 'btnHover0', 'btnHover1', 'btnHover2', 'btnHover3', 'btnHoverBorder',
  'btnPress0', 'btnPress1', 'btnPress2', 'btnPress3', 'btnPressBorder', 'btnDisabled', 'btnDisabledBorder', 'btnShine',
  'btnText', 'btnDisabledText',
] as const

/** Every color key of the shell's `Tokens`, in tokens.h's order. */
export const ALL_TOKEN_KEYS: readonly string[] = [...TOKEN_KEYS, ...FACE_KEYS]

type FaceTable = { [K in (typeof FACE_KEYS)[number]]: string }

/** Every color key of the shell's `Tokens`. */
export type TokenTable = { [K in (typeof TOKEN_KEYS)[number]]: string } & FaceTable

const DEFAULT_RGB = 0x881798

/**
 * The 6.3 faces as Aero paints them, for every colorization: the literals the
 * shell drew before they were tokens, so Aero is unchanged pixel for pixel.
 * Same values as tokens.h.
 */
const AERO_FACES: Readonly<FaceTable> = Object.freeze({
  tabSheen: '#FFFFFF', // win7Tab's sheen over the inactive face
  tabEdge: '#8E8F8F', // 6.3 tabs: the 1 px border
  stripBadgeText: '#D0D0D0', // the zoom badge's text on the dark strip
  hoverFace: '#FFFFFF', // the link toggle's and refresh's hover face
  titleSheen: '#FFFFFF', // mixed over titleBar for the focused pane's title gradient
  statusSheen: '#FFFFFF', // mixed over statusBg for the status bar's top stop and its hint
  statusSep: '#C0C0C0', // the status bar's separators
  warn: '#A86400', // styles.css --warn #e5a83c, darkened to read on the light bar
  dangerText: '#CC4C45', // danger at 80 percent over black, the exit and find miss text
  shadow: '#000000', // drop shadows and the modal dims
  cardBorder: '#A0A0A0', // 6.3 cards and dialogs, the status bar's and banner's top line
  tipBg: '#FFFFFF',
  tipBorder: '#767676',
  tipText: '#575757',
  menuBg: '#F0F0F0', // 6.3 menu face
  menuBorder: '#979797',
  menuHi: '#DCEBFC',
  menuHiBorder: '#7DA2CE',
  menuSep: '#E0E0E0',
  menuSepShine: '#FFFFFF', // the light line under each separator
  menuText: '#1E1E1E', // Win7 menu text
  menuGray: '#6D6D6D', // GrayText
  editBg: '#FFFFFF', // the Win7 text box
  editText: '#1E1E1E',
  editBorder: '#ABADB3',
  editFocus: '#3C7FB1',
  editPlaceholder: '#6D6D6D',
  editMissBg: '#FFD9D9', // the find query with no match
  editMissBorder: '#E04040',
  checkTop: '#DCDCDC', // 6.3 check box face
  checkBottom: '#FFFFFF',
  checkBorder: '#8E8F8F',
  dotTrack: '#E6E6E6', // the tutorial's step dots mix toastText into this
  scrollTrack: '#F0F0F0', // 6.3 scrollbar
  scrollLine: '#E3E3E3',
  scrollArrow: '#4D4D4D',
  scrollArrowHot: '#1C4E7C',
  scrollThumbTop: '#F0F0F0',
  scrollThumbBottom: '#E3E3E3',
  scrollThumbBorder: '#A0A0A0',
  scrollThumbHot: '#DCEBFC',
  scrollThumbHotBorder: '#7DA2CE',
  scrollGrip: '#8A8A8A',
  scrollGripHot: '#5B7FA6',
  scrollGripShine: '#FFFFFF',
  btn0: '#F2F2F2', // 6.3 button: top, upper middle, lower middle, bottom
  btn1: '#EBEBEB',
  btn2: '#DDDDDD',
  btn3: '#CFCFCF',
  btnBorder: '#707070',
  btnHover0: '#EAF6FD',
  btnHover1: '#D9F0FC',
  btnHover2: '#BEE6FD',
  btnHover3: '#A7D9F5',
  btnHoverBorder: '#3C7FB1',
  btnPress0: '#E5F4FC',
  btnPress1: '#C4E5F6',
  btnPress2: '#98D1EF',
  btnPress3: '#68B3DB',
  btnPressBorder: '#2C628B',
  btnDisabled: '#F4F4F4',
  btnDisabledBorder: '#ADB2B5',
  btnShine: '#FFFFFF', // the inner highlight
  btnText: '#1E1E1E',
  btnDisabledText: '#838383',
})

/** Spec 6.2 for `#881798`, with the 6.3 Win7 faces. Same values as tokens.h. */
const SPEC_62: Readonly<Omit<TokenTable, keyof FaceTable>> = Object.freeze({
  frame: '#B685BD', // #881798 at 43 percent over #D9D9D9
  frameText: '#1D0F22', // --text
  tabActive: '#FFFFFF', // 6.3 tabs: active face #ffffff to #f3f3f3
  tabInactive: '#DCDCDC', // 6.3 tabs: inactive face #f2f2f2 to #dcdcdc
  tabText: '#1D0F22', // --text
  body: '#ECE2F0', // --chrome
  panel: '#FAF5FC', // --cardBg
  panelBorder: '#8F5FA0', // --paneBorder
  titleBar: '#EAD9F0', // --paneTitleBg
  titleText: '#1D0F22', // --text
  badge: '#E1D3E8', // --chromeAlt
  badgeText: '#5A3F66', // --dim
  divider: '#B48FC0', // --line
  statusBg: '#ECECEC', // 6.3 status bar: #f7f7f7 to #ececec
  statusText: '#1D0F22', // --text
  toastBg: '#F0F0F0', // 6.3 cards and dialogs: #f0f0f0 face
  toastText: '#1D0F22', // --cardText
  accent: '#881798', // --accent
  accentText: '#FFFFFF', // --onAccent
  danger: '#FF5F56', // styles.css --danger (6.2 does not retune it)
  selection: '#3399FF', // --select, the Windows 7 selection blue
  glassTint: '#38881798', // --barBg rgba(136, 23, 152, .22)
})

const SPEC_TABLE: Readonly<TokenTable> = Object.freeze({ ...SPEC_62, ...AERO_FACES })

/**
 * The dark tab strip (plan amendment 10/03 05:40): these keys replace the
 * table's own when the strip is dark. Only the strip's tokens are here; the
 * body, panels, cards, badges and accent below it keep their light values
 * (the zoom badge on the dark strip takes the strip's colours in tabs.cpp).
 * `glassTint` is black at 55 percent, the wash the shell paints on glass.
 */
const DARK_STRIP: Readonly<Partial<TokenTable>> = Object.freeze({
  frame: '#1F1F1F',
  frameText: '#F0F0F0',
  tabActive: '#2B2B2B',
  tabInactive: '#1A1A1A',
  tabText: '#F0F0F0',
  tabSheen: '#3A3A3A',
  tabEdge: '#0A0A0A',
  glassTint: '#8C000000',
})

/**
 * The token table plus three non-colour keys: `stripDark` is `'1'` when the
 * strip is dark (the black wash, no glyph glow), `radius` the panes' and
 * cards' corner in DIP and `glyphGlow` the strip glyphs' white glow on
 * glass, an alpha from 0 to 1.
 */
export type ChromeTokens = TokenTable & { stripDark: '0' | '1'; radius: string; glyphGlow: string }

/** The glyph glow on light glass: 0.85 read as too bright a white behind the strip's glyphs. */
const GLYPH_GLOW = '0.5'

const DARK_TEXT = 0x1e1e1e
const LIGHT_TEXT = 0xffffff
const BLACK_TEXT = 0x000000
const MIN_CONTRAST = 4.5 // WCAG 2.x AA for text
const GLASS_ALPHA = 0x38 // --barBg's .22

/** `#RRGGBB` or `#AARRGGBB` to `0xRRGGBB`; null for anything else. */
function parseRgb(argb: unknown): number | null {
  if (typeof argb !== 'string') return null
  const m = /^#(?:[0-9a-fA-F]{2})?([0-9a-fA-F]{6})$/.exec(argb.trim())
  return m ? parseInt(m[1]!, 16) : null
}

/** True when `argb` is a color colorizationToTokens derives from (not the missing or malformed fallback). */
export function isColorization(argb: unknown): boolean {
  return parseRgb(argb) !== null
}

const ch = (rgb: number, shift: number): number => (rgb >> shift) & 0xff

/** `rgb` at weight `w` over the grey `g` (0..255), floored like tokens.h's frame. */
function over(rgb: number, w: number, g: number): number {
  const mix = (v: number): number => Math.max(0, Math.min(255, Math.floor(v * w + g * (1 - w))))
  return (mix(ch(rgb, 16)) << 16) | (mix(ch(rgb, 8)) << 8) | mix(ch(rgb, 0))
}

/** WCAG relative luminance. */
function luminance(rgb: number): number {
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(ch(rgb, 16)) + 0.7152 * lin(ch(rgb, 8)) + 0.0722 * lin(ch(rgb, 0))
}

/** The WCAG contrast ratio of two colours. */
function contrast(a: number, b: number): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * Whichever of the dark text and white has the higher contrast on `bg`. On a
 * mid-tone where neither reaches WCAG 4.5 (a black colorization's `#7B7B7B`
 * frame: 3.94 and 4.23), pure black or white, whichever reads better; one of
 * those two always reaches at least 4.58.
 */
function textOn(bg: number): number {
  const dark = contrast(bg, DARK_TEXT)
  const light = contrast(bg, LIGHT_TEXT)
  if (Math.max(dark, light) >= MIN_CONTRAST) return dark >= light ? DARK_TEXT : LIGHT_TEXT
  return contrast(bg, BLACK_TEXT) >= light ? BLACK_TEXT : LIGHT_TEXT
}

const hex6 = (rgb: number): string => `#${(rgb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`
const hex8 = (a: number, rgb: number): string => `#${a.toString(16).padStart(2, '0').toUpperCase()}${hex6(rgb).slice(1)}`

function derive(c: number): TokenTable {
  const frame = over(c, 0.43, 0xd9)
  const tabActive = 0xffffff
  const tabInactive = 0xdcdcdc
  const titleBar = over(c, 0.16, 0xff)
  const badge = over(c, 0.15, 0xf4)
  const statusBg = 0xececec
  const toastBg = 0xf0f0f0
  return {
    frame: hex6(frame),
    frameText: hex6(textOn(frame)),
    tabActive: hex6(tabActive),
    tabInactive: hex6(tabInactive),
    tabText: hex6(textOn(tabInactive)),
    body: hex6(over(c, 0.1, 0xf8)),
    panel: hex6(over(c, 0.04, 0xff)),
    panelBorder: hex6(over(c, 0.47, 0x9e)),
    titleBar: hex6(titleBar),
    titleText: hex6(textOn(titleBar)),
    badge: hex6(badge),
    badgeText: hex6(over(c, 0.28, 0x4e)),
    divider: hex6(over(c, 0.36, 0xd2)),
    statusBg: hex6(statusBg),
    statusText: hex6(textOn(statusBg)),
    toastBg: hex6(toastBg),
    toastText: hex6(textOn(toastBg)),
    accent: hex6(c),
    accentText: hex6(textOn(c)),
    danger: SPEC_TABLE.danger,
    selection: SPEC_TABLE.selection,
    glassTint: hex8(GLASS_ALPHA, c),
    ...AERO_FACES,
  }
}

/**
 * The token table for a desktop colorization (`#AARRGGBB`, the registry's
 * `ColorizationColor` as the shell reads it, or `#RRGGBB`). Never throws.
 *
 * `opaque` is DWM's opaque-blend flag. It is taken but changes nothing: DWM
 * reports it set on Windows 10 and 11 while OpenGlass still draws glass (read
 * on the live desktop), so the strip's glass or opaque paint follows the
 * shell's composition flag instead.
 *
 * `darkStrip` swaps in the dark strip keys (`DARK_STRIP`) and sets
 * `stripDark` to `'1'`; everything below the strip is the same table.
 */
export function colorizationToTokens(argb: string | null | undefined, opaque?: boolean, darkStrip?: boolean): ChromeTokens {
  void opaque
  let table: TokenTable
  try {
    const rgb = parseRgb(argb)
    table = rgb === null || rgb === DEFAULT_RGB ? { ...SPEC_TABLE } : derive(rgb)
  } catch {
    table = { ...SPEC_TABLE }
  }
  return darkStrip === true
    ? { ...table, ...DARK_STRIP, stripDark: '1', radius: '6', glyphGlow: '0' }
    : { ...table, stripDark: '0', radius: '6', glyphGlow: GLYPH_GLOW }
}

// ---------------------------------------------------------------------------
// The other themes
// ---------------------------------------------------------------------------

/** The chrome themes the native shell paints; Settings' `system` resolves to one of the first two. */
export type ChromeTheme = Exclude<NativeThemeKey, 'system'>

/** `system` follows the Windows app theme (`AppsUseLightTheme`, the shell's `appsDark`). */
export function resolveTheme(key: NativeThemeKey, appsDark: boolean): ChromeTheme {
  return key === 'system' ? (appsDark ? 'aeroDark' : 'aero') : key
}

/** `a` at weight `w` over `b`, both `#RRGGBB`, rounded like painter.cpp's mixRgb. */
function mixHex(a: string, b: string, w: number): string {
  const x = parseInt(a.slice(1), 16)
  const y = parseInt(b.slice(1), 16)
  const m = (sh: number): number => Math.round(ch(x, sh) * w + ch(y, sh) * (1 - w)) << sh
  return hex6(m(16) | m(8) | m(0))
}

/**
 * Aero Dark: the Aero glass strip (the dark strip's values) over Windows 11's
 * dark surfaces, #202020 and #2B2B2B with #F0F0F0 text and #A0A0A0 for the
 * quiet text, hairlines around #3A3A3A. Gradients stay gradients, darker. The
 * accent is the colorization's, filled in by themeTokens.
 */
const AERO_DARK: Readonly<Omit<TokenTable, 'accent' | 'accentText'>> = Object.freeze({
  frame: '#1F1F1F',
  frameText: '#F0F0F0',
  tabActive: '#2B2B2B',
  tabInactive: '#1A1A1A',
  tabText: '#F0F0F0',
  body: '#202020',
  panel: '#1C1C1C',
  panelBorder: '#4A4A4A',
  titleBar: '#2B2B2B',
  titleText: '#F0F0F0',
  badge: '#333333',
  badgeText: '#A0A0A0',
  divider: '#3A3A3A',
  statusBg: '#1C1C1C',
  statusText: '#F0F0F0',
  toastBg: '#2B2B2B',
  toastText: '#F0F0F0',
  danger: SPEC_62.danger,
  selection: SPEC_62.selection,
  glassTint: '#8C000000',
  tabSheen: '#3A3A3A',
  tabEdge: '#0A0A0A',
  stripBadgeText: '#D0D0D0',
  hoverFace: '#454545',
  titleSheen: '#3A3A3A',
  statusSheen: '#2B2B2B',
  statusSep: '#3A3A3A',
  warn: '#E5A83C',
  dangerText: '#FF7B72',
  shadow: '#000000',
  cardBorder: '#454545',
  tipBg: '#2B2B2B',
  tipBorder: '#555555',
  tipText: '#D0D0D0',
  menuBg: '#2C2C2C',
  menuBorder: '#454545',
  menuHi: '#383838',
  menuHiBorder: '#4F4F4F',
  menuSep: '#3A3A3A',
  menuSepShine: '#232323',
  menuText: '#F0F0F0',
  menuGray: '#9A9A9A',
  editBg: '#1C1C1C',
  editText: '#F0F0F0',
  editBorder: '#5A5A5A',
  editFocus: '#4CA0E0',
  editPlaceholder: '#9A9A9A',
  editMissBg: '#4A2020',
  editMissBorder: '#E04040',
  checkTop: '#1A1A1A',
  checkBottom: '#2B2B2B',
  checkBorder: '#6A6A6A',
  dotTrack: '#3A3A3A',
  scrollTrack: '#202020',
  scrollLine: '#2B2B2B',
  scrollArrow: '#A0A0A0',
  scrollArrowHot: '#F0F0F0',
  scrollThumbTop: '#4D4D4D',
  scrollThumbBottom: '#424242',
  scrollThumbBorder: '#5A5A5A',
  scrollThumbHot: '#5A5A5A',
  scrollThumbHotBorder: '#707070',
  scrollGrip: '#8A8A8A',
  scrollGripHot: '#C0C0C0',
  scrollGripShine: '#2A2A2A',
  btn0: '#3C3C3C',
  btn1: '#363636',
  btn2: '#2E2E2E',
  btn3: '#292929',
  btnBorder: '#555555',
  btnHover0: '#454A50',
  btnHover1: '#3E4349',
  btnHover2: '#353A40',
  btnHover3: '#30353B',
  btnHoverBorder: '#4CA0E0',
  btnPress0: '#262A2E',
  btnPress1: '#2A2F34',
  btnPress2: '#30363C',
  btnPress3: '#353C43',
  btnPressBorder: '#3C7FB1',
  btnDisabled: '#2A2A2A',
  btnDisabledBorder: '#3A3A3A',
  btnShine: '#4A4A4A',
  btnText: '#F0F0F0',
  btnDisabledText: '#7A7A7A',
})

/** The Electron themes the native shell ports (Retro CRT is its textures, so it stays behind). */
type PortedTheme = Exclude<ChromeTheme, 'aero' | 'aeroDark'>

/** `#rgb` or `#rrggbb` to `#RRGGBB`. */
const full = (hex: string): string => {
  const h = hex.replace('#', '')
  return `#${(h.length === 3 ? h.split('').map((c) => c + c).join('') : h).toUpperCase()}`
}

/**
 * An Electron theme's CSS variables (src/renderer/theme/tokens.ts) as the
 * shell's tokens, colours and radius only: the chrome from --barBg, --chrome
 * and --chromeAlt, panes from --paneBorder and --paneTitleBg (--paneTitleOn
 * for the focused one), the sidebar from --sideBg, cards and menus from
 * --cardBg, buttons from --btnBg, edit boxes from --sunken. The 6.3 control
 * gradients are built from those faces. `fix` replaces what misses WCAG 4.5.
 */
function port(key: PortedTheme, fix: Partial<TokenTable> = {}): Readonly<ChromeTokens> {
  const v = (name: string): string => full(THEMES[key].vars[`--${name}`]!)
  const dark = luminance(parseInt(v('chrome').slice(1), 16)) < 0.2
  const white = '#FFFFFF'
  const black = '#000000'
  const btn = v('btnBg')
  const hover = mixHex(v('select'), btn, dark ? 0.22 : 0.14)
  const press = mixHex(v('select'), btn, dark ? 0.36 : 0.26)
  // Light faces shade toward black at the bottom; dark ones lift toward white at the top.
  const grad = (base: string): [string, string, string, string] =>
    dark
      ? [mixHex(white, base, 0.08), mixHex(white, base, 0.04), base, mixHex(black, base, 0.1)]
      : [mixHex(white, base, 0.5), mixHex(white, base, 0.25), base, mixHex(black, base, 0.06)]
  const [b0, b1, b2, b3] = grad(btn)
  const [h0, h1, h2, h3] = grad(hover)
  const [p3, p2, p1, p0] = grad(press) // pressed: the gradient upside down
  const t: TokenTable = {
    frame: v('barBg'),
    frameText: v('text'),
    tabActive: v('tabOnBg'),
    tabInactive: v('chromeAlt'),
    tabText: v('text'),
    body: v('chrome'),
    panel: v('sideBg'),
    panelBorder: v('paneBorder'),
    titleBar: v('paneTitleBg'),
    titleText: v('text'),
    badge: v('chromeAlt'),
    badgeText: v('dim'),
    divider: v('line'),
    statusBg: v('chromeAlt'),
    statusText: v('text'),
    toastBg: v('cardBg'),
    toastText: v('cardText'),
    accent: v('accent'),
    accentText: v('onAccent'),
    danger: SPEC_62.danger,
    selection: v('select'),
    // On glass a dark theme washes the strip with its own chrome at 55 percent, a light one at 10.
    glassTint: dark ? `#8C${v('chrome').slice(1)}` : `#38${v('barBg').slice(1)}`,
    tabSheen: dark ? v('line') : white,
    tabEdge: dark ? mixHex(black, v('chromeAlt'), 0.5) : v('paneBorder'),
    stripBadgeText: dark ? v('text') : AERO_FACES.stripBadgeText,
    hoverFace: dark ? btn : white,
    titleSheen: v('paneTitleOn'),
    statusSheen: dark ? v('line') : white,
    statusSep: v('line'),
    warn: dark ? '#E5A83C' : '#8A5200',
    dangerText: dark ? '#FF7B72' : '#C0392B',
    shadow: black,
    cardBorder: v('cardBorder'),
    tipBg: v('cardBg'),
    tipBorder: v('cardBorder'),
    tipText: v('cardText'),
    menuBg: v('cardBg'),
    menuBorder: v('cardBorder'),
    menuHi: mixHex(v('select'), v('cardBg'), 0.25),
    menuHiBorder: mixHex(v('select'), v('cardBg'), 0.6),
    menuSep: v('line'),
    menuSepShine: dark ? mixHex(black, v('cardBg'), 0.25) : white,
    menuText: v('cardText'),
    menuGray: v('cardDim'),
    editBg: v('sunken'),
    editText: v('text'),
    editBorder: v('btnBorder'),
    editFocus: v('accent'),
    editPlaceholder: v('faint'),
    editMissBg: mixHex('#E04040', v('sunken'), 0.25),
    editMissBorder: '#E04040',
    checkTop: mixHex(v('line'), v('sunken'), 0.5),
    checkBottom: v('sunken'),
    checkBorder: v('btnBorder'),
    dotTrack: v('line'),
    scrollTrack: v('sideBg'),
    scrollLine: v('line'),
    scrollArrow: v('dim'),
    scrollArrowHot: v('text'),
    scrollThumbTop: b1,
    scrollThumbBottom: b3,
    scrollThumbBorder: v('btnBorder'),
    scrollThumbHot: h2,
    scrollThumbHotBorder: mixHex(v('select'), v('btnBorder'), 0.6),
    scrollGrip: v('faint'),
    scrollGripHot: v('text'),
    scrollGripShine: dark ? black : white,
    btn0: b0,
    btn1: b1,
    btn2: b2,
    btn3: b3,
    btnBorder: v('btnBorder'),
    btnHover0: h0,
    btnHover1: h1,
    btnHover2: h2,
    btnHover3: h3,
    btnHoverBorder: mixHex(v('select'), v('btnBorder'), 0.6),
    btnPress0: p0,
    btnPress1: p1,
    btnPress2: p2,
    btnPress3: p3,
    btnPressBorder: v('select'),
    btnDisabled: mixHex(btn, v('cardBg'), 0.5),
    btnDisabledBorder: mixHex(v('btnBorder'), v('cardBg'), 0.5),
    btnShine: dark ? mixHex(white, btn, 0.12) : white,
    btnText: v('btnText'),
    btnDisabledText: v('faint'),
    ...fix,
  }
  const radius = String(parseFloat(THEMES[key].vars['--paneRadius'] ?? '6'))
  return Object.freeze({ ...t, stripDark: dark ? '1' : '0', radius, glyphGlow: dark ? '0' : GLYPH_GLOW })
}

/** The ported themes, built once. Each `fix` lifts a text colour the theme's own palette leaves under WCAG 4.5. */
const PORTED: Readonly<Record<PortedTheme, Readonly<ChromeTokens>>> = Object.freeze({
  // #0A84FF under white reads 3.65: Apple's darker #0071E3 for the fills; the secondary greys one step darker.
  mac: port('mac', { accent: '#0071E3', badgeText: '#636366', menuGray: '#6E6E73', editPlaceholder: '#6E6E73' }),
  macDark: port('macDark', { accent: '#0071E3', editPlaceholder: '#98989D' }),
  nautical: port('nautical'),
  hacker: port('hacker', { menuGray: '#4EE87A', editPlaceholder: '#4EE87A' }),
  homebrew: port('homebrew', { menuGray: '#6EA865' }),
})

/**
 * The chrome's tokens for a theme. Aero is colorizationToTokens (the strip
 * dark or not by the Tab strip setting); Aero Dark takes the colorization's
 * accent over its fixed dark table; the ported themes are their own, the
 * accent included. The Settings accent goes on top afterwards (withAccent).
 */
export function themeTokens(theme: ChromeTheme, argb: string | null | undefined, darkStrip?: boolean): ChromeTokens {
  if (theme === 'aero') return colorizationToTokens(argb, false, darkStrip)
  if (theme === 'aeroDark') {
    const aero = colorizationToTokens(argb)
    return { ...AERO_DARK, accent: aero.accent, accentText: aero.accentText, stripDark: '1', radius: '6', glyphGlow: '0' }
  }
  return { ...PORTED[theme] }
}

/**
 * The text colour on an accent: copied from `src/renderer/theme/apply.ts:54-61`
 * (`readableOn`), which cannot be imported here because apply.ts touches
 * `document`. The renderer's dark text `#141414` is the token table's own
 * dark text, `#1D0F22`, so the onAccent colour matches the rest of the table.
 */
export function readableOn(hex: string): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n)) return '#FFFFFF'
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return l > 0.6 ? SPEC_TABLE.frameText : '#FFFFFF'
}

/**
 * The Settings accent over a token table (`apply.ts:84-94`: `--accent`,
 * `--select`, `--primaryBg`, `--primaryBorder` and the tab mark take the
 * chosen hex, `--onAccent` the readable text). Here that is `accent` (which
 * the shell's tab mark, pane border and default button read), `selection` and
 * `accentText`. A null accent leaves the table's own.
 */
export function withAccent<T extends Record<string, string>>(table: T, accent: string | null): T {
  if (accent === null || !/^#[0-9a-fA-F]{6}$/.test(accent)) return table
  return { ...table, accent, selection: accent, accentText: readableOn(accent) }
}
