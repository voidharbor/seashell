/**
 * The C* = ceil(sqrt(N)) auto-insert rule and the canonical Rebalance rebuild.
 *
 * This is split from tree.ts because it encodes a *policy* (where a new pane
 * should land, when a tab counts as "pristine") layered on top of the generic
 * tree operations, and that policy is exactly what the spec's walkthrough
 * table pins down pane-by-pane — it deserves its own file and its own tests.
 */

import { columnPaneCounts, countPanes, dfsPaneOrder } from './tree.js'
import type { CellSize, ColNode, PaneLeaf, PixelSize, RowNode } from './types.js'
import { AUTO_MIN_COLS, AUTO_MIN_ROWS, MAX_PANES_PER_TAB, TITLEBAR_PX } from './types.js'
import { computeLayout } from './resize.js'

/** C* from the spec: the target column count once N panes exist. */
export function computeCStar(paneCountAfterInsert: number): number {
  return Math.ceil(Math.sqrt(paneCountAfterInsert))
}

/**
 * Insert `newPaneId` per the spec's monotone auto-insert rule. Existing
 * panes never change column or order — the function only ever appends,
 * either a new rightmost column or a new bottom entry in an existing one.
 *
 * `pristine` must be the tab's current pristine flag (false once the user
 * has dragged any divider): it decides whether landing in an existing
 * column redistributes that column evenly or scales the incumbents down.
 * Pristine-ness itself is tab state, not tree state, so it is threaded in
 * rather than stored on the tree.
 *
 * Throws if the tab is already at MAX_PANES_PER_TAB — the "+" button and
 * Cmd+D are expected to disable themselves before this is ever reachable,
 * so hitting it is a caller bug, not a user-reachable state.
 */
export function insertPane(root: RowNode, newPaneId: string, pristine: boolean): RowNode {
  const currentN = countPanes(root)
  if (currentN >= MAX_PANES_PER_TAB) {
    throw new Error(`insertPane: tab already has the max of ${MAX_PANES_PER_TAB} panes`)
  }

  const n = currentN + 1
  const cStar = computeCStar(n)
  const k = root.children.length

  if (k < cStar) {
    const scale = k / (k + 1)
    const newRootRatios = root.ratios.map((r) => r * scale)
    newRootRatios.push(1 / (k + 1))
    const newColumn: ColNode = { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: newPaneId }] }
    return { type: 'row', ratios: newRootRatios, children: [...root.children, newColumn] }
  }

  // Append to the column with the fewest panes; ties resolve to the
  // rightmost such column, so we keep overwriting on `<=` while scanning left to right.
  const counts = columnPaneCounts(root)
  let targetIndex = 0
  let fewest = Number.POSITIVE_INFINITY
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i]
    if (count !== undefined && count <= fewest) {
      fewest = count
      targetIndex = i
    }
  }

  const target = root.children[targetIndex]
  if (!target) throw new Error('insertPane: no target column found')
  const m = target.children.length
  const newPane: PaneLeaf = { type: 'pane', paneId: newPaneId }

  let newColRatios: number[]
  if (pristine) {
    const even = 1 / (m + 1)
    newColRatios = target.children.map(() => even)
    newColRatios.push(even)
  } else {
    const scale = m / (m + 1)
    newColRatios = target.ratios.map((r) => r * scale)
    newColRatios.push(1 / (m + 1))
  }

  const newColumn: ColNode = { type: 'col', ratios: newColRatios, children: [...target.children, newPane] }
  const newChildren = root.children.map((c, i) => (i === targetIndex ? newColumn : c))
  return { type: 'row', ratios: root.ratios, children: newChildren }
}

/**
 * Canonical rebuild (Cmd+Shift+R): re-derives column count and per-column
 * pane counts from N alone, ignoring the tree's current shape entirely, then
 * refills columns from the current DFS pane order so pane identity is
 * preserved even though placement is not. The caller is responsible for
 * setting `tab.pristine = true` afterward — that flag lives on the tab, not
 * on the tree this function returns.
 */
export function rebalance(root: RowNode): RowNode {
  const paneIds = dfsPaneOrder(root)
  const n = paneIds.length
  if (n === 0) return { type: 'row', ratios: [], children: [] }

  const cStar = computeCStar(n)
  const base = Math.floor(n / cStar)
  const rem = n % cStar
  const leading = cStar - rem

  let cursor = 0
  const columns: ColNode[] = []
  for (let colIdx = 0; colIdx < cStar; colIdx++) {
    const count = colIdx < leading ? base : base + 1
    const panes: PaneLeaf[] = []
    for (let k = 0; k < count; k++) {
      const id = paneIds[cursor]
      if (id === undefined) throw new Error('rebalance: pane id index out of range')
      panes.push({ type: 'pane', paneId: id })
      cursor++
    }
    const paneRatio = 1 / count
    columns.push({ type: 'col', ratios: panes.map(() => paneRatio), children: panes })
  }

  const colRatio = 1 / cStar
  return { type: 'row', ratios: columns.map(() => colRatio), children: columns }
}

/**
 * Auto-insert refuses (spec 5.3) when placing another pane would push any
 * pane's assigned box below AUTO_MIN_COLS x AUTO_MIN_ROWS cells. Checked by
 * actually laying the *candidate* tree out (water-filling included) rather
 * than eyeballing ratios, because a pane can be starved by its siblings'
 * minimums even when its own ratio looks generous.
 */
export function fitsAutoMinimum(candidateRoot: RowNode, avail: PixelSize, cell: CellSize): boolean {
  const autoMinW = AUTO_MIN_COLS * cell.cellW + 12
  const autoMinH = AUTO_MIN_ROWS * cell.cellH + TITLEBAR_PX + 12
  const rects = computeLayout(candidateRoot, avail, cell)
  return rects.every((r) => r.width >= autoMinW && r.height >= autoMinH)
}
