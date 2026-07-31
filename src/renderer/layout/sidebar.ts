/**
 * File explorer width — user-set, persisted, clamped.
 *
 * Stored as a base width in CSS px at zoom 1, never as the rendered pixel
 * width. The sidebar is drawn as `base * --ui-scale`, so storing the rendered
 * value would bake the zoom level into the preference: set the width at 150%
 * zoom, return at 100%, and the explorer would be two thirds the size you left
 * it. Dividing the drag back out by the current scale keeps the two settings
 * independent.
 */

const STORAGE_KEY = 'seashell.sidebarWidth'

export const SIDEBAR_DEFAULT = 260

/** Narrower than this and filenames are ellipsised to uselessness. */
export const SIDEBAR_MIN = 170

/** Wider than this and the explorer starts crowding out the panes, which are
 *  the point of the window. */
export const SIDEBAR_MAX = 620

export function clampSidebar(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width)))
}

export function loadSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return SIDEBAR_DEFAULT
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? SIDEBAR_DEFAULT : clampSidebar(n)
  } catch {
    return SIDEBAR_DEFAULT
  }
}

export function saveSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampSidebar(width)))
  } catch {
    /* private mode or quota — the width still applies for this session */
  }
}

/**
 * Converts a drag position into a stored base width.
 *
 * `pointerX` is the pointer's distance from the window's left edge, which for a
 * sidebar pinned to that edge is the rendered width directly.
 */
export function widthFromDrag(pointerX: number, uiScale: number): number {
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1
  return clampSidebar(pointerX / scale)
}
