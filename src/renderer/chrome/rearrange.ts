/**
 * The maths behind dragging a tab along the strip and a pane onto another
 * pane, as the native shell's ui/drag.cpp does it, for the Electron window.
 * Pure, so app.tsx only wires pointer events to it and the rules are tested
 * here once.
 */
import { movePane, swapPanes, type DropEdge } from '../layout/tree.js'
import type { PaneRect, RowNode } from '../layout/types.js'

/** Past this many CSS px from the press a drag is on, not a click (Windows' SM_CXDRAG is 4). */
export const DRAG_SLOP = 4

export type DropWhere = 'swap' | DropEdge

export interface DropZone {
  paneId: string
  where: DropWhere
  /** The highlighted part of the target, in the grid's coordinates. */
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * The slot a dragged tab belongs in: the one whose span holds the dragged
 * tab's centre `x`, given the tabs' spans in strip order (the dragged tab's
 * own span included, wherever it currently sits). Before the first span is
 * slot 0, past the last is the last slot.
 */
export function tabSlotAt(spans: ReadonlyArray<{ left: number; width: number }>, x: number): number {
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!
    if (x < s.left + s.width) return i
  }
  return Math.max(0, spans.length - 1)
}

/**
 * Where a pane dragged to `point` would land on the pane under it: the middle
 * half both ways swaps the two, the rest docks against the nearest edge. Null
 * over the dragged pane itself or over no pane.
 */
export function dropZoneAt(rects: readonly PaneRect[], point: { x: number; y: number }, draggedId: string): DropZone | null {
  for (const r of rects) {
    if (point.x < r.x || point.x >= r.x + r.width || point.y < r.y || point.y >= r.y + r.height) continue
    if (r.paneId === draggedId || r.width <= 0 || r.height <= 0) return null
    const fx = (point.x - r.x) / r.width
    const fy = (point.y - r.y) / r.height
    const mx = r.x + r.width / 2
    const my = r.y + r.height / 2
    if (fx > 0.25 && fx < 0.75 && fy > 0.25 && fy < 0.75) {
      return { paneId: r.paneId, where: 'swap', rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
    }
    const nearest = Math.min(fx, 1 - fx, fy, 1 - fy)
    if (nearest === fx) return { paneId: r.paneId, where: 'left', rect: { x: r.x, y: r.y, width: mx - r.x, height: r.height } }
    if (nearest === 1 - fx) return { paneId: r.paneId, where: 'right', rect: { x: mx, y: r.y, width: r.x + r.width - mx, height: r.height } }
    if (nearest === fy) return { paneId: r.paneId, where: 'top', rect: { x: r.x, y: r.y, width: r.width, height: my - r.y } }
    return { paneId: r.paneId, where: 'bottom', rect: { x: r.x, y: my, width: r.width, height: r.y + r.height - my } }
  }
  return null
}

/** The tree after a drop: `swap` trades the two panes' places, an edge docks the dragged pane on that side of the target. */
export function dropTree(tree: RowNode, paneId: string, zone: DropZone): RowNode {
  return zone.where === 'swap' ? swapPanes(tree, paneId, zone.paneId) : movePane(tree, paneId, zone.paneId, zone.where)
}
