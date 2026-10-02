import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

export { fakeDeps }

describe('controller: boot and the view model', () => {
  it('boots to one tab with one live term pane at home when there is no session', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const m = c.model()
    expect(m.starting).toBe(false)
    expect(m.tabs).toHaveLength(1)
    expect(m.tabs[0]!.name).toBe('~')
    expect(m.panes).toHaveLength(1)
    expect(m.panes[0]!.kind).toBe('term')
    expect(f.grid().find((g) => g.op === 'create')).toMatchObject({ cols: expect.any(Number), rows: expect.any(Number), scrollback: 20000 })
    expect(f.sent.find(([ch]) => ch === 'pty:spawn')?.[1]).toMatchObject({ cwd: '/Users/joshwald', file: '/usr/bin/zsh' })
  })
  it('rects tile the grid area, dividers sit between panes, cols and rows come from the cell size', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const m = c.model()
    expect(m.panes).toHaveLength(2)
    expect(m.dividers).toHaveLength(1)
    expect(m.dividers[0]!.orientation).toBe('vertical')
    for (const p of m.panes) {
      expect(p.cols).toBe(Math.floor(p.gridRect.w / GEO.cellW))
      expect(p.rows).toBe(Math.floor(p.gridRect.h / GEO.cellH))
      expect(p.gridRect.h).toBe(p.rect.h - 24)
    }
  })
  it('a divider drag changes the two neighbours and marks the tab non-pristine', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const d = c.model().dividers[0]!
    const before = c.model().panes.map((p) => p.rect.w)
    const mods = { ctrl: false, alt: false, shift: false }
    c.event({ type: 'down', target: `divider:${d.id}`, x: d.rect.x + 4, y: 300, button: 0, mods })
    c.event({ type: 'move', target: `divider:${d.id}`, x: d.rect.x + 104, y: 300, button: 0, mods })
    c.event({ type: 'up', target: `divider:${d.id}`, x: d.rect.x + 104, y: 300, button: 0, mods })
    const after = c.model().panes.map((p) => p.rect.w)
    expect(after[0]).toBeGreaterThan(before[0]!)
    expect(after[1]).toBeLessThan(before[1]!)
    expect(c.state().tabs[0]!.pristine).toBe(false)
  })
})
