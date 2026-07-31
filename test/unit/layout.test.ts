import { describe, expect, it } from 'vitest'

import {
  computeCStar,
  fitsAutoMinimum,
  insertPane,
  rebalance,
} from '../../src/renderer/layout/auto-arrange.js'
import { computeMinTree, leafMinPx } from '../../src/renderer/layout/minimums.js'
import {
  clampDividerDrag,
  computeLayout,
  waterFill,
} from '../../src/renderer/layout/resize.js'
import {
  columnPaneCounts,
  createInitialTree,
  dfsPaneOrder,
  findPane,
  removePane,
  validateInvariant,
} from '../../src/renderer/layout/tree.js'
import type { ColNode, RowNode } from '../../src/renderer/layout/types.js'
import {
  AUTO_MIN_COLS,
  AUTO_MIN_ROWS,
  DIVIDER_PX,
  MAX_PANES_PER_TAB,
  MIN_COLS,
  MIN_ROWS,
  TITLEBAR_PX,
} from '../../src/renderer/layout/types.js'

const CELL = { cellW: 8, cellH: 16 }

/** Column shapes as arrays of pane ids, for terse structural assertions. */
function shape(root: RowNode): string[][] {
  return root.children.map((col) => col.children.map((p) => p.paneId))
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

/** Builds N panes by repeated insertPane, pristine throughout (no drags). */
function buildIncremental(n: number): RowNode {
  let root = createInitialTree('p1')
  for (let i = 2; i <= n; i++) {
    root = insertPane(root, `p${i}`, true)
  }
  return root
}

// ---------------------------------------------------------------------------
// 5.2 Auto-insert: exact shapes for N = 1..6, one assertion per N
// ---------------------------------------------------------------------------

describe('auto-insert shapes N=1..6 (spec table)', () => {
  it('N=1: one full-tab pane', () => {
    const root = buildIncremental(1)
    expect(shape(root)).toEqual([['p1']])
    expect(validateInvariant(root)).toBe(true)
  })

  it('N=2: two side by side', () => {
    const root = buildIncremental(2)
    expect(shape(root)).toEqual([['p1'], ['p2']])
    expect(root.ratios).toEqual([0.5, 0.5])
    expect(validateInvariant(root)).toBe(true)
  })

  it('N=3: left full-height, right stacked', () => {
    const root = buildIncremental(3)
    expect(shape(root)).toEqual([['p1'], ['p2', 'p3']])
    expect(validateInvariant(root)).toBe(true)
  })

  it('N=4: quadrants', () => {
    const root = buildIncremental(4)
    expect(shape(root)).toEqual([
      ['p1', 'p4'],
      ['p2', 'p3'],
    ])
    expect(validateInvariant(root)).toBe(true)
  })

  it('N=5: three columns, third full-height', () => {
    const root = buildIncremental(5)
    expect(shape(root)).toEqual([['p1', 'p4'], ['p2', 'p3'], ['p5']])
    expect(validateInvariant(root)).toBe(true)
  })

  it('N=6: three by two', () => {
    const root = buildIncremental(6)
    expect(shape(root)).toEqual([
      ['p1', 'p4'],
      ['p2', 'p3'],
      ['p5', 'p6'],
    ])
    expect(validateInvariant(root)).toBe(true)
  })
})

describe('auto-insert ratio math', () => {
  it('new column: scales existing root ratios by k/(k+1), newcomer gets 1/(k+1)', () => {
    // N=4 -> N=5: k=2 existing columns, each at 0.5 -> scaled to 1/3; newcomer 1/3.
    const n4 = buildIncremental(4)
    const n5 = insertPane(n4, 'p5', true)
    expect(n5.ratios.length).toBe(3)
    for (const r of n5.ratios) expect(r).toBeCloseTo(1 / 3, 12)
    expect(Math.abs(sum(n5.ratios) - 1)).toBeLessThan(1e-9)
  })

  // With 2 columns already present (k=2), inserting a 3rd pane keeps C*(3)=2,
  // so k >= C* and the pane appends into an existing column (fewest panes,
  // tie -> rightmost) rather than opening a new one.
  it('existing column append (pristine): redistributes evenly regardless of prior ratios', () => {
    const col1: ColNode = { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'a' }] }
    const col2: ColNode = { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'c' }] }
    const root: RowNode = { type: 'row', ratios: [0.5, 0.5], children: [col1, col2] }
    const result = insertPane(root, 'b', true)
    expect(result.children.length).toBe(2) // no new column
    const targetCol = result.children[1] // tie -> rightmost
    expect(targetCol?.children.map((p) => p.paneId)).toEqual(['c', 'b'])
    expect(targetCol?.ratios).toEqual([0.5, 0.5])
    expect(result.ratios).toEqual([0.5, 0.5]) // root untouched: column count didn't change
  })

  it('existing column append (non-pristine): scales existing by m/(m+1), newcomer gets 1/(m+1)', () => {
    const col1: ColNode = { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'a' }] }
    const col2: ColNode = { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'c' }] }
    const root: RowNode = { type: 'row', ratios: [0.5, 0.5], children: [col1, col2] }
    const result = insertPane(root, 'b', false)
    const targetCol = result.children[1]
    // m=1: scale = 1/2, so identical numeric outcome to the pristine branch at
    // this m, but exercised through the distinct (non-pristine) code path.
    expect(targetCol?.ratios).toEqual([0.5, 0.5])
  })

  it('refuses to insert past MAX_PANES_PER_TAB', () => {
    const full = buildIncremental(MAX_PANES_PER_TAB)
    expect(() => insertPane(full, 'p7', true)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 5.2 Rebalance: agrees with incremental insert at N = 1, 2, 4, 6
// ---------------------------------------------------------------------------

describe('rebalance', () => {
  it.each([1, 2, 4, 6])('agrees with incremental insert at N=%i', (n) => {
    const incremental = buildIncremental(n)
    const rebuilt = rebalance(incremental)
    expect(shape(rebuilt)).toEqual(shape(incremental))
    expect(validateInvariant(rebuilt)).toBe(true)
  })

  it('sets even ratios and a canonical column split at N=5', () => {
    const root = rebalance(buildIncremental(5))
    expect(columnPaneCounts(root)).toEqual([1, 2, 2])
    for (const r of root.ratios) expect(r).toBeCloseTo(1 / 3, 12)
    for (const col of root.children) {
      const evenRatio = 1 / col.children.length
      for (const r of col.ratios) expect(r).toBeCloseTo(evenRatio, 12)
    }
  })

  it('computeCStar matches ceil(sqrt(N))', () => {
    expect(computeCStar(1)).toBe(1)
    expect(computeCStar(2)).toBe(2)
    expect(computeCStar(3)).toBe(2)
    expect(computeCStar(4)).toBe(2)
    expect(computeCStar(5)).toBe(3)
    expect(computeCStar(6)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// tree.ts: construction, query, removal, invariant
// ---------------------------------------------------------------------------

describe('tree query helpers', () => {
  it('dfsPaneOrder walks columns left-to-right, panes top-to-bottom', () => {
    const root = buildIncremental(6)
    expect(dfsPaneOrder(root)).toEqual(['p1', 'p4', 'p2', 'p3', 'p5', 'p6'])
  })

  it('findPane locates existing panes and returns undefined for missing ones', () => {
    const root = buildIncremental(4)
    expect(findPane(root, 'p3')).toEqual({ colIndex: 1, paneIndex: 1 })
    expect(findPane(root, 'nope')).toBeUndefined()
  })
})

describe('validateInvariant', () => {
  it('accepts a canonical tree', () => {
    expect(validateInvariant(buildIncremental(6))).toBe(true)
  })

  it('accepts the fully-empty root (transient state after closing the last pane)', () => {
    expect(validateInvariant({ type: 'row', ratios: [], children: [] })).toBe(true)
  })

  it('rejects ratios that do not sum to 1', () => {
    const bad: RowNode = {
      type: 'row',
      ratios: [0.4, 0.4],
      children: [
        { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'a' }] },
        { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'b' }] },
      ],
    }
    expect(validateInvariant(bad)).toBe(false)
  })

  it('rejects a column with zero panes', () => {
    const bad: RowNode = {
      type: 'row',
      ratios: [1],
      children: [{ type: 'col', ratios: [], children: [] }],
    }
    expect(validateInvariant(bad)).toBe(false)
  })

  it('rejects duplicate pane ids across columns', () => {
    const bad: RowNode = {
      type: 'row',
      ratios: [0.5, 0.5],
      children: [
        { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'dup' }] },
        { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'dup' }] },
      ],
    }
    expect(validateInvariant(bad)).toBe(false)
  })

  it('rejects pane counts over MAX_PANES_PER_TAB', () => {
    const panes = Array.from({ length: 7 }, (_, i) => ({ type: 'pane' as const, paneId: `p${i}` }))
    const bad: RowNode = {
      type: 'row',
      ratios: [1],
      children: [{ type: 'col', ratios: panes.map(() => 1 / 7), children: panes }],
    }
    expect(validateInvariant(bad)).toBe(false)
  })
})

