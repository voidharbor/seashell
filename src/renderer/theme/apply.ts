/**
 * Resolving a theme choice into CSS custom properties, and putting them on an
 * element.
 *
 * The whole theming system is a token swap: every surface, border, radius,
 * font and shadow in the renderer already reads from a variable, so nothing
 * else has to be theme-aware. `themeVars` is pure and does the resolving;
 * `applyTheme` is the only part that touches the DOM.
 */

import {
  CRT,
  PALETTES,
  PANE_STYLES,
  THEME_PANE_STYLE,
  THEMES,
  type CrtKey,
  type PaletteKey,
  type PaneStyleKey,
  type ThemeKey,
} from './tokens.js'

export interface ThemeChoice {
  theme: ThemeKey
  paneStyle: PaneStyleKey
  palette: PaletteKey
  crt: CrtKey
  /** A key from ACCENTS, or null for the theme's own accent. */
  accent: string | null
}

/**
 * Every key any theme, pane frame, palette or CRT preset can set.
 *
 * Computed rather than listed so it cannot fall behind the data, and load
 * bearing: see applyTheme.
 */
export const ALL_TOKEN_KEYS: readonly string[] = (() => {
  const all = new Set<string>(Object.keys(CRT))
  for (const t of Object.values(THEMES)) Object.keys(t.vars).forEach((k) => all.add(k))
  for (const p of Object.values(PANE_STYLES)) Object.keys(p.vars).forEach((k) => all.add(k))
  for (const p of Object.values(PALETTES)) Object.keys(p).forEach((k) => all.add(k))
  // Set by the accent override alone; no theme lists them.
  for (const k of ['--primaryImg', '--onAccent', '--primaryText', '--tabOnMark']) all.add(k)
  return [...all]
})()

/**
 * White or near-black, whichever stays readable on the given colour.
 *
 * Relative luminance rather than a hand-picked pairing, so the primary
 * button's label can never go unreadable when the accent changes.
 */
export function readableOn(hex: string): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n)) return '#ffffff'
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return l > 0.6 ? '#141414' : '#ffffff'
}

/** The resolved token map for a choice. Pure. */
export function themeVars(choice: ThemeChoice): Record<string, string> {
  const theme = THEMES[choice.theme] ? choice.theme : 'nautical'
  const vars: Record<string, string> = { ...THEMES[theme].vars }

  if (choice.palette !== 'native' && PALETTES[choice.palette]) {
    Object.assign(vars, PALETTES[choice.palette])
    // The pane background follows the terminal, or a palette leaves the pane
    // painting the theme's terminal colour behind a different one.
    vars['--paneBg'] = PALETTES[choice.palette]['--termBg']!
  }

  const psKey = choice.paneStyle === 'theme' ? THEME_PANE_STYLE[theme] : choice.paneStyle
  const paneStyle = PANE_STYLES[psKey as Exclude<PaneStyleKey, 'theme'>]
  if (paneStyle) Object.assign(vars, paneStyle.vars)

  if (choice.crt === 'on' || (choice.crt === 'theme' && theme === 'retro')) {
    Object.assign(vars, CRT)
    vars['--glow'] = `0 0 6px ${vars['--termFg'] ?? '#5cf07a'}80`
  }

  if (choice.accent) {
    const onAccent = readableOn(choice.accent)
    vars['--accent'] = choice.accent
    vars['--select'] = choice.accent
    vars['--primaryBg'] = choice.accent
    vars['--primaryBorder'] = choice.accent
    vars['--primaryImg'] = 'none'
    vars['--tabOnMark'] = `inset 0 -2px 0 ${choice.accent}`
    vars['--onAccent'] = onAccent
    vars['--primaryText'] = onAccent
  }

  return vars
}

/**
 * Write a choice onto an element, clearing whatever the previous one left.
 *
 * The removal pass is not tidiness. Themes define different subsets of the
 * token set, and an applier that only *sets* the incoming theme's keys leaves
 * the outgoing theme's extras painting: Nautical defines
 * `--barShadow: inset 0 1px 0 #2e4b4d` and macOS Light does not define it at
 * all, so switching between them left a dark teal hairline across the macOS
 * tab bar. Removing the union first is what makes a switch a switch.
 */
export function applyTheme(el: HTMLElement, choice: ThemeChoice): void {
  const vars = themeVars(choice)
  for (const key of ALL_TOKEN_KEYS) {
    if (!(key in vars)) el.style.removeProperty(key)
  }
  for (const [key, value] of Object.entries(vars)) {
    el.style.setProperty(key, value)
  }
}
