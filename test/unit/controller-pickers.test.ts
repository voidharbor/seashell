import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, t: string) => c.event({ type: 'click', target: t, x: 0, y: 0, button: 0, mods })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('pickers and the ping', () => {
  it('the colour popover tags a pane, and picking the same colour clears it', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    click(c, `pane:${id}:color`)
    expect(c.model().popover).toMatchObject({ kind: 'color', paneId: id })
    expect(c.model().popover!.items).toHaveLength(8)
    click(c, 'popover:blue')
    expect(c.model().popover).toBeNull()
    expect(c.model().panes[0]!.color).toMatch(/^#/)
    click(c, `pane:${id}:color`); click(c, 'popover:blue')
    expect(c.model().panes[0]!.color).toBeNull()
  })
  it('linking two agent panes ensures the notes file and briefs both; a non-agent pane is disabled', async () => {
    const f = fakeDeps()
    f.handlers['links:ensure'] = () => ({ path: '/mnt/c/ud/links/abc.md' })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const [a, b] = c.model().panes.map((p) => p.id)
    c.push('metrics:tick', { panes: [{ paneId: a, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'claude', procCount: 1, cwd: '/h' }, { paneId: b, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'zsh', procCount: 1, cwd: '/h' }], system: null })
    click(c, `pane:${a}:link`)
    expect(c.model().popover!.items[0]).toMatchObject({ disabled: true, note: 'no agent' })
    c.push('metrics:tick', { panes: [{ paneId: a, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'claude', procCount: 1, cwd: '/h' }, { paneId: b, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'claude', procCount: 1, cwd: '/h' }], system: null })
    click(c, `pane:${a}:link`); click(c, `popover:${b}`); await flush()
    const writes = f.sent.filter(([ch]) => ch === 'pty:write').map(([, p]) => p as { paneId: string; data: string })
    expect(writes.filter((w) => w.data.startsWith('\x15') && w.data.endsWith('\r') && w.data.includes('abc.md')).map((w) => w.paneId).sort()).toEqual([a, b].sort())
    expect(c.model().toast).toBe('Panes are sharing notes')
    expect(c.model().panes.every((p) => p.linked)).toBe(true)
    click(c, `pane:${a}:link`)
    expect(c.model().popover!.items.at(-1)!.id).toBe('unlink')
  })
  it('Escape and a press outside close the popover; Stop sharing unlinks', async () => {
    const f = fakeDeps()
    f.handlers['links:ensure'] = () => ({ path: '/mnt/c/ud/links/abc.md' })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const [a, b] = c.model().panes.map((p) => p.id)
    const tick = { panes: [a, b].map((paneId) => ({ paneId, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'claude', procCount: 1, cwd: '/h' })), system: null }
    c.push('metrics:tick', tick)
    click(c, `pane:${a}:color`)
    c.event({ type: 'key', target: 'popover', key: 'Escape', mods })
    expect(c.model().popover).toBeNull()
    click(c, `pane:${a}:link`)
    expect(c.model().popover).toMatchObject({ kind: 'link', paneId: a, title: 'Share notes with' })
    expect(c.model().popover!.items[0]).toMatchObject({ id: b, disabled: false, note: null })
    c.event({ type: 'down', target: `pane:${b}:grid`, x: 0, y: 0, button: 0, mods })
    expect(c.model().popover).toBeNull()
    click(c, `pane:${a}:link`); click(c, `popover:${b}`); await flush()
    click(c, `pane:${a}:link`); click(c, 'popover:unlink')
    expect(c.model().panes.find((p) => p.id === a)!.linked).toBe(false)
    expect(c.model().panes.find((p) => p.id === b)!.linked).toBe(true)
  })
  it('pings once per 1.8 s on the way into attention, only with glow and sound on', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const unfocused = c.model().panes.find((p) => !p.focused)!.id
    // store.ts pane.bell ignores a pane the monitor has not classified, or one at a prompt.
    c.push('metrics:tick', { panes: [{ paneId: unfocused, footprintBytes: 0, cpuFrac: 0, state: 'WAITING', foregroundProcess: 'sleep', procCount: 2, cwd: '/h' }], system: null })
    const pings = () => f.shellOut.filter(([ch, p]) => ch === 'shell:cmd' && (p as { op: string }).op === 'ping').length
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(0)   // sound is off by default
    const focused = c.model().panes.find((p) => p.focused)!.id
    const focus = (id: string) => c.event({ type: 'down', target: `pane:${id}:grid`, x: 0, y: 0, button: 0, mods })
    c.command('app.settings'); click(c, 'sheet:settings:attentionSound'); c.event({ type: 'key', target: 'sheet:settings', key: 'Escape', mods })
    focus(unfocused); focus(focused)   // clears the first bell's attention
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(1)
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(1)
    focus(unfocused); focus(focused)
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(1)   // inside 1.8 s of the last ping
    f.advance(2000)
    focus(unfocused); focus(focused)
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(2)
    click(c, 'sleep')   // the moon: glow off silences the ping too
    f.advance(2000)
    focus(unfocused); focus(focused)
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(2)
  })
})
