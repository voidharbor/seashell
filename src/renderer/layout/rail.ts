/**
 * Lookout rail height — user-set, persisted, clamped.
 *
 * The mirror of sidebar.ts, one axis over: the rail sits above the file
 * explorer in the same column, and dragging the divider between them trades
 * height from one to the other. Same reasoning as the sidebar's width applies
 * here — the value is stored as a base height in CSS px at zoom 1, never the
 * rendered pixel height, so the zoom level never gets baked into the
 * preference.
 *
 * Stored as a NUMBER OF CARDS' worth of room rather than a fraction of the
 * window, because that is what the user is actually choosing: how many waiting
 * panes they can see at once without scrolling.
 */

const STORAGE_KEY = 'seashell.railHeight'

/** Roughly two cards. Enough to see a second pane waiting behind the first,
 *  without the explorer starting the session already squashed. */
export const RAIL_DEFAULT = 260

/** Below this a single card is clipped mid-question, which is worse than
 *  scrolling — you cannot tell what you are being asked. */
export const RAIL_MIN = 120

/** The explorer must keep enough height to be a file tree rather than a
 *  peephole; past this the rail should scroll instead of growing. */
export const RAIL_MAX = 900

export function clampRail(height: number): number {
  if (!Number.isFinite(height)) return RAIL_DEFAULT
  return Math.round(Math.max(RAIL_MIN, Math.min(RAIL_MAX, height)))
}

export function loadRailHeight(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return RAIL_DEFAULT
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? RAIL_DEFAULT : clampRail(n)
  } catch {
    return RAIL_DEFAULT
  }
}

export function saveRailHeight(height: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampRail(height)))
  } catch {
    /* private mode or quota — the height still applies for this session */
  }
}

/**
 * Converts a drag position into a stored base height.
 *
 * `pointerY` is the pointer's distance from the window's top edge; `railTop` is
 * where the rail actually starts (below the tab bar), so the rail's rendered
 * height is the difference. Passing railTop in rather than assuming zero is
 * what keeps this honest when the chrome above it changes size.
 */
export function heightFromDrag(pointerY: number, railTop: number, uiScale: number): number {
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1
  return clampRail((pointerY - railTop) / scale)
}
