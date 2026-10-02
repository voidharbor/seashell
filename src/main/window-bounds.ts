/**
 * Where the main window comes back.
 *
 * The last normal (unmaximized) bounds are saved to userData on close and
 * read on the next createWindow. Saved bounds are never trusted as they are:
 * they are clamped into the work area of the display they best match, so a
 * monitor that was unplugged, rearranged or sits above the primary (a
 * 1920x1080 display at 760,-1080 above a 3440x1440 primary at 0,0) can never
 * leave the window off screen or in the dead quadrant beside the upper display.
 *
 * `clampToWorkArea` and `parseSavedBounds` are pure and unit tested; the two
 * file helpers are the only side effects and swallow every error, since a
 * missing or broken file only means "use the default size".
 */
import fs from 'node:fs'
import path from 'node:path'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedBounds extends Rect {
  maximized: boolean
}

export const BOUNDS_FILE = 'window-bounds.json'

/**
 * [pure] Fits `bounds` inside `workArea`: shrinks it to the work area if it
 * is larger, then slides it so every edge is inside. Sizes are rounded since
 * Electron wants integers.
 */
export function clampToWorkArea(bounds: Rect, workArea: Rect): Rect {
  const width = Math.round(Math.max(1, Math.min(bounds.width, workArea.width)))
  const height = Math.round(Math.max(1, Math.min(bounds.height, workArea.height)))
  const x = Math.round(
    Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)
  )
  const y = Math.round(
    Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)
  )
  return { x, y, width, height }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** [pure] The saved file's contents, or null when they are not usable bounds. */
export function parseSavedBounds(text: string): SavedBounds | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isNum(r.x) || !isNum(r.y) || !isNum(r.width) || !isNum(r.height)) return null
  if (r.width <= 0 || r.height <= 0) return null
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    maximized: r.maximized === true,
  }
}

/** Reads the saved bounds from `dir`, or null. Never throws. */
export function loadSavedBounds(dir: string): SavedBounds | null {
  try {
    return parseSavedBounds(fs.readFileSync(path.join(dir, BOUNDS_FILE), 'utf8'))
  } catch {
    return null
  }
}

/** Writes the bounds to `dir`. Synchronous because it runs on close. Never throws. */
export function saveBounds(dir: string, bounds: SavedBounds): void {
  try {
    fs.writeFileSync(path.join(dir, BOUNDS_FILE), JSON.stringify(bounds))
  } catch {
    /* a lost position is not worth an error on quit */
  }
}
