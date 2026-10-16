import { describe, expect, it } from 'vitest'
import { dropTree, dropZoneAt, tabSlotAt } from '../../src/renderer/chrome/rearrange.js'
import { createInitialTree, dfsPaneOrder, validateInvariant } from '../../src/renderer/layout/tree.js'
import { insertPane } from '../../src/renderer/layout/auto-arrange.js'
import type { PaneRect } from '../../src/renderer/layout/types.js'

describe('tabSlotAt', () => {
  const spans = [
    { left: 0, width: 100 },
    { left: 102, width: 100 },
    { left: 204, width: 100 },
  ]
  it('is the slot whose span holds the centre, clamped at the ends', () => {
    expect(tabSlotAt(spans, -40)).toBe(0)
    expect(tabSlotAt(spans, 50)).toBe(0)
    expect(tabSlotAt(spans, 101)).toBe(1) // the gap counts toward the next slot
    expect(tabSlotAt(spans, 250)).toBe(2)
    expect(tabSlotAt(spans, 900)).toBe(2)
    expect(tabSlotAt([], 10)).toBe(0)
  })
})

const two: PaneRect[] = [
  { paneId: 'a', x: 0, y: 0, width: 400, height: 300 },
  { paneId: 'b', x: 404, y: 0, width: 400, height: 300 },
]

describe('dropZoneAt', () => {
  it('swaps in the middle and docks on the nearest edge', () => {
    expect(dropZoneAt(two, { x: 600, y: 150 }, 'a')).toEqual({ paneId: 'b', where: 'swap', rect: { x: 404, y: 0, width: 400, height: 300 } })
    expect(dropZoneAt(two, { x: 420, y: 150 }, 'a')).toMatchObject({ where: 'left', rect: { x: 404, width: 200, height: 300 } })
    expect(dropZoneAt(two, { x: 790, y: 150 }, 'a')).toMatchObject({ where: 'right', rect: { x: 604, width: 200 } })
    expect(dropZoneAt(two, { x: 600, y: 20 }, 'a')).toMatchObject({ where: 'top', rect: { y: 0, height: 150 } })
    expect(dropZoneAt(two, { x: 600, y: 290 }, 'a')).toMatchObject({ where: 'bottom', rect: { y: 150, height: 150 } })
  })
  it('is null over the dragged pane, the gap and the outside', () => {
    expect(dropZoneAt(two, { x: 100, y: 100 }, 'a')).toBeNull()
    expect(dropZoneAt(two, { x: 402, y: 100 }, 'a')).toBeNull()
    expect(dropZoneAt(two, { x: 100, y: 900 }, 'a')).toBeNull()
  })
})

describe('dropTree', () => {
  it('swaps or docks through the layout tree helpers', () => {
    let t = createInitialTree('a')
    t = insertPane(t, 'b', true)
    const swapped = dropTree(t, 'a', { paneId: 'b', where: 'swap', rect: two[1]! })
    expect(dfsPaneOrder(swapped)).toEqual(['b', 'a'])
    const docked = dropTree(t, 'a', { paneId: 'b', where: 'bottom', rect: two[1]! })
    expect(validateInvariant(docked)).toBe(true)
    expect(docked.children).toHaveLength(1)
    expect(docked.children[0]!.children.map((p) => p.paneId)).toEqual(['b', 'a'])
  })
})
