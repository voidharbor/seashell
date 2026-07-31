/**
 * Divider drag clamping and the water-filling size assignment that turns a
 * ratio tree plus an available pixel box into concrete pane rectangles.
 *
 * Water-filling (rather than a single ratio*span pass) exists because pure
 * ratios can hand a pane less than its minimum whenever the window shrinks
 * faster than the user rebalances — the deficit has to come from siblings
 * that still have slack, not from clamping the starved pane alone (which
 * would silently break the "ratios sum to 1" invariant on the next read).
 */

import { computeMinTree } from './minimums.js'
import type { CellSize, PaneRect, PixelSize, RowNode } from './types.js'
import { DIVIDER_PX, RATIO_EPSILON } from './types.js'

/**
 * Distribute `totalSpan` px across `mins.length` siblings by `ratios`,
 * raising anyone below their minimum and pulling the deficit proportionally
 * from siblings that have slack (assigned > min). Runs at most `n` passes,
 * matching the spec's "repeat at most n times" — each pass can only pin one
 * more child to its minimum, so n passes is always enough to reach a fixed
 * point.
 *
 * Degenerate case: if `totalSpan` is less than the sum of `mins`, every
 * child ends up pinned at its own minimum with no slack anywhere to draw
 * from, and the returned sizes sum to *more* than totalSpan. That is
 * intentional — the real app makes this unreachable via
 * `win.setMinimumSize`, and this function's job is to degrade predictably
 * rather than divide by zero or return negative sizes if it ever does happen.
 */
export function waterFill(totalSpan: number, mins: number[], ratios: number[], dividerPx: number): number[] {
  const n = mins.length
  if (n === 0) return []
  if (ratios.length !== n) {
    throw new Error(`waterFill: mins (${n}) and ratios (${ratios.length}) length mismatch`)
  }

  const usable = totalSpan - dividerPx * (n - 1)
  const sizes = ratios.map((r) => r * usable)

  for (let pass = 0; pass < n; pass++) {
    let deficit = 0
    for (let i = 0; i < n; i++) {
      const min = mins[i]
      const size = sizes[i]
      if (min === undefined || size === undefined) throw new Error('waterFill: index out of range')
      if (size < min) {
        deficit += min - size
        sizes[i] = min
      }
    }
    if (deficit <= RATIO_EPSILON) break

    let slackTotal = 0
    for (let i = 0; i < n; i++) {
      const min = mins[i]
      const size = sizes[i]
      if (min === undefined || size === undefined) throw new Error('waterFill: index out of range')
      if (size > min) slackTotal += size - min
    }
    if (slackTotal <= RATIO_EPSILON) break // nowhere left to pull the deficit from: degenerate case

    for (let i = 0; i < n; i++) {
      const min = mins[i]
      const size = sizes[i]
      if (min === undefined || size === undefined) throw new Error('waterFill: index out of range')
      const slack = size - min
      if (slack > 0) sizes[i] = size - (deficit * slack) / slackTotal
    }
  }

  return sizes
}

/**
 * Clamp a proposed "size of the sibling before the divider" drag to
 * `[minPx(i), span - DIVIDER_PX - minPx(i+1)]`, using each side's *subtree*
 * minimum (so dragging can never crush a nested pane below its own floor,
 * not just the immediate sibling's). If the span is too small to satisfy
 * both minimums at once, clamps to the lower bound — the degenerate case
 * `win.setMinimumSize` is meant to keep unreachable in practice.
 */
export function clampDividerDrag(
  spanPx: number,
  dividerPx: number,
  minPxBefore: number,
  minPxAfter: number,
  proposedSizeBefore: number,
): number {
  const lower = minPxBefore
  const upper = spanPx - dividerPx - minPxAfter
  if (upper < lower) return lower
  if (proposedSizeBefore < lower) return lower
  if (proposedSizeBefore > upper) return upper
  return proposedSizeBefore
}

/**
 * Full pixel assignment for every pane in the tree: water-fill the root's
 * columns across `avail.width`, then water-fill each column's panes across
 * `avail.height`. Used both for real rendering and by auto-arrange's
 * "would this insert leave a pane too small" check, so the two always agree
 * on what a pane's box would actually be.
 */
export function computeLayout(root: RowNode, avail: PixelSize, cell: CellSize): PaneRect[] {
  const minTree = computeMinTree(root, cell)
  const colWidths = waterFill(
    avail.width,
    minTree.children.map((c) => c.minW),
    root.ratios,
    DIVIDER_PX,
  )

  const rects: PaneRect[] = []
  let x = 0
  for (let i = 0; i < root.children.length; i++) {
    const col = root.children[i]
    const colMin = minTree.children[i]
    const width = colWidths[i]
    if (!col || !colMin || width === undefined) {
      throw new Error(`computeLayout: column index ${i} out of range`)
    }

    const paneHeights = waterFill(
      avail.height,
      colMin.children.map((p) => p.minH),
      col.ratios,
      DIVIDER_PX,
    )

    let y = 0
    for (let j = 0; j < col.children.length; j++) {
      const pane = col.children[j]
      const height = paneHeights[j]
      if (!pane || height === undefined) {
        throw new Error(`computeLayout: pane index ${j} out of range in column ${i}`)
      }
      rects.push({ paneId: pane.paneId, x, y, width, height })
      y += height + DIVIDER_PX
    }

    x += width + DIVIDER_PX
  }

  return rects
}
