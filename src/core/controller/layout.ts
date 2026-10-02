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
