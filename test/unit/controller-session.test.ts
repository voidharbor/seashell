import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps } from './controller-fakes.js'
import { buildW10 } from '../../scripts/bakeoff/make-session.mjs'

const GEO = { clientW: 1440, clientH: 900, dpi: 96, cellW: 7.8, cellH: 15 }
const mods = { ctrl: false, alt: false, shift: false }

describe('controller: session', () => {
  it('offers the restore card for a saved window and restores 9 tabs and 10 panes on Restore', async () => {
    const f = fakeDeps()
    f.handlers['session:load'] = () => buildW10('/Users/joshwald')
    f.handlers['projects:sessionIds'] = () => ({ ids: {}, sources: {} })
    f.handlers['projects:resumeModes'] = () => ({ modes: {}, bypassConsented: false })
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    expect(c.model().restore).toMatchObject({ tabs: 9, panes: 10 })
    c.event({ type: 'click', target: 'restore:yes', x: 0, y: 0, button: 0, mods })
    await new Promise((r) => setTimeout(r, 10))
    expect(c.model().restore).toBeNull()
    expect(c.model().tabs).toHaveLength(9)
    expect(c.state().tabs.reduce((n, t) => n + Object.keys(t.panes).length, 0)).toBe(10)
    expect(f.sent.filter(([ch]) => ch === 'pty:spawn')).toHaveLength(10)
  })
  it('Start fresh clears the snapshot and opens one tab', async () => {
    const f = fakeDeps()
    f.handlers['session:load'] = () => buildW10('/Users/joshwald')
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.event({ type: 'key', target: 'restore', key: 'Escape', mods })
    await new Promise((r) => setTimeout(r, 10))
    expect(f.sent.some(([ch]) => ch === 'session:clear')).toBe(true)
    expect(c.model().tabs).toHaveLength(1)
  })
  it('snapshots every 30 s only when changed and at once on session:requestSnapshot', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const saves = () => f.sent.filter(([ch]) => ch === 'session:save').length
    f.advance(30_000); await new Promise((r) => setImmediate(r))
    const n = saves()
    f.advance(30_000); await new Promise((r) => setImmediate(r))
    expect(saves()).toBe(n)
    c.command('tab.new'); f.advance(30_000); await new Promise((r) => setImmediate(r))
    expect(saves()).toBe(n + 1)
    c.push('session:requestSnapshot', undefined); await new Promise((r) => setImmediate(r))
    expect(saves()).toBe(n + 2)
  })
})
