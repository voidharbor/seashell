/**
 * Construction, query, and removal for the depth-3 Row -> Col[] -> Pane[] tree.
 *
 * Kept free of any auto-arrange policy (that lives in auto-arrange.ts) because
 * "how do I read/edit this tree" and "what shape should a new pane land in"
 * change for different reasons: this file only has to stay correct against
 * the structural invariant, not against the C* = ceil(sqrt(N)) rule.
 */

import type { ColNode, PaneLeaf, RowNode } from './types.js'
import { MAX_PANES_PER_TAB, RATIO_EPSILON } from './types.js'

/** Where a pane lives: which column, and which slot within that column. */
export interface PaneLocation {
  readonly colIndex: number
  readonly paneIndex: number
}

/**
 * The only legal starting tree: one column, one pane, both ratios 1.
 * Exists so every call site constructs N=1 the same way instead of
 * hand-rolling the row/col wrapper.
 */
export function createInitialTree(paneId: string): RowNode {
  return {
    type: 'row',
    ratios: [1],
    children: [{ type: 'col', ratios: [1], children: [{ type: 'pane', paneId }] }],
  }
}

/** Total pane count across the whole tree. Used to compute C* on insert. */
export function countPanes(root: RowNode): number {
  let n = 0
  for (const col of root.children) n += col.children.length
  return n
}

/** Pane count per column, left to right. Used by the "fewest panes" insert rule. */
export function columnPaneCounts(root: RowNode): number[] {
  return root.children.map((col) => col.children.length)
}

/**
 * DFS pane order: columns left to right, panes top to bottom within each
 * column. This is the canonical order Rebalance and Cmd+]/Cmd+[ both read
 * from, so it is defined once here rather than re-derived per caller.
 */
export function dfsPaneOrder(root: RowNode): string[] {
  const order: string[] = []
  for (const col of root.children) {
    for (const pane of col.children) order.push(pane.paneId)
  }
  return order
}

/** Locate a pane by id. Returns undefined rather than throwing: callers
 * (close, focus-nav) routinely probe for a pane that may already be gone. */
export function findPane(root: RowNode, paneId: string): PaneLocation | undefined {
  for (let colIndex = 0; colIndex < root.children.length; colIndex++) {
    const col = root.children[colIndex]
    if (!col) continue
    for (let paneIndex = 0; paneIndex < col.children.length; paneIndex++) {
      const pane = col.children[paneIndex]
      if (pane !== undefined && pane.paneId === paneId) return { colIndex, paneIndex }
    }
  }
  return undefined
}

export function hasPane(root: RowNode, paneId: string): boolean {
  return findPane(root, paneId) !== undefined
}

/**
 * Redistribute ratios after dropping the entry at `removedIndex`, so the
 * remaining entries' relative proportions are preserved and their sum is
 * exactly 1. Falls back to an even split only in the degenerate case where
 * the removed entry held essentially the entire ratio budget (float sums
 * that would otherwise divide by ~0).
 */
function redistributeAfterRemoval(ratios: number[], removedIndex: number): number[] {
  const removed = ratios[removedIndex]
  if (removed === undefined) {
    throw new Error(`redistributeAfterRemoval: index ${removedIndex} out of range`)
  }
  const remaining = ratios.filter((_, i) => i !== removedIndex)
  if (remaining.length === 0) return []
  const remainingSum = 1 - removed
  if (remainingSum <= RATIO_EPSILON) {
    const even = 1 / remaining.length
    return remaining.map(() => even)
  }
  return remaining.map((r) => r / remainingSum)
}

/**
 * Remove a pane and redistribute its parent column's ratios proportionally.
 * A column left with zero panes is dropped and the root's ratios are
 * redistributed the same way. Returns `root` unchanged if `paneId` is not
 * found, so callers can call this speculatively without a guard.
 *
 * A tree with zero remaining panes comes back as an empty row (no columns,
 * no ratios) rather than throwing: closing the last pane in a tab is a
 * legal sequence, and it is the tab-close caller's job to notice the tree
 * is now empty and tear the tab down, not this function's.
 */
export function removePane(root: RowNode, paneId: string): RowNode {
  const loc = findPane(root, paneId)
  if (!loc) return root
  const { colIndex, paneIndex } = loc
  const col = root.children[colIndex]
  if (!col) throw new Error(`removePane: column ${colIndex} out of range`)

  const newColRatios = redistributeAfterRemoval(col.ratios, paneIndex)
  const newColChildren = col.children.filter((_, i) => i !== paneIndex)

  if (newColChildren.length === 0) {
    const newRowRatios = redistributeAfterRemoval(root.ratios, colIndex)
    const newRowChildren = root.children.filter((_, i) => i !== colIndex)
    return { type: 'row', ratios: newRowRatios, children: newRowChildren }
  }

  const newCol: ColNode = { type: 'col', ratios: newColRatios, children: newColChildren }
  const newChildren = root.children.map((c, i) => (i === colIndex ? newCol : c))
  return { type: 'row', ratios: root.ratios, children: newChildren }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

function ratioSumOk(ratios: number[]): boolean {
  return Math.abs(sum(ratios) - 1) <= RATIO_EPSILON
}

/**
 * Checks every structural and numeric rule the layout engine depends on:
 * ratio arrays sum to 1 and line up 1:1 with children, no column is empty,
 * no duplicate pane ids, and the tab-wide pane cap is respected. Depth
 * itself needs no runtime check — the RowNode/ColNode/PaneLeaf types make a
 * 4th level or a misplaced node a compile error, not a runtime one.
 *
 * A fully empty root (`children: []`, `ratios: []`) is accepted: it is the
 * transient result of `removePane` closing the last pane, on its way to the
 * tab being torn down by the caller.
 */
export function validateInvariant(root: RowNode): boolean {
  if (root.type !== 'row') return false

  if (root.children.length === 0) return root.ratios.length === 0

  if (root.ratios.length !== root.children.length) return false
  if (!ratioSumOk(root.ratios)) return false

  const seenPaneIds = new Set<string>()
  let paneCount = 0

  for (const col of root.children) {
    if (col.type !== 'col') return false
    if (col.children.length === 0) return false
    if (col.ratios.length !== col.children.length) return false
    if (!ratioSumOk(col.ratios)) return false

    for (const pane of col.children) {
      if (pane.type !== 'pane') return false
      if (pane.paneId.length === 0) return false
      if (seenPaneIds.has(pane.paneId)) return false
      seenPaneIds.add(pane.paneId)
      paneCount++
    }
  }

  if (paneCount > MAX_PANES_PER_TAB) return false

  return true
}

/** Re-export so callers that only need leaf construction don't reach into types.ts. */
export type { ColNode, PaneLeaf, RowNode }
