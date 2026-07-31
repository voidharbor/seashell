import { computeMinTree } from './minimums.js'
import { DIVIDER_PX, type CellSize, type PaneRect, type PixelSize, type RowNode } from './types.js'

/**
 * A draggable border between two adjacent siblings.
 *
 * Depth-3 means exactly two kinds can exist: vertical dividers between columns
 * (full grid height) and horizontal dividers between panes inside one column.
 * Nothing else is representable, which is most of why the split tree was chosen
 * over a grid with spans — there, a border crossing a spanning cell has no
 * single correct meaning.
 */
export interface DividerSpec {
  id: string
  orientation: 'v' | 'h'
  /** Hit-strip rect. The visible line is 1px, centered inside it. */
  x: number
  y: number
  width: number
  height: number
  /** Index of the column this divider sits to the right of (orientation 'v'),
   *  or the column it lives inside (orientation 'h'). */
  colIndex: number
  /** For 'h' only: index of the pane this divider sits below. */
  paneIndex: number
}

export interface ColumnBox {
  x: number
  width: number
  top: number
  bottom: number
}

/** Reconstructs each column's box from the pane rects that belong to it. */
export function columnBoxes(tree: RowNode, rects: PaneRect[]): ColumnBox[] {
  const byId = new Map(rects.map((r) => [r.paneId, r]))
  return tree.children.map((col) => {
    const owned = col.children
      .map((p) => byId.get(p.paneId))
      .filter((r): r is PaneRect => r !== undefined)
    if (owned.length === 0) return { x: 0, width: 0, top: 0, bottom: 0 }
    const x = Math.min(...owned.map((r) => r.x))
    const width = Math.max(...owned.map((r) => r.width))
    const top = Math.min(...owned.map((r) => r.y))
    const bottom = Math.max(...owned.map((r) => r.y + r.height))
    return { x, width, top, bottom }
  })
}

export function deriveDividers(
  tree: RowNode,
  rects: PaneRect[],
  avail: PixelSize
): DividerSpec[] {
  const boxes = columnBoxes(tree, rects)
  const byId = new Map(rects.map((r) => [r.paneId, r]))
  const out: DividerSpec[] = []

  // Vertical: between column i and i+1, spanning the full grid height.
  for (let i = 0; i < tree.children.length - 1; i += 1) {
    const box = boxes[i]
    if (!box) continue
    out.push({
      id: `v-${i}`,
      orientation: 'v',
      x: box.x + box.width,
      y: 0,
      width: DIVIDER_PX,
      height: avail.height,
      colIndex: i,
      paneIndex: -1,
    })
  }

  // Horizontal: inside one column only.
  tree.children.forEach((col, ci) => {
    const box = boxes[ci]
    if (!box) return
    for (let j = 0; j < col.children.length - 1; j += 1) {
      const pane = col.children[j]
      const rect = pane ? byId.get(pane.paneId) : undefined
      if (!rect) continue
      out.push({
        id: `h-${ci}-${j}`,
        orientation: 'h',
        x: box.x,
        y: rect.y + rect.height,
        width: box.width,
        height: DIVIDER_PX,
        colIndex: ci,
        paneIndex: j,
      })
    }
  })

  return out
}

/**
 * Applies a drag to the tree, returning a new tree.
 *
 * Only the two siblings the divider sits between are touched; their combined
 * share is conserved, so dragging one border never disturbs the rest of the
 * layout. Both are clamped to their SUBTREE minimum, not their own — a column
 * cannot shrink below what its tallest stacked pane needs.
 */
export function applyDividerDrag(
  tree: RowNode,
  divider: DividerSpec,
  pointer: number,
  avail: PixelSize,
  cell: CellSize
): RowNode {
  const minTree = computeMinTree(tree, cell)

  if (divider.orientation === 'v') {
    const i = divider.colIndex
    const usable = avail.width - DIVIDER_PX * (tree.children.length - 1)
    if (usable <= 0) return tree

    const rA = tree.ratios[i]
    const rB = tree.ratios[i + 1]
    const minA = minTree.children[i]?.minW ?? 0
    const minB = minTree.children[i + 1]?.minW ?? 0
    if (rA === undefined || rB === undefined) return tree

    const combined = (rA + rB) * usable
    // `pointer` is the x of the divider's left edge relative to the grid.
    const leftEdge = sumRatios(tree.ratios, i) * usable + DIVIDER_PX * i
    let widthA = pointer - leftEdge
    widthA = Math.max(minA, Math.min(widthA, combined - minB))
    if (!Number.isFinite(widthA) || combined <= 0) return tree

    const ratios = [...tree.ratios]
    ratios[i] = widthA / usable
    ratios[i + 1] = (combined - widthA) / usable
    return { ...tree, ratios }
  }

  const ci = divider.colIndex
  const col = tree.children[ci]
  const colMin = minTree.children[ci]
  if (!col || !colMin) return tree

  const j = divider.paneIndex
  const rA = col.ratios[j]
  const rB = col.ratios[j + 1]
  if (rA === undefined || rB === undefined) return tree

  const usable = avail.height - DIVIDER_PX * (col.children.length - 1)
  if (usable <= 0) return tree

  const minA = colMin.children[j]?.minH ?? 0
  const minB = colMin.children[j + 1]?.minH ?? 0
  const combined = (rA + rB) * usable
  const topEdge = sumRatios(col.ratios, j) * usable + DIVIDER_PX * j
  let heightA = pointer - topEdge
  heightA = Math.max(minA, Math.min(heightA, combined - minB))
  if (!Number.isFinite(heightA) || combined <= 0) return tree

  const ratios = [...col.ratios]
  ratios[j] = heightA / usable
  ratios[j + 1] = (combined - heightA) / usable

  const children = [...tree.children]
  children[ci] = { ...col, ratios }
  return { ...tree, children }
}

function sumRatios(ratios: number[], upto: number): number {
  let s = 0
  for (let k = 0; k < upto; k += 1) s += ratios[k] ?? 0
  return s
}
