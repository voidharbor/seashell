/**
 * The active tab's tree plus the shell's geometry, turned into the rects the
 * shell draws. The math is the renderer's own (`src/renderer/layout/*`),
 * imported in place so both front ends tile panes identically.
 */
import { computeLayout } from '../../renderer/layout/resize.js'
import { deriveDividers, type DividerSpec } from '../../renderer/layout/dividers.js'
import { TITLEBAR_PX, type CellSize, type PixelSize, type RowNode } from '../../renderer/layout/types.js'
import type { DividerModel, Rect } from './model.js'

export interface LaidOut {
  rects: Map<string, Rect>
  gridRects: Map<string, Rect>
  dividers: DividerModel[]
  /** The renderer's specs, area-relative, which a divider drag needs back. */
  specs: Map<string, DividerSpec>
  cols: Map<string, number>
  rows: Map<string, number>
}

/**
 * `cell` sizes the layout minimums (the window's font); `paneCell` gives one
 * pane's own cell when its text zoom differs, so its cols and rows match what
 * its grid can actually show.
 */
export function layOut(
  tree: RowNode,
  area: Rect,
  cell: CellSize,
  uiScale: number,
  paneCell: (paneId: string) => CellSize = () => cell
): LaidOut {
  const avail: PixelSize = { width: area.w, height: area.h }
  const out: LaidOut = { rects: new Map(), gridRects: new Map(), dividers: [], specs: new Map(), cols: new Map(), rows: new Map() }
  if (tree.children.length === 0 || area.w <= 0 || area.h <= 0) return out
  const rects = computeLayout(tree, avail, cell)
  const title = TITLEBAR_PX * uiScale
  for (const r of rects) {
    const rect = { x: area.x + r.x, y: area.y + r.y, w: r.width, h: r.height }
    out.rects.set(r.paneId, rect)
    setGrid(out, r.paneId, rect, title, paneCell(r.paneId))
  }
  for (const d of deriveDividers(tree, rects, avail)) {
    out.specs.set(d.id, d)
    out.dividers.push({
      id: d.id,
      orientation: d.orientation === 'v' ? 'vertical' : 'horizontal',
      rect: { x: area.x + d.x, y: area.y + d.y, w: d.width, h: d.height },
    })
  }
  return out
}

/** A full-screen (zoomed) pane fills the whole area and has no dividers. */
export function layOutZoomed(paneId: string, area: Rect, uiScale: number, cell: CellSize): LaidOut {
  const out: LaidOut = { rects: new Map(), gridRects: new Map(), dividers: [], specs: new Map(), cols: new Map(), rows: new Map() }
  const rect = { ...area }
  out.rects.set(paneId, rect)
  setGrid(out, paneId, rect, TITLEBAR_PX * uiScale, cell)
  return out
}

function setGrid(out: LaidOut, paneId: string, rect: Rect, title: number, cell: CellSize): void {
  const grid = { x: rect.x, y: rect.y + title, w: rect.w, h: Math.max(0, rect.h - title) }
  out.gridRects.set(paneId, grid)
  out.cols.set(paneId, Math.max(1, Math.floor(grid.w / cell.cellW)))
  out.rows.set(paneId, Math.max(1, Math.floor(grid.h / cell.cellH)))
}

/** The grip between the explorer column and the grid, DIP (`styles.css` `.sidebar__grip`). */
export const SIDEBAR_GRIP_DIP = 6

export interface BodySplit {
  /** What the panes tile. */
  grid: Rect
  /** The explorer column, null while it is hidden. */
  column: Rect | null
  grip: Rect | null
}

/**
 * The window body (below the tab strip, above the status bar) as
 * `app.tsx:1562-1586` lays it out: the explorer column at the left edge, its
 * grip, then the grid in what is left. `columnW` is the rendered width (the
 * stored base width times uiScale, `layout/sidebar.ts`), null while hidden.
 */
export function splitBody(body: Rect, columnW: number | null): BodySplit {
  if (columnW === null) return { grid: body, column: null, grip: null }
  const column = { x: body.x, y: body.y, w: columnW, h: body.h }
  const grip = { x: body.x + columnW, y: body.y, w: SIDEBAR_GRIP_DIP, h: body.h }
  const gridX = grip.x + grip.w
  return { grid: { x: gridX, y: body.y, w: Math.max(0, body.x + body.w - gridX), h: body.h }, column, grip }
}

/** The drawer's grip, DIP (`styles.css` `.drawer__grip`): 6 tall across the top edge, not scaled by uiScale. */
export const DRAWER_GRIP_DIP = 6

/** The drawer's header row at uiScale 1 (`.drawer__head`: 4 DIP padding around 11 DIP text, plus its border). */
export const DRAWER_HEADER_DIP = 24

export interface DrawerRects {
  rect: Rect
  gripRect: Rect
  gridRect: Rect
}

/**
 * The shell drawer as `styles.css` `.drawer` places it: anchored to the bottom
 * of the grid area and laid over it (never over the explorer column), so the
 * panes under it keep their rects. `height` is the rendered height (the stored
 * base height times uiScale) and `headerH` the rendered header; the panel is
 * capped at the area. Below its 1 DIP top border come the header, the header's
 * 1 DIP bottom border, then the terminal. The grip straddles the top edge.
 */
export function drawerRects(area: Rect, height: number, headerH: number): DrawerRects {
  const h = Math.max(0, Math.min(area.h, height))
  const bottom = area.y + area.h
  const rect = { x: area.x, y: bottom - h, w: area.w, h }
  const gripY = Math.max(area.y, rect.y - DRAWER_GRIP_DIP / 2)
  const gripRect = { x: rect.x, y: gripY, w: rect.w, h: DRAWER_GRIP_DIP }
  const top = Math.min(bottom, rect.y + 1 + headerH + 1)
  const gridRect = { x: rect.x, y: top, w: rect.w, h: bottom - top }
  return { rect, gripRect, gridRect }
}

/** The update banner's band at uiScale 1 (`.update-banner`: 6 DIP padding around a 24 DIP button row, less the border). */
export const UPDATE_BANNER_DIP = 28

/**
 * The window under the tab strip, top to bottom (`app.tsx:1423-1805`): the
 * body, the update banner while it shows (`bannerH` 0 while it does not), then
 * the status bar. Everything in DIP; `clientW` and `clientH` are the client
 * area's.
 */
export function windowBands(clientW: number, clientH: number, tabStripH: number, statusH: number, bannerH: number): { body: Rect; banner: Rect | null } {
  const w = Math.max(0, clientW)
  const bodyH = Math.max(0, clientH - tabStripH - statusH - bannerH)
  const body = { x: 0, y: tabStripH, w, h: bodyH }
  const banner = bannerH > 0 ? { x: 0, y: tabStripH + bodyH, w, h: bannerH } : null
  return { body, banner }
}
