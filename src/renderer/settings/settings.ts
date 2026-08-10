import {
  ACCENTS,
  PALETTE_ORDER,
  PANE_STYLE_ORDER,
  THEME_ORDER,
  type CrtKey,
  type PaletteKey,
  type PaneStyleKey,
  type ThemeKey,
} from '../theme/tokens.js'

/**
 * User preferences.
 *
 * Deliberately small. Every entry here is something with a real reason to
 * differ between people — not a knob for its own sake. A setting nobody changes
 * is a setting that has to be kept working forever for no benefit, and the
 * project's stated non-goals already rule out a config system.
 *
 * Stored in localStorage rather than the main-process state file: these are
 * renderer-only display choices, they are tiny, and they must be readable
 * before first paint without waiting on IPC.
 */

export interface Settings {
  /** Pulse a pane's border when it is waiting for input or has just finished. */
  attentionGlow: boolean
  /**
   * Play a short ping when a pane starts asking for attention.
   *
   * Subordinate to `attentionGlow`, which the tab bar's moon toggles: asleep
   * means silent as well as still. A sound that kept firing after you had
   * explicitly asked for quiet would be worse than no sound at all.
   */
  attentionSound: boolean
  /** Name panes from the title the running program sets, e.g. an agent's
   *  session summary, instead of the working directory. */
  autoTitlePanes: boolean
  /** Give every new pane a colour tag automatically, preferring one the tab is
   *  not already using. Renaming or recolouring by hand always wins. */
  autoColorPanes: boolean
  /** Raise approval cards when an agent pane stops on a question. */
  lookoutCards: boolean

  // --- Appearance. All keys, never literal colours, so a future palette
  // revision re-resolves instead of stranding a stored hex. ---

  theme: ThemeKey
  /** `theme` defers to each theme's own frame treatment. */
  paneStyle: PaneStyleKey
  /** `native` is the theme's own terminal colours. Also reaches xterm. */
  palette: PaletteKey
  /** `theme` means on for Retro CRT only. */
  crt: CrtKey
  /** A key from ACCENTS, or null for the theme's own accent. */
  accent: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  attentionGlow: true,
  attentionSound: false,
  autoTitlePanes: true,
  autoColorPanes: true,
  lookoutCards: true,
  theme: 'nautical',
  paneStyle: 'theme',
  palette: 'native',
  crt: 'theme',
  accent: null,
}

/** Allowed values per enum setting, so nothing out of localStorage can paint. */
const ENUMS = {
  theme: THEME_ORDER,
  paneStyle: PANE_STYLE_ORDER,
  palette: PALETTE_ORDER,
  crt: ['theme', 'on', 'off'] as const,
} satisfies Record<string, readonly string[]>

const ACCENT_KEYS: readonly string[] = ACCENTS.map((a) => a.key)

const STORAGE_KEY = 'seashell.settings'

/**
 * Merges over the defaults rather than trusting the stored object, so a value
 * written by an older build (or a hand-edited one) cannot leave a setting
 * missing or the wrong type.
 */
export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { ...DEFAULT_SETTINGS }
    return coerceSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function coerceSettings(value: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS }
  if (typeof value !== 'object' || value === null) return out
  const raw = value as Record<string, unknown>

  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const v = raw[key]
    if (typeof v === 'boolean' && typeof DEFAULT_SETTINGS[key] === 'boolean') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(out as any)[key] = v
    }
  }

  /**
   * The appearance settings are enums, and this function used to copy booleans
   * and nothing else — so adding them without widening it here would have made
   * every theme silently reset to the default on the next launch, which reads
   * as "the theme picker does not save".
   *
   * Each value is checked against the list it must come from rather than
   * trusted: this is parsed out of localStorage, which anything on the machine
   * can write, and an unknown key would resolve to no theme at all.
   */
  for (const [key, allowed] of Object.entries(ENUMS)) {
    const v = raw[key]
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(out as any)[key] = v
    }
  }

  // Accent is nullable, and only ever one of the fixed keys.
  const accent = raw['accent']
  if (accent === null) out.accent = null
  else if (typeof accent === 'string' && ACCENT_KEYS.includes(accent)) out.accent = accent

  return out
}

export function saveSettings(settings: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* private mode or quota — settings still apply for this session */
  }
}
