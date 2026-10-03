import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }

describe('drawer', () => {
  it('spawns one shell per pane lazily in the pane cwd and shows it under the grid area', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const pane = c.model().panes[0]!
    c.term({ type: 'cwd', paneId: pane.id, cwd: '/h/proj' })
    c.command('drawer.toggle')
    await Promise.resolve()
    const spawns = f.sent.filter(([ch]) => ch === 'pty:spawn').map(([, p]) => p as { paneId: string; cwd: string })
    expect(spawns.at(-1)).toMatchObject({ paneId: `drawer:${pane.id}`, cwd: '/h/proj' })
    const d = c.model().drawer
    expect(d.open).toBe(true)
    expect(d.ptyId).toBe(`drawer:${pane.id}`)
    expect(d.header.label).toBe(`Shell · ${c.model().panes[0]!.label}`)   // the live label, which the cwd above made 'proj'
    expect(d.rect.y + d.rect.h).toBeCloseTo(pane.rect.y + pane.rect.h, 0)   // flush with the bottom of the grid area
    expect(c.model().panes[0]!.rect).toEqual(pane.rect)                       // pane rects do not change
    c.command('drawer.toggle'); c.command('drawer.toggle')
    expect(f.sent.filter(([ch]) => ch === 'pty:spawn')).toHaveLength(spawns.length)   // no second spawn
  })
  it('cd to pane types Ctrl+U, the quoted cd and CR, and only when the cwds differ', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const pane = c.model().panes[0]!
    c.term({ type: 'cwd', paneId: pane.id, cwd: "/h/it's here" })
    c.command('drawer.toggle')
    await Promise.resolve()
    c.term({ type: 'cwd', paneId: `drawer:${pane.id}`, cwd: '/h' })
    expect(c.model().drawer.header.showCd).toBe(true)
    c.event({ type: 'click', target: 'drawer:cd', x: 0, y: 0, button: 0, mods })
    const writes = f.sent.filter(([ch]) => ch === 'pty:write').map(([, p]) => p as { paneId: string; data: string })
    expect(writes.at(-1)).toEqual({ paneId: `drawer:${pane.id}`, data: "\x15cd '/h/it'\\''s here'\r" })
    c.term({ type: 'cwd', paneId: `drawer:${pane.id}`, cwd: "/h/it's here" })
    expect(c.model().drawer.header.showCd).toBe(false)
  })
  it('a closing pane kills its drawer shell, and the grip clamps the height', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const pane = c.model().panes[0]!
    c.command('drawer.toggle')
    await Promise.resolve()
    c.event({ type: 'down', target: 'drawer:grip', x: 0, y: 500, button: 0, mods })
    c.event({ type: 'move', target: 'drawer:grip', x: 0, y: 0, button: 0, mods })
    c.event({ type: 'up', target: 'drawer:grip', x: 0, y: 0, button: 0, mods })
    expect(c.model().drawer.height).toBe(800)
    c.command('pane.close')
    await Promise.resolve(); await Promise.resolve()
    const kills = f.sent.filter(([ch]) => ch === 'pty:kill').map(([, p]) => (p as { paneId: string }).paneId)
    expect(kills).toContain(`drawer:${pane.id}`)
    expect(f.grid().some((g) => g.op === 'dispose' && g.paneId === `drawer:${pane.id}`)).toBe(true)
  })
  it('closing hands the keyboard back to the pane, and a shell that exited respawns on the next open', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const pane = c.model().panes[0]!
    c.command('drawer.toggle')
    await Promise.resolve()
    expect(c.model().drawer.focused).toBe(true)
    c.event({ type: 'click', target: 'drawer:close', x: 0, y: 0, button: 0, mods })
    expect(c.model().drawer.open).toBe(false)
    expect(f.grid().at(-1)).toEqual({ paneId: pane.id, op: 'focus' })
    c.command('drawer.toggle')
    c.push('pty:exit', { paneId: `drawer:${pane.id}`, exitCode: 0, signal: 0 })
    expect(c.model().drawer.status).toBe('exited')
    expect(c.model().panes[0]!.status).not.toBe('exited')
    const spawns = () => f.sent.filter(([ch]) => ch === 'pty:spawn').length
    const before = spawns()
    c.command('drawer.toggle'); c.command('drawer.toggle')
    expect(spawns()).toBe(before + 1)
    expect(c.model().drawer.status).toBe('starting')
  })
  it('a drawer shell that exits is not a pane exit, and the next open respawns it', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const pane = c.model().panes[0]!
    c.command('drawer.toggle')
    await Promise.resolve()
    const spawns = () => f.sent.filter(([ch, p]) => ch === 'pty:spawn' && (p as { paneId: string }).paneId === `drawer:${pane.id}`).length
    expect(spawns()).toBe(1)
    c.push('pty:exit', { paneId: `drawer:${pane.id}`, exitCode: 1, signal: 0 })
    expect(c.model().drawer.status).toBe('exited')
    expect(c.state().tabs.flatMap((t) => Object.values(t.panes)).some((p) => p.status === 'exited')).toBe(false)
    expect(f.grid().some((g) => g.op === 'exited')).toBe(false)
    c.command('drawer.toggle')
    expect(c.model().drawer.open).toBe(false)
    c.command('drawer.toggle')
    await Promise.resolve()
    expect(spawns()).toBe(2)
    expect(c.model().drawer).toMatchObject({ open: true, paneId: pane.id, status: 'live' })
    expect(c.model().panes[0]!.status).not.toBe('exited')
  })
  it('a file pane taking focus leaves the drawer on the terminal it showed', async () => {
    const f = fakeDeps('/w')
    f.handlers['fs:statBatch'] = (p) => ({ results: (p as { candidates: string[] }).candidates.map((c, i) => ({ i, resolved: c, kind: 'file', size: 10, exec: false })) })
    f.handlers['fs:findBySuffix'] = () => ({ paths: [], truncated: false })
    f.handlers['fs:probe'] = (p) => ({ exists: true, isDir: false, size: 10, ext: 'md', route: 'viewer', path: (p as { path: string }).path })
    f.handlers['fs:readDir'] = () => ({ ok: true, entries: [{ name: 'README.md', isDir: false, isSymlink: false, size: 0, mtimeMs: 0, ignored: false }], truncated: false })
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    await Promise.resolve()
    const [first, second] = c.model().panes
    expect(second!.focused).toBe(true)
    c.command('drawer.toggle')
    await Promise.resolve()
    expect(c.model().drawer.paneId).toBe(second!.id)
    const line = 'see /w/README.md here'
    c.term({ type: 'pathclick', paneId: `drawer:${second!.id}`, line, index: line.indexOf('README'), mods: { ctrl: true, alt: false, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    expect(c.model().panes.find((p) => p.kind === 'file')?.focused).toBe(true)
    expect(c.model().drawer).toMatchObject({ open: true, paneId: second!.id, ptyId: `drawer:${second!.id}` })
    expect(f.sent.some(([ch, p]) => ch === 'pty:spawn' && (p as { paneId: string }).paneId === `drawer:${first!.id}`)).toBe(false)
  })
})
