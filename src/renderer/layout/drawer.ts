/**
 * Shell drawer height — user-set, persisted, clamped.
 *
 * Third of the family after sidebar.ts and rail.ts, with the one geometric
 * difference that the drawer is anchored to the BOTTOM of the grid: dragging
 * its top edge up makes it taller, so the drag math measures from the drawer's
 * bottom edge upward rather than from a top edge down. Same zoom rule as the
 * other two — the value is stored as a base height in CSS px at zoom 1, never
 * the rendered height, so the zoom level never gets baked into the preference.
 */

const STORAGE_KEY = 'seashell.drawerHeight'

/** Enough rows to actually work in — roughly a 15-line terminal — without
 *  burying the panes the window exists for. */
export const DRAWER_DEFAULT = 300

/** Below this the drawer is a peephole: a prompt plus two lines of output,
 *  which is worse than not opening it. */
export const DRAWER_MIN = 120

/** The panes must stay the point of the window; past this the drawer should
 *  scroll like any terminal rather than grow. */
export const DRAWER_MAX = 800

export function clampDrawer(height: number): number {
  if (!Number.isFinite(height)) return DRAWER_DEFAULT
  return Math.round(Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, height)))
}

export function loadDrawerHeight(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DRAWER_DEFAULT
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? DRAWER_DEFAULT : clampDrawer(n)
  } catch {
    return DRAWER_DEFAULT
  }
}

export function saveDrawerHeight(height: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampDrawer(height)))
  } catch {
    /* private mode or quota — the height still applies for this session */
  }
}

/**
 * Converts a drag position into a stored base height.
 *
 * `drawerBottom` is where the drawer's bottom edge sits (the grid's bottom),
 * so the rendered height is the distance from the pointer up to it. Measured
 * rather than assumed, same as the rail's top — the status bar below the grid
 * must never be hardcoded into the math.
 */
export function drawerHeightFromDrag(
  pointerY: number,
  drawerBottom: number,
  uiScale: number
): number {
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1
  return clampDrawer((drawerBottom - pointerY) / scale)
}
