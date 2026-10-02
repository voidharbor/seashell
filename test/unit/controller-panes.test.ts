import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps } from './controller-fakes.js'

const GEO = { clientW: 1440, clientH: 900, dpi: 96, cellW: 7.8, cellH: 15 }
const mods = { ctrl: false, alt: false, shift: false }

describe('controller: panes over time', () => {
  it('pty:exit shows the overlay and Restart respawns with a fresh grid', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    c.push('pty:exit', { paneId: id, exitCode: 1, signal: null, ranMs: 10 })
    expect(c.model().panes[0]).toMatchObject({ status: 'exited', exit: { text: 'exited · code 1', failed: true } })
    const creates = () => f.grid().filter((g) => g.op === 'create').length
    const before = creates()
    c.event({ type: 'click', target: `pane:${id}:restart`, x: 0, y: 0, button: 0, mods })
    await new Promise((r) => setImmediate(r))
    expect(f.grid().some((g) => g.op === 'dispose' && g.paneId === id)).toBe(true)
    expect(creates()).toBe(before + 1)
    expect(c.model().panes[0]!.status).not.toBe('exited')
  })
  it('a plain exit with signal 0 reads as exited, a real signal as killed', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    c.push('pty:exit', { paneId: id, exitCode: 0, signal: 0, ranMs: 10 })
    expect(c.model().panes[0]!.exit).toEqual({ text: 'exited · code 0', failed: false })
    c.push('pty:exit', { paneId: id, exitCode: 0, signal: 9, ranMs: 10 })
    expect(c.model().panes[0]!.exit!.text).toBe('killed · signal 9')
  })
  it('metrics drive the badge, the memory badge and the status bar', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    c.push('metrics:tick', { panes: [{ paneId: id, footprintBytes: 1.5 * 1024 ** 3, cpuFrac: 0, state: 'BUSY', foregroundProcess: 'claude', procCount: 3, cwd: '/Users/joshwald' }], system: { usedBytes: 20e9, totalBytes: 32e9, compressorBytes: 0, swapUsedBytes: 3e9, swapTotalBytes: 8e9, pressureLevel: 'warn' } })
    const p = c.model().panes[0]!
    expect(p.badge).toBe('claude')
    expect(p.memBadge).toBe('~1.5 GB')
    expect(p.memHigh).toBe(true)
    expect(c.model().status.swapWarn).toBe(true)
    expect(c.model().status.panes).toBe('1 pane')
  })
  it('attention: bell on an unfocused busy pane is waiting, PROMPT after BUSY is done and expires', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const other = c.model().panes.find((p) => !p.focused)!
    c.push('metrics:tick', { panes: [{ paneId: other.id, footprintBytes: 0, cpuFrac: 0, state: 'BUSY', foregroundProcess: 'claude', procCount: 1, cwd: '/' }], system: null })
    c.term({ type: 'bell', paneId: other.id })
    expect(c.model().panes.find((p) => p.id === other.id)!.attention).toBe('waiting')
    c.push('metrics:tick', { panes: [{ paneId: other.id, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'claude', procCount: 1, cwd: '/' }], system: null })
    expect(c.model().panes.find((p) => p.id === other.id)!.attention).toBe('done')
    f.advance(9100)
    expect(c.model().panes.find((p) => p.id === other.id)!.attention).toBe('none')
  })
  it('title and cwd events relabel the pane unless the label is custom', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    c.term({ type: 'cwd', paneId: id, cwd: '/Users/joshwald/Desktop/seashell' })
    expect(c.model().panes[0]!.label).toBe('seashell')
    c.term({ type: 'title', paneId: id, title: 'josh@jarvis: vim notes.md' })
    expect(c.model().panes[0]!.label).toBe('vim notes.md')
  })
  it('find opens on the focused pane, debounces the query, and Escape clears', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('edit.find')
    expect(c.model().find.open).toBe(true)
    c.event({ type: 'text', target: 'find:query', text: 'err' })
    expect(f.grid().filter((g) => g.op === 'find')).toHaveLength(0)
    f.advance(130)
    expect(f.grid().filter((g) => g.op === 'find').at(-1)).toMatchObject({ query: 'err', incremental: true, direction: 'next' })
    c.term({ type: 'findResult', paneId: c.model().panes[0]!.id, index: 2, total: 7, capped: false })
    expect(c.model().find.count).toEqual({ index: 2, total: 7, capped: false })
    c.event({ type: 'key', target: 'find:query', key: 'Escape', mods })
    expect(c.model().find.open).toBe(false)
    expect(f.grid().at(-1)).toMatchObject({ op: 'findClear' })
  })
})
