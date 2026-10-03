import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

function setup() {
  const f = fakeDeps('/w')
  f.handlers['fs:statBatch'] = (p) => ({ results: (p as { candidates: string[] }).candidates.map((c, i) => ({ i, resolved: c.startsWith('/') ? c : `/w/${c}`, kind: /\/src\/?$/.test(c) ? 'dir' : 'file', size: 10, exec: false })) })
  f.handlers['fs:findBySuffix'] = () => ({ paths: [], truncated: false })
  f.handlers['fs:probe'] = (p) => ({ exists: true, isDir: false, size: 10, ext: 'md', route: 'viewer', path: (p as { path: string }).path })
  const e = (name: string, isDir: boolean) => ({ name, isDir, isSymlink: false, size: 0, mtimeMs: 0, ignored: false })
  f.handlers['fs:readDir'] = (p) => ({ ok: true, entries: (p as { path: string }).path === '/w' ? [e('src', true), e('README.md', false), e('notes.txt', false)] : [], truncated: false })
  f.handlers['open:withDefaultApp'] = () => ({ ok: true })
  return f
}
const line = 'see /w/README.md for details'
const idx = line.indexOf('README')

describe('path click gestures', () => {
  it('a plain double-click reveals and never opens', async () => {
    const f = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.term({ type: 'pathclick', paneId: c.model().panes[0]!.id, line, index: idx, mods: { ctrl: false, alt: false, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    expect(c.model().sidebar.visible).toBe(true)
    expect(c.model().sidebar.revealRowId).toBe('row:/w/README.md')
    expect(c.model().panes.every((p) => p.kind === 'term')).toBe(true)
  })
  it('Ctrl hands the file to the default app and never creates a pane', async () => {
    const f = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.term({ type: 'pathclick', paneId: c.model().panes[0]!.id, line, index: idx, mods: { ctrl: true, alt: false, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    expect(f.sent.some(([ch, p]) => ch === 'open:withDefaultApp' && (p as { path: string }).path === '/w/README.md')).toBe(true)
    expect(c.model().panes.every((p) => p.kind === 'term')).toBe(true)
  })
  it('the preview commands toast and open nothing', async () => {
    const f = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('preview.file')
    expect(c.model().toast).toBe('File previews are not in this build')
    expect(c.model().sidebar.visible).toBe(true)
    c.command('preview.web')
    expect(c.model().toast).toBe('Web previews are not in this build')
    expect(c.model().panes.every((p) => p.kind === 'term')).toBe(true)
    c.command('pane.closeAll')
    expect(c.model().toast).toBe('No preview panes open')
    expect(c.model().panes).toHaveLength(1)
  })
  it('Ctrl+Alt hands the file to the default app and toasts for an executable', async () => {
    const f = setup()
    f.handlers['open:withDefaultApp'] = () => ({ ok: false, error: 'refused-executable' })
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.term({ type: 'pathclick', paneId: c.model().panes[0]!.id, line, index: idx, mods: { ctrl: true, alt: true, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    expect(f.sent.some(([ch]) => ch === 'open:withDefaultApp')).toBe(true)
    expect(c.model().toast).toBe('That file is executable, revealed in Finder instead')
  })
  it('a directory is revealed and expanded whatever the modifiers', async () => {
    const f = setup()
    f.handlers['fs:probe'] = () => ({ exists: true, isDir: true, size: 0, ext: '', route: 'reveal' })
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.term({ type: 'pathclick', paneId: c.model().panes[0]!.id, line: 'in /w/src/ now', index: 4, mods: { ctrl: true, alt: false, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    expect(c.model().panes.every((p) => p.kind === 'term')).toBe(true)
    expect(c.model().sidebar.rows.find((r) => r.path === '/w/src')?.expanded).toBe(true)
  })
})