describe('removePane', () => {
  it('removes a leaf and redistributes its column proportionally', () => {
    const col: ColNode = {
      type: 'col',
      ratios: [0.2, 0.3, 0.5],
      children: [
        { type: 'pane', paneId: 'a' },
        { type: 'pane', paneId: 'b' },
        { type: 'pane', paneId: 'c' },
      ],
    }
    const root: RowNode = { type: 'row', ratios: [1], children: [col] }
    const result = removePane(root, 'b')
    expect(dfsPaneOrder(result)).toEqual(['a', 'c'])
    // remaining 0.2 and 0.5 renormalized over their sum 0.7
    expect(result.children[0]?.ratios[0]).toBeCloseTo(0.2 / 0.7, 12)
    expect(result.children[0]?.ratios[1]).toBeCloseTo(0.5 / 0.7, 12)
    expect(validateInvariant(result)).toBe(true)
  })

  it('removes an emptied column and redistributes root ratios', () => {
    const root = buildIncremental(2) // R[ C[p1](0.5), C[p2](0.5) ]
    const result = removePane(root, 'p2')
    expect(result.children.length).toBe(1)
    expect(result.ratios).toEqual([1])
    expect(dfsPaneOrder(result)).toEqual(['p1'])
    expect(validateInvariant(result)).toBe(true)
  })

  it('removing the last pane yields the fully-empty root', () => {
    const root = createInitialTree('only')
    const result = removePane(root, 'only')
    expect(result.children).toEqual([])
    expect(result.ratios).toEqual([])
    expect(validateInvariant(result)).toBe(true)
  })

  it('is a no-op for an unknown pane id', () => {
    const root = buildIncremental(3)
    expect(removePane(root, 'ghost')).toBe(root)
  })
})

