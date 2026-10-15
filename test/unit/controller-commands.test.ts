import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

describe('controller: commands', () => {
  it('tab.new opens a tab at home and tab.close kills its panes', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('tab.new')
    expect(c.model().tabs).toHaveLength(2)
    expect(c.model().tabs[1]!.active).toBe(true)
    c.command('tab.close')
    expect(c.model().sheet?.kind).toBe('closeTab') // it asks first
    c.event({ type: 'click', target: 'sheet:closeTab:btn:close', x: 0, y: 0, button: 0, mods: { ctrl: false, alt: false, shift: false } })
    await new Promise((r) => setImmediate(r))
    expect(c.model().tabs).toHaveLength(1)
    expect(f.sent.some(([ch]) => ch === 'pty:kill')).toBe(true)
  })
  it('pane.new refuses the seventh pane with the toast', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    for (let i = 0; i < 6; i++) c.command('pane.new')
    expect(c.model().panes).toHaveLength(6)
    expect(c.model().tabFull).toBe(true)
    expect(c.model().toast).toBe('Tab is full (6 panes) - open a new tab (Ctrl+Shift+T)')
  })
  it('zoom in bumps fontPx and the badge, reset clears it', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('ui.zoomIn')
    expect(c.model().window.fontPx).toBe(16)
    // zoomPercent rounds 16/13 to 125%, the badge the renderer shows for this rung.
    expect(c.model().zoomBadge).toBe('125%')
    c.command('ui.zoomReset')
    expect(c.model().zoomBadge).toBeNull()
  })
  it('tab rename: double-click opens the field, Enter commits up to 40 chars, blank reverts', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const id = c.model().tabs[0]!.id
    const mods = { ctrl: false, alt: false, shift: false }
    c.event({ type: 'dblclick', target: `tab:${id}`, x: 0, y: 0, button: 0, mods })
    expect(c.model().tabs[0]!.renaming).toBe(true)
    c.event({ type: 'text', target: `tab:${id}:rename`, text: 'x'.repeat(50) })
    c.event({ type: 'key', target: `tab:${id}:rename`, key: 'Enter', mods })
    expect(c.model().tabs[0]!.name).toBe('x'.repeat(40))
    c.event({ type: 'dblclick', target: `tab:${id}`, x: 0, y: 0, button: 0, mods })
    c.event({ type: 'text', target: `tab:${id}:rename`, text: '' })
    c.event({ type: 'key', target: `tab:${id}:rename`, key: 'Enter', mods })
    expect(c.model().tabs[0]!.name).toBe('~')
  })
  it('a toast clears after 3.2 s', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.push('app:toast', { message: 'hello' })
    expect(c.model().toast).toBe('hello')
    f.advance(3300)
    expect(c.model().toast).toBeNull()
  })
  it('pane.close reaps the focused pane, disposes its grid and toasts survivors', async () => {
    const f = fakeDeps()
    f.handlers['pty:kill'] = () => ({ ok: false, survivors: 2 })
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const focused = c.model().panes.find((p) => p.focused)!.id
    c.command('pane.close')
    await new Promise((r) => setImmediate(r))
    expect(c.model().panes.map((p) => p.id)).not.toContain(focused)
    expect(f.sent).toContainEqual(['pty:kill', { paneId: focused }])
    expect(f.grid()).toContainEqual({ paneId: focused, op: 'dispose' })
    expect(c.model().toast).toBe('2 process(es) could not be reaped')
  })
})
