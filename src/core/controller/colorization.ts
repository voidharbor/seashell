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
 * whichever reads better on its background.
 */

const TOKEN_KEYS = [
  'frame', 'frameText', 'tabActive', 'tabInactive', 'tabText', 'body', 'panel', 'panelBorder', 'titleBar', 'titleText',
  'badge', 'badgeText', 'divider', 'statusBg', 'statusText', 'toastBg', 'toastText', 'accent', 'accentText', 'danger',
  'selection', 'glassTint',
] as const

/** Every color key of the shell's `Tokens`. */
export type TokenTable = { [K in (typeof TOKEN_KEYS)[number]]: string }

const DEFAULT_RGB = 0x881798

/** Spec 6.2 for `#881798`, with the 6.3 Win7 faces. Same values as tokens.h. */
const SPEC_TABLE: Readonly<TokenTable> = Object.freeze({
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

/**
 * The dark tab strip (plan amendment 10/03 05:40): these keys replace the
 * table's own when the strip is dark. Only the strip's tokens are here; the
 * body, panels, cards and accent below it keep their light values.
 * `glassTint` is black at 55 percent, the wash the shell paints on glass.
 */
const DARK_STRIP: Readonly<Partial<TokenTable>> = Object.freeze({
  frame: '#1F1F1F',
  frameText: '#F0F0F0',
  tabActive: '#2B2B2B',
  tabInactive: '#1A1A1A',
  tabText: '#F0F0F0',
  badge: '#3A3A3A',
  badgeText: '#D0D0D0',
  glassTint: '#8C000000',
})

/** The token table plus `stripDark`, a non-colour key: `'1'` when the strip is dark, `'0'` otherwise. */
export type ChromeTokens = TokenTable & { stripDark: '0' | '1' }

const DARK_TEXT = 0x1e1e1e
const LIGHT_TEXT = 0xffffff
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

/** Whichever of the dark text and white has the higher contrast on `bg`. */
function textOn(bg: number): number {
  const l = luminance(bg)
  const dark = (l + 0.05) / (luminance(DARK_TEXT) + 0.05)
  const light = (luminance(LIGHT_TEXT) + 0.05) / (l + 0.05)
  return dark >= light ? DARK_TEXT : LIGHT_TEXT
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
  return darkStrip === true ? { ...table, ...DARK_STRIP, stripDark: '1' } : { ...table, stripDark: '0' }
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
