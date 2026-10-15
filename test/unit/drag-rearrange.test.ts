import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { createInitialTree, dfsPaneOrder, movePane, swapPanes, validateInvariant } from '../../src/renderer/layout/tree.js'
import { insertPane } from '../../src/renderer/layout/auto-arrange.js'
import { reducer } from '../../src/renderer/store.js'
import type { RowNode } from '../../src/renderer/layout/types.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, target: string) => c.event({ type: 'click', target, x: 0, y: 0, button: 0, mods })

/** a | b | c, three columns of one pane. */
function threeCols(): RowNode {
  let t = createInitialTree('a')
  t = insertPane(t, 'b', true)
  return { type: 'row', ratios: [0.25, 0.25, 0.5], children: [...t.children, { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'c' }] }] }
}

describe('swapPanes', () => {
  it('trades the two panes and keeps every ratio', () => {
    const t = threeCols()
    const s = swapPanes(t, 'a', 'c')
    expect(dfsPaneOrder(s)).toEqual(['c', 'b', 'a'])
    expect(s.ratios).toEqual(t.ratios)
    expect(validateInvariant(s)).toBe(true)
  })
  it('leaves the tree alone for the same pane or a missing one', () => {
    const t = threeCols()
    expect(swapPanes(t, 'a', 'a')).toBe(t)
    expect(swapPanes(t, 'a', 'zz')).toBe(t)
  })
})

describe('movePane', () => {
  it('docks a pane above or below another, taking half of its height', () => {
    const t = threeCols()
    const below = movePane(t, 'a', 'c', 'bottom')
    expect(validateInvariant(below)).toBe(true)
    expect(below.children).toHaveLength(2)
    expect(below.children[1]!.children.map((p) => p.paneId)).toEqual(['c', 'a'])
    expect(below.children[1]!.ratios).toEqual([0.5, 0.5])
    const above = movePane(t, 'a', 'c', 'top')
    expect(above.children[1]!.children.map((p) => p.paneId)).toEqual(['a', 'c'])
  })
  it('docks a pane beside another in a new column, taking half of its width', () => {
    const t = threeCols()
    const left = movePane(t, 'c', 'a', 'left')
    expect(validateInvariant(left)).toBe(true)
    expect(dfsPaneOrder(left)).toEqual(['c', 'a', 'b'])
    // c's half went back to a and b in proportion (1/2 each), then c took half of a's.
    expect(left.ratios).toEqual([0.25, 0.25, 0.5])
    const right = movePane(t, 'a', 'b', 'right')
    expect(dfsPaneOrder(right)).toEqual(['b', 'a', 'c'])
    expect(validateInvariant(right)).toBe(true)
  })
  it('pulls a pane out of a stack into its own column', () => {
    const stacked = movePane(threeCols(), 'b', 'a', 'bottom')
    expect(stacked.children[0]!.children.map((p) => p.paneId)).toEqual(['a', 'b'])
    const out = movePane(stacked, 'b', 'c', 'right')
    expect(validateInvariant(out)).toBe(true)
    expect(out.children.map((c) => c.children.map((p) => p.paneId))).toEqual([['a'], ['c'], ['b']])
  })
  it('leaves the tree alone for the same pane or a missing one', () => {
    const t = threeCols()
    expect(movePane(t, 'a', 'a', 'left')).toBe(t)
    expect(movePane(t, 'zz', 'a', 'left')).toBe(t)
    expect(movePane(t, 'a', 'zz', 'top')).toBe(t)
  })
})

describe('tab.move', () => {
  it('moves a tab to a slot, clamped, and ignores an unknown tab', () => {
    const f = { tabs: ['t1', 't2', 't3'].map((id) => ({ id })) } as unknown as Parameters<typeof reducer>[0]
    const ids = (s: Parameters<typeof reducer>[0]) => s.tabs.map((t) => t.id)
    expect(ids(reducer(f, { type: 'tab.move', tabId: 't1', toIndex: 2 }))).toEqual(['t2', 't3', 't1'])
    expect(ids(reducer(f, { type: 'tab.move', tabId: 't3', toIndex: -4 }))).toEqual(['t3', 't1', 't2'])
    expect(ids(reducer(f, { type: 'tab.move', tabId: 't2', toIndex: 99 }))).toEqual(['t1', 't3', 't2'])
    expect(reducer(f, { type: 'tab.move', tabId: 't2', toIndex: 1 })).toBe(f)
    expect(reducer(f, { type: 'tab.move', tabId: 'nope', toIndex: 0 })).toBe(f)
    expect(reducer(f, { type: 'tab.move', tabId: 't1', toIndex: Number.NaN })).toBe(f)
  })
})

describe('the shell drags, through the controller', () => {
  it('a tab dragged along the strip takes each slot it crosses into', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('tab.new')
    c.command('tab.new')
    const [t0, t1, t2] = c.model().tabs.map((t) => t.id)
    click(c, `tab:${t0}:move:1`)
    expect(c.model().tabs.map((t) => t.id)).toEqual([t1, t0, t2])
    click(c, `tab:${t0}:move:2`)
    expect(c.model().tabs.map((t) => t.id)).toEqual([t1, t2, t0])
    // The active tab stays the one it was.
    expect(c.model().tabs.find((t) => t.active)!.id).toBe(t2)
  })
  it('a pane dropped in the middle of another swaps with it', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const [p0, p1] = c.model().panes.map((p) => p.id)
    const rect = (id: string) => c.model().panes.find((p) => p.id === id)!.rect
    const r0 = rect(p0!), r1 = rect(p1!)
    click(c, `pane:${p0}:moveTo:${p1}:swap`)
    expect(rect(p0!)).toEqual(r1)
    expect(rect(p1!)).toEqual(r0)
    expect(c.model().panes.find((p) => p.focused)!.id).toBe(p0)
  })
  it('a pane dropped on an edge docks there, and a bad drop does nothing', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const [p0, p1] = c.model().panes.map((p) => p.id)
    const rect = (id: string) => c.model().panes.find((p) => p.id === id)!.rect
    expect(rect(p1!).x).toBeGreaterThan(rect(p0!).x) // side by side to start
    const before = c.model().panes.map((p) => p.rect)
    click(c, `pane:${p1}:moveTo:${p0}:sideways`)
    click(c, `pane:${p1}:moveTo:${p1}:top`)
    click(c, `pane:${p1}:moveTo:nope:top`)
    expect(c.model().panes.map((p) => p.rect)).toEqual(before)
    click(c, `pane:${p1}:moveTo:${p0}:bottom`)
    expect(rect(p1!).x).toBe(rect(p0!).x)
    expect(rect(p1!).y).toBeGreaterThan(rect(p0!).y)
    expect(rect(p1!).w).toBe(rect(p0!).w)
    expect(c.model().panes.find((p) => p.focused)!.id).toBe(p1)
  })
})
