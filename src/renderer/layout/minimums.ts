/**
 * Cell-based leaf minimums, propagated bottom-up into a minimum-size tree.
 *
 * Minimums are computed in cells and converted to px here (once) rather than
 * scattered across resize.ts and auto-arrange.ts, because both of those need
 * the *same* numbers (drag clamps and the auto-insert refusal check) and
 * disagreement between two independently-derived formulas would be a bug
 * that only shows up as a pane a few px too small to notice in review.
 */

import type { CellSize, ColMinNode, ColNode, PaneMinNode, RowMinNode, RowNode } from './types.js'
import { DIVIDER_PX, MIN_COLS, MIN_ROWS, TITLEBAR_PX } from './types.js'

/** A single leaf's pixel floor: xterm's own MINIMUM_COLS/ROWS are far too small to enforce. */
export function leafMinPx(cell: CellSize): { minW: number; minH: number } {
  return {
    minW: MIN_COLS * cell.cellW + 12,
    minH: MIN_ROWS * cell.cellH + TITLEBAR_PX + 12,
  }
}

function computeColMin(col: ColNode, cell: CellSize): ColMinNode {
  const paneMins: PaneMinNode[] = col.children.map((pane) => {
    const { minW, minH } = leafMinPx(cell)
    return { type: 'pane', paneId: pane.paneId, minW, minH }
  })
  const minH = paneMins.reduce((total, p) => total + p.minH, 0) + DIVIDER_PX * Math.max(0, paneMins.length - 1)
  const minW = paneMins.reduce((max, p) => Math.max(max, p.minW), 0)
  return { type: 'col', minW, minH, children: paneMins }
}

/**
 * Bottom-up propagation per spec 5.3: a row's minW is the sum of its
 * columns' minW plus dividers between them (they sit side by side, so their
 * widths add); its minH is the max of its columns' minH (they share the
 * same vertical extent). A column is the transpose of both.
 */
export function computeMinTree(root: RowNode, cell: CellSize): RowMinNode {
  const colMins: ColMinNode[] = root.children.map((col) => computeColMin(col, cell))
  const minW = colMins.reduce((total, c) => total + c.minW, 0) + DIVIDER_PX * Math.max(0, colMins.length - 1)
  const minH = colMins.reduce((max, c) => Math.max(max, c.minH), 0)
  return { type: 'row', minW, minH, children: colMins }
}