// ---------------------------------------------------------------------------
// minimums.ts: leaf floors and bottom-up propagation
// ---------------------------------------------------------------------------

describe('minimums', () => {
  it('leafMinPx applies the MIN_COLS/MIN_ROWS + chrome formula', () => {
    const { minW, minH } = leafMinPx(CELL)
    expect(minW).toBe(MIN_COLS * CELL.cellW + 12)
    expect(minH).toBe(MIN_ROWS * CELL.cellH + TITLEBAR_PX + 12)
  })

  it('row minW sums children minW plus dividers; minH is the max', () => {
    const root = buildIncremental(4) // 2 columns of 2 panes each
    const minTree = computeMinTree(root, CELL)
    const { minW: leafW, minH: leafH } = leafMinPx(CELL)

    const expectedColMinW = leafW
    const expectedColMinH = 2 * leafH + DIVIDER_PX
    expect(minTree.children[0]?.minW).toBe(expectedColMinW)
    expect(minTree.children[0]?.minH).toBe(expectedColMinH)

    expect(minTree.minW).toBe(2 * expectedColMinW + DIVIDER_PX)
    expect(minTree.minH).toBe(expectedColMinH)
  })
})

// ---------------------------------------------------------------------------
// resize.ts: water-filling and divider drag clamp
// ---------------------------------------------------------------------------

