import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

// The expected strings are dropText's own (panes/drop.ts, test/unit/drop.test.ts):
// POSIX single quotes, space-joined, a trailing space.
describe('drop', () => {
  it('pastes quoted, mapped, space-joined paths with a trailing space and focuses the pane', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const other = c.model().panes.find((p) => !p.focused)!.id
    c.event({ type: 'drop', target: `pane:${other}:grid`, paths: ['C:\\Users\\josh\\My Docs\\a b.txt', '\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\x\'y.md'], text: null })
    const paste = f.grid().find((g) => g.op === 'paste' && g.paneId === other) as { text: string }
    expect(paste.text).toBe("'/mnt/c/Users/josh/My Docs/a b.txt' '/Users/joshwald/x'\\''y.md' ")
    expect(c.model().panes.find((p) => p.id === other)!.focused).toBe(true)
    expect(f.grid().at(-1)).toEqual({ paneId: other, op: 'focus' })
  })
  it('plain text that is a path is treated as one; other text is pasted as is; previews refuse', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    c.event({ type: 'drop', target: `pane:${id}:grid`, paths: [], text: 'file:///C:/t/one%20two.txt' })
    expect((f.grid().filter((g) => g.op === 'paste').at(-1) as { text: string }).text).toBe("'/mnt/c/t/one two.txt' ")
    c.event({ type: 'drop', target: `pane:${id}:grid`, paths: [], text: 'hello' })
    expect((f.grid().filter((g) => g.op === 'paste').at(-1) as { text: string }).text).toBe('hello')
    const n = f.grid().length
    c.event({ type: 'drop', target: `sidebar:empty`, paths: ['C:\\x'], text: null })
    c.event({ type: 'drop', target: `pane:${id}:view`, paths: ['C:\\x'], text: null })
    c.event({ type: 'drop', target: `pane:nope:grid`, paths: ['C:\\x'], text: null })
    c.event({ type: 'drop', target: `pane:${id}:grid`, paths: [], text: null })
    c.command('app.settings')
    c.event({ type: 'drop', target: `pane:${id}:grid`, paths: ['C:\\x'], text: null })
    expect(f.grid()).toHaveLength(n)
  })
  it('keeps non-ASCII paths whole and maps a share path to the Linux path', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    c.event({ type: 'drop', target: `pane:${id}:grid`, paths: ['C:\\Users\\josh\\Café\\ü.txt', '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\q'], text: null })
    expect((f.grid().filter((g) => g.op === 'paste').at(-1) as { text: string }).text).toBe("'/mnt/c/Users/josh/Café/ü.txt' /tmp/q ")
  })
  it('a drop on the drawer goes to its shell and gives it the keyboard', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const pane = c.model().panes[0]!
    c.command('drawer.toggle')
    await Promise.resolve()
    c.event({ type: 'click', target: `pane:${pane.id}:grid`, x: 0, y: 0, button: 0, mods: { ctrl: false, alt: false, shift: false } })
    expect(c.model().drawer.focused).toBe(false)
    c.event({ type: 'drop', target: 'drawer:grid', paths: ['C:\\a b'], text: null })
    expect(f.grid().filter((g) => g.op === 'paste').at(-1)).toEqual({ paneId: `drawer:${pane.id}`, op: 'paste', text: "'/mnt/c/a b' " })
    expect(c.model().drawer.focused).toBe(true)
  })
})
