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
  /** Name panes from the title the running program sets, e.g. an agent's
   *  session summary, instead of the working directory. */
  autoTitlePanes: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  attentionGlow: true,
  autoTitlePanes: true,
}

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
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v === 'boolean') out[key] = v
  }
  return out
}

export function saveSettings(settings: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* private mode or quota — settings still apply for this session */
  }
}