describe('waterFill', () => {
  it('distributes by ratio when everyone has slack', () => {
    const sizes = waterFill(1000, [10, 10], [0.25, 0.75], DIVIDER_PX)
    const usable = 1000 - DIVIDER_PX
    expect(sizes[0]).toBeCloseTo(usable * 0.25, 9)
    expect(sizes[1]).toBeCloseTo(usable * 0.75, 9)
  })

  it('raises a sub-minimum child and pulls the deficit from siblings with slack', () => {
    const sizes = waterFill(1000, [400, 10, 10], [0.1, 0.45, 0.45], DIVIDER_PX)
    const usable = 1000 - 2 * DIVIDER_PX
    expect(sizes[0]).toBeCloseTo(400, 9) // raised to its minimum
    expect(sizes[0]).toBeGreaterThanOrEqual(400)
    expect((sizes[1] ?? 0) + (sizes[2] ?? 0)).toBeCloseTo(usable - 400, 6)
    // slack siblings still split what's left proportionally to their own ratio (equal here)
    expect(sizes[1]).toBeCloseTo(sizes[2] ?? -1, 9)
  })

  it('degenerate case: total space below the sum of minimums returns the minimums, oversubscribed', () => {
    const mins = [500, 500, 500]
    const sizes = waterFill(300, mins, [1 / 3, 1 / 3, 1 / 3], DIVIDER_PX)
    expect(sizes).toEqual(mins)
    expect(sum(sizes)).toBeGreaterThan(300)
  })

  it('single child gets the full usable span regardless of its minimum', () => {
    expect(waterFill(500, [10], [1], DIVIDER_PX)).toEqual([500])
  })
})

describe('clampDividerDrag', () => {
  it('passes through a proposal inside bounds', () => {
    expect(clampDividerDrag(1000, DIVIDER_PX, 100, 100, 500)).toBe(500)
  })

  it('clamps below the lower bound (subtree min of the left sibling)', () => {
    expect(clampDividerDrag(1000, DIVIDER_PX, 200, 100, 50)).toBe(200)
  })

  it('clamps above the upper bound (span - divider - right sibling subtree min)', () => {
    const upper = 1000 - DIVIDER_PX - 100
    expect(clampDividerDrag(1000, DIVIDER_PX, 200, 100, 950)).toBe(upper)
  })

  it('degenerate: span too small for both minimums clamps to the lower bound', () => {
    expect(clampDividerDrag(150, DIVIDER_PX, 100, 100, 80)).toBe(100)
  })
})

describe('computeLayout', () => {
  it('lays out quadrants (N=4) into four non-overlapping rects summing to the available box', () => {
    const root = buildIncremental(4)
    const avail = { width: 1600, height: 800 }
    const rects = computeLayout(root, avail, CELL)
    expect(rects.length).toBe(4)

    const byId = new Map(rects.map((r) => [r.paneId, r]))
    const p1 = byId.get('p1')
    const p4 = byId.get('p4')
    const p2 = byId.get('p2')
    expect(p1).toBeDefined()
    expect(p4).toBeDefined()
    expect(p2).toBeDefined()
    // p1/p4 share a column: same x/width, stacked vertically
    expect(p4?.x).toBe(p1?.x)
    expect(p4?.width).toBe(p1?.width)
    expect(p4?.y).toBe((p1?.y ?? 0) + (p1?.height ?? 0) + DIVIDER_PX)
    // columns split the width evenly (both ratios 0.5) once above minimums
    expect(p1?.width).toBeCloseTo(p2?.width ?? -1, 9)
    // total column width + divider equals the available width
    expect((p1?.width ?? 0) + (p2?.width ?? 0) + DIVIDER_PX).toBeCloseTo(avail.width, 6)
  })
})

// ---------------------------------------------------------------------------
// auto-arrange.ts: AUTO_MIN refusal
// ---------------------------------------------------------------------------

describe('fitsAutoMinimum', () => {
  it('accepts an insert with plenty of room', () => {
    const candidate = insertPane(buildIncremental(4), 'p5', true)
    const roomy = { width: 4000, height: 2000 }
    expect(fitsAutoMinimum(candidate, roomy, CELL)).toBe(true)
  })

  it('refuses an insert that would starve a pane below AUTO_MIN_COLS x AUTO_MIN_ROWS', () => {
    const candidate = insertPane(buildIncremental(4), 'p5', true)
    // Big enough to satisfy the hard MIN_* floor per pane but not the larger AUTO_MIN_* floor.
    const cramped = {
      width: 3 * (MIN_COLS * CELL.cellW + 12) + 2 * DIVIDER_PX,
      height: MIN_ROWS * CELL.cellH + TITLEBAR_PX + 12,
    }
    expect(fitsAutoMinimum(candidate, cramped, CELL)).toBe(false)
    // Sanity: AUTO_MIN is strictly larger than MIN, which is why this is refused.
    expect(AUTO_MIN_COLS).toBeGreaterThan(MIN_COLS)
    expect(AUTO_MIN_ROWS).toBeGreaterThan(MIN_ROWS)
  })
})
