/**
 * UI zoom — one control that scales the terminal text and the chrome together.
 *
 * Terminal font size cannot be scaled by an arbitrary factor. The WebGL
 * renderer computes `device.char.width = Math.floor(charWidth * dpr)`, so any
 * font size whose scaled advance lands mid-pixel accumulates rounding error
 * across a row and shows up as visible cell drift and misaligned box-drawing
 * borders. See the note on FONT_SIZE in palette.ts.
 *
 * So the ladder is not a curve — it is the enumerated set of sizes that are
 * actually clean for SF Mono Terminal (advance 0.61816 em) at DPR 2:
 *
 *   px  residual  |  px  residual  |  px  residual
 *    9  0.127     |  16  0.781     |  25  0.908
 *   12  0.836     |  17  0.017 *   |  26  0.144
 *   13  0.072 *   |  21  0.963 *   |  29  0.853
 *                 |  22  0.199     |  30  0.090 *
 *
 * (* = residual within 0.10 of an integer boundary.) Sizes between these are
 * deliberately unreachable; 14px — the size Terminal.app is actually set to —
 * is excluded precisely because its 0.308 residual is what made it unusable.
 *
 * The chrome scales on a gentler curve than the text. Matching the font ladder
 * exactly would make the tab bar and status bar enormous at the top of the
 * range, where the point is to read terminal output, not chrome.
 */

export interface ZoomLevel {
  /** Terminal font size in px. Always one of the residual-clean values. */
  font: number
  /** Multiplier applied to every chrome dimension via the --ui-scale variable. */
  ui: number
}

export const ZOOM_LEVELS: readonly ZoomLevel[] = [
  { font: 9, ui: 0.85 },
  { font: 12, ui: 0.95 },
  { font: 13, ui: 1.0 },
  { font: 16, ui: 1.1 },
  { font: 17, ui: 1.18 },
  { font: 21, ui: 1.32 },
  { font: 25, ui: 1.48 },
  { font: 30, ui: 1.65 },
]

/** Index of `{ font: 13, ui: 1.0 }` — the shipped default, and where ⌘0 returns. */
export const DEFAULT_ZOOM_INDEX = 2

const STORAGE_KEY = 'seashell.zoomIndex'

/**
 * Clamps rather than wraps. Wrapping at the ends would send a user who holds
 * ⌘− from the smallest size straight to the largest.
 */
export function clampIndex(i: number): number {
  if (!Number.isFinite(i)) return DEFAULT_ZOOM_INDEX
  return Math.max(0, Math.min(ZOOM_LEVELS.length - 1, Math.round(i)))
}

export function levelAt(index: number): ZoomLevel {
  return ZOOM_LEVELS[clampIndex(index)] ?? ZOOM_LEVELS[DEFAULT_ZOOM_INDEX]!
}

/**
 * Reads the persisted level. A corrupt or out-of-range stored value falls back
 * to the default instead of throwing — a bad localStorage entry must never be
 * able to stop the app from starting.
 */
export function loadZoomIndex(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_ZOOM_INDEX
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? DEFAULT_ZOOM_INDEX : clampIndex(n)
  } catch {
    return DEFAULT_ZOOM_INDEX
  }
}

export function saveZoomIndex(index: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampIndex(index)))
  } catch {
    /* private mode or quota — zoom still applies for this session */
  }
}

/** Publishes the chrome multiplier that every dimension in styles.css derives from. */
export function applyUiScale(index: number): void {
  document.documentElement.style.setProperty('--ui-scale', String(levelAt(index).ui))
}
