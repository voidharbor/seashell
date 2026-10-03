import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHIP_BY_EXT, ExplorerState } from '../../src/core/controller/explorer.js'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const entry = (name: string, isDir: boolean, ignored = false) => ({ name, isDir, isSymlink: false, size: 0, mtimeMs: 0, ignored })
const mods = { ctrl: false, alt: false, shift: false }
const tick = () => new Promise((r) => setImmediate(r))

describe('explorer rows', () => {
  it('lists the root as Home and dims ignored entries', () => {
    const x = new ExplorerState('/Users/joshwald')
    x.applyListing('/Users/joshwald', { ok: true, entries: [entry('dist', true, true), entry('a.ts', false)], truncated: false })
    x.toggle('/Users/joshwald')
    const rows = x.rows()
    expect(rows.map((r) => [r.name, r.depth, r.ignored, r.chip !== null])).toEqual([['Home', 0, false, false], ['dist', 1, true, false], ['a.ts', 1, false, true]])
  })
  it('shows an error row for a directory that failed and the truncated line', () => {
    const x = new ExplorerState('/r')
    x.applyListing('/r', { ok: true, entries: [entry('gone', true), entry('big', true)], truncated: false })
    x.toggle('/r'); x.toggle('/r/gone'); x.toggle('/r/big')
    x.applyListing('/r/gone', { ok: false, error: 'ENOENT' })
    x.applyListing('/r/big', { ok: true, entries: [entry('x', false)], truncated: true })
    const rows = x.rows()
    expect(rows.find((r) => r.path === '/r/gone')?.error).toBe('(ENOENT)')
    expect(rows.find((r) => r.path === '/r/big/x')?.truncatedAfter).toBe(true)
  })
  it('watches expanded directories that are not ignored and unsubscribes on collapse', () => {
    const x = new ExplorerState('/r')
    x.applyListing('/r', { ok: true, entries: [entry('src', true), entry('dist', true, true)], truncated: false })
    x.toggle('/r')
    expect(x.watchDiff(new Set())).toEqual({ subscribe: ['/r'], unsubscribe: [] })
    x.toggle('/r/src'); x.toggle('/r/dist')
    expect(x.watchDiff(new Set(['/r'])).subscribe).toEqual(['/r/src'])   // dist is ignored
    x.toggle('/r/src')
    expect(x.watchDiff(new Set(['/r', '/r/src'])).unsubscribe).toEqual(['/r/src'])
  })
  it('maps the real error envelope to (CODE) and shows it only while the directory is expanded', () => {
    const x = new ExplorerState('/r')
    x.applyListing('/r', { ok: true, entries: [entry('locked', true)], truncated: false })
    x.toggle('/r')
    x.applyListing('/r/locked', { ok: false, code: 'EACCES', message: 'permission denied' })
    expect(x.rows().find((r) => r.path === '/r/locked')?.error).toBeNull()
    x.toggle('/r/locked')
    expect(x.rows().find((r) => r.path === '/r/locked')?.error).toBe('(EACCES)')
  })
  it('puts the truncated line after the whole subtree when the last entry is an open directory', () => {
    const x = new ExplorerState('/r')
    x.applyListing('/r', { ok: true, entries: [entry('a', false), entry('z', true)], truncated: true })
    x.applyListing('/r/z', { ok: true, entries: [entry('deep.md', false)], truncated: false })
    x.toggle('/r'); x.toggle('/r/z')
    const rows = x.rows()
    expect(rows.map((r) => r.path)).toEqual(['/r', '/r/a', '/r/z', '/r/z/deep.md'])
    expect(rows.filter((r) => r.truncatedAfter).map((r) => r.path)).toEqual(['/r/z/deep.md'])
  })
  it('gives files their extension chip from the copied table and never a prototype key', () => {
    expect(CHIP_BY_EXT.get('ts')).toBe('#3178C6')
    const x = new ExplorerState('/r', '/home')
    x.applyListing('/r', { ok: true, entries: [entry('src', true), entry('README.MD', false), entry('x.constructor', false), entry('.bashrc', false)], truncated: false })
    x.toggle('/r')
    const rows = x.rows()
    expect(rows[0]!.name).toBe('r')   // not home, so the folder's own name
    expect(rows.map((r) => r.chip)).toEqual([null, null, '#5E9CD6', null, null])
  })
  it('a lost watch stays subscribed so it is never asked for again', () => {
    const x = new ExplorerState('/r')
    x.toggle('/r')
    x.subscribed.add('/r')
    x.markLost('/r')
    expect(x.watchDiff(x.subscribed)).toEqual({ subscribe: [], unsubscribe: [] })
    expect(x.rows()).toHaveLength(1)
  })
  it('never watches node_modules or .git even when a reveal expanded them', () => {
    const x = new ExplorerState('/r')
    x.expand('/r'); x.expand('/r/node_modules'); x.expand('/r/node_modules/pkg'); x.expand('/r/.git')
    expect(x.watchDiff(new Set()).subscribe).toEqual(['/r'])
  })
  it('revealChain stops at the parent for a file and includes a directory itself', () => {
    const x = new ExplorerState('/r')
    expect(x.revealChain('/r/a/b.ts', false, '/r')).toEqual(['/r', '/r/a'])
    expect(x.revealChain('/r/a/b', true, '/r')).toEqual(['/r', '/r/a', '/r/a/b'])
    expect(x.revealChain('/etc/hosts', false, '/r')).toEqual([])
  })
})

describe('explorer in the controller', () => {
  it('toggles the sidebar, reads home, and re-reads a changed directory while it is expanded', async () => {
    const f = fakeDeps()
    const reads: string[] = []
    f.handlers['fs:readDir'] = (p) => { reads.push((p as { path: string }).path); return { ok: true, entries: [entry('src', true)], truncated: false } }
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    await Promise.resolve(); await Promise.resolve()
    expect(reads).toEqual(['/Users/joshwald'])
    expect(c.model().sidebar.visible).toBe(true)
    expect(c.model().sidebar.rows[0]).toMatchObject({ name: 'Home', depth: 0 })
    expect(f.sent.filter(([ch]) => ch === 'watch:subscribe').map(([, p]) => p)).toEqual([{ dir: '/Users/joshwald' }])
    c.push('watch:changed', { dir: '/Users/joshwald' })
    await Promise.resolve(); await Promise.resolve()
    expect(reads).toHaveLength(2)
    c.push('watch:lost', { dir: '/Users/joshwald' })   // nothing happens, nothing throws
    expect(c.model().sidebar.rows).toHaveLength(2)
  })
  it('reveal opens the sidebar, expands the chain, selects and flashes the row, then toasts for a path outside the root', async () => {
    const f = fakeDeps()
    f.handlers['fs:readDir'] = (p) => {
      const path = (p as { path: string }).path
      return { ok: true, entries: path === '/Users/joshwald' ? [entry('seashell-wt', true)] : path === '/Users/joshwald/seashell-wt' ? [entry('redesign', true)] : [entry('README.md', false)], truncated: false }
    }
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0', chords: [] })
    await c.boot(GEO)
    await c.reveal('/Users/joshwald/seashell-wt/redesign/README.md', false)
    const sb = c.model().sidebar
    expect(sb.visible).toBe(true)
    expect(sb.revealRowId).toBe('row:/Users/joshwald/seashell-wt/redesign/README.md')
    expect(sb.rows.find((r) => r.id === sb.revealRowId)).toMatchObject({ selected: true, flashing: true })
    f.advance(2600)
    expect(c.model().sidebar.rows.find((r) => r.id === sb.revealRowId)?.flashing).toBe(false)
    await c.reveal('/etc/hosts', false)
    expect(c.model().toast).toBe('/etc/hosts is outside the file explorer')
  })
  it('the grip resizes between 170 and 620 DIP and double-click resets to 260', async () => {
    const f = fakeDeps('/h')
    f.handlers['fs:readDir'] = () => ({ ok: true, entries: [], truncated: false })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    c.event({ type: 'down', target: 'sidebar:grip', x: 260, y: 100, button: 0, mods })
    c.event({ type: 'move', target: 'sidebar:grip', x: 900, y: 100, button: 0, mods })
    c.event({ type: 'up', target: 'sidebar:grip', x: 900, y: 100, button: 0, mods })
    expect(c.model().sidebar.width).toBe(620)
    c.event({ type: 'dblclick', target: 'sidebar:grip', x: 0, y: 0, button: 0, mods })
    expect(c.model().sidebar.width).toBe(260)
    expect(c.model().panes[0]!.rect.x).toBeGreaterThanOrEqual(266)   // the grid area starts after the column and grip
  })
  it('lays the column, the grip and the grid side by side and gives the grid back on hide', async () => {
    const f = fakeDeps('/h')
    f.handlers['fs:readDir'] = () => ({ ok: true, entries: [], truncated: false })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const before = c.model().panes[0]!.rect
    expect(before.x).toBe(0)
    c.command('explorer.toggle')
    const sb = c.model().sidebar
    expect(sb.rect).toEqual({ x: 0, y: 38, w: 260, h: 900 - 38 - 28 })
    expect(sb.gripRect).toEqual({ x: 260, y: 38, w: 6, h: 900 - 38 - 28 })
    expect(c.model().panes[0]!.rect).toMatchObject({ x: 266, w: 1440 - 266 })
    expect(f.sent.some(([ch]) => ch === 'pty:resize')).toBe(true)
    c.command('explorer.toggle')
    expect(c.model().sidebar.visible).toBe(false)
    expect(c.model().sidebar.rows).toEqual([])
    expect(c.model().panes[0]!.rect).toEqual(before)
  })
  it('persists the width on release only, as a base width divided by the UI scale', async () => {
    const f = fakeDeps('/h')
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'seashell-explorer-'))
    try {
      f.handlers['app:getPaths'] = () => ({ home: '/h', hostname: 'jarvis', userData: ud, defaultShell: '/usr/bin/zsh', cwdOfLaunch: '/h', platform: 'win32', host: 'native' })
      f.handlers['fs:readDir'] = () => ({ ok: true, entries: [], truncated: false })
      const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
      await c.boot(GEO)
      c.command('ui.zoomIn')   // uiScale 1.1
      fs.rmSync(path.join(ud, 'ui-state.json'), { force: true })
      c.command('explorer.toggle')
      c.event({ type: 'down', target: 'sidebar:grip', x: 286, y: 100, button: 0, mods })
      c.event({ type: 'move', target: 'sidebar:grip', x: 330, y: 100, button: 0, mods })
      expect(c.model().sidebar.width).toBe(300)
      expect(c.model().sidebar.rect.w).toBeCloseTo(330)
      expect(fs.existsSync(path.join(ud, 'ui-state.json'))).toBe(false)
      c.event({ type: 'up', target: 'sidebar:grip', x: 330, y: 100, button: 0, mods })
      expect(JSON.parse(fs.readFileSync(path.join(ud, 'ui-state.json'), 'utf8')).sidebarWidth).toBe(300)
    } finally {
      fs.rmSync(ud, { recursive: true, force: true })
    }
  })
  it('expanding reads and watches a directory, collapsing unwatches it, refresh re-reads every expanded one', async () => {
    const f = fakeDeps('/h')
    const reads: string[] = []
    f.handlers['fs:readDir'] = (p) => {
      const at = (p as { path: string; respectGitignore: boolean })
      expect(at.respectGitignore).toBe(true)
      reads.push(at.path)
      return { ok: true, entries: at.path === '/h' ? [entry('src', true), entry('dist', true, true), entry('a.ts', false)] : [entry('x.ts', false)], truncated: false }
    }
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    await tick()
    c.event({ type: 'click', target: 'sidebar:twisty:/h/src', x: 0, y: 0, button: 0, mods })
    c.event({ type: 'dblclick', target: 'sidebar:row:/h/dist', x: 0, y: 0, button: 0, mods })
    await tick()
    expect(reads).toEqual(['/h', '/h/src', '/h/dist'])
    const sb = c.model().sidebar
    expect(sb.rows.map((r) => [r.path, r.depth, r.expanded])).toEqual([
      ['/h', 0, true], ['/h/src', 1, true], ['/h/src/x.ts', 2, false], ['/h/dist', 1, true], ['/h/dist/x.ts', 2, false], ['/h/a.ts', 1, false],
    ])
    // The twisty toggles without selecting; the strip shows the root until a row is selected.
    expect(sb.rows.some((r) => r.selected)).toBe(false)
    expect(sb.strip).toBe('/h')
    const subs = () => f.sent.filter(([ch]) => ch === 'watch:subscribe').map(([, p]) => (p as { dir: string }).dir)
    expect(subs()).toEqual(['/h', '/h/src'])   // dist is gitignored: expandable, never watched
    c.event({ type: 'click', target: 'sidebar:twisty:/h/src', x: 0, y: 0, button: 0, mods })
    expect(f.sent.filter(([ch]) => ch === 'watch:unsubscribe').map(([, p]) => p)).toEqual([{ dir: '/h/src' }])
    reads.length = 0
    c.command('explorer.refresh')
    await tick()
    expect(reads.sort()).toEqual(['/h', '/h/dist'])
    c.event({ type: 'click', target: 'sidebar:refresh', x: 0, y: 0, button: 0, mods })
    await tick()
    expect(reads).toHaveLength(4)
  })
  it('a watch change on a collapsed directory is ignored, and hiding unwatches everything', async () => {
    const f = fakeDeps('/h')
    const reads: string[] = []
    f.handlers['fs:readDir'] = (p) => { reads.push((p as { path: string }).path); return { ok: true, entries: [entry('src', true)], truncated: false } }
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    await tick()
    c.push('watch:changed', { dir: '/h/src' })
    c.push('watch:changed', { dir: 42 })
    await tick()
    expect(reads).toEqual(['/h'])
    c.command('explorer.toggle')
    expect(f.sent.filter(([ch]) => ch === 'watch:unsubscribe').map(([, p]) => p)).toEqual([{ dir: '/h' }])
    c.push('watch:changed', { dir: '/h' })
    c.command('explorer.refresh')
    await tick()
    expect(reads).toEqual(['/h'])
  })
  it('a lost watch reported inside subscribe neither throws nor resubscribes', async () => {
    const f = fakeDeps('/h')
    f.handlers['fs:readDir'] = () => ({ ok: true, entries: [], truncated: false })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    const send = f.deps.send
    f.deps.send = (ch, p) => {
      send(ch, p)
      if (ch === 'watch:subscribe') c.push('watch:lost', p)
    }
    await c.boot(GEO)
    c.command('explorer.toggle')
    await tick()
    c.command('explorer.refresh')
    await tick()
    expect(f.sent.filter(([ch]) => ch === 'watch:subscribe')).toHaveLength(1)
  })
  it('a directory that vanished shows (ENOENT) and a stale listing never overwrites a newer one', async () => {
    const f = fakeDeps('/h')
    const pending: Array<(v: unknown) => void> = []
    f.handlers['fs:readDir'] = (p) => {
      const dir = (p as { path: string }).path
      if (dir === '/h') return { ok: true, entries: [entry('gone', true), entry('a', true)], truncated: false }
      if (dir === '/h/gone') return { ok: false, code: 'ENOENT', message: 'no such directory' }
      return new Promise((r) => pending.push(r))
    }
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    await tick()
    c.event({ type: 'dblclick', target: 'sidebar:row:/h/gone', x: 0, y: 0, button: 0, mods })
    await tick()
    expect(c.model().sidebar.rows.find((r) => r.path === '/h/gone')).toMatchObject({ expanded: true, error: '(ENOENT)' })
    c.event({ type: 'dblclick', target: 'sidebar:row:/h/a', x: 0, y: 0, button: 0, mods })
    c.push('watch:changed', { dir: '/h/a' })
    expect(pending).toHaveLength(2)
    pending[1]!({ ok: true, entries: [entry('new.ts', false)], truncated: false })
    await tick()
    pending[0]!({ ok: true, entries: [entry('old.ts', false)], truncated: false })
    await tick()
    expect(c.model().sidebar.rows.map((r) => r.name)).toContain('new.ts')
    expect(c.model().sidebar.rows.map((r) => r.name)).not.toContain('old.ts')
  })
  it('clicks select, a double-click on a file opens it in a file pane', async () => {
    const f = fakeDeps('/h')
    f.handlers['fs:readDir'] = () => ({ ok: true, entries: [entry('a.ts', false)], truncated: false })
    f.handlers['fs:probe'] = () => ({ exists: true, isDir: false, size: 1, ext: 'ts', route: 'viewer' })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    await tick()
    c.event({ type: 'click', target: 'sidebar:row:/h/a.ts', x: 0, y: 0, button: 0, mods })
    expect(c.model().sidebar.rows.find((r) => r.path === '/h/a.ts')?.selected).toBe(true)
    expect(c.model().sidebar.strip).toBe('/h/a.ts')
    c.event({ type: 'dblclick', target: 'sidebar:row:/h/a.ts', x: 0, y: 0, button: 0, mods })
    await tick()
    expect(c.model().panes.filter((p) => p.kind === 'file').map((p) => [p.label, p.focused])).toEqual([['a.ts', true]])
    expect(f.sent.some(([ch]) => ch.startsWith('open:'))).toBe(false)
    // The root row double-click collapses it.
    c.event({ type: 'dblclick', target: 'sidebar:row:/h', x: 0, y: 0, button: 0, mods })
    expect(c.model().sidebar.rows).toHaveLength(1)
  })
  it('the strip copies the shown path through clip:write and says so', async () => {
    const f = fakeDeps('/h')
    const shellCalls: Array<[string, unknown]> = []
    let clipOk = true
    f.deps.invokeShell = async <T = unknown>(ch: string, p: unknown): Promise<T> => {
      shellCalls.push([ch, p])
      return (clipOk ? { ok: true } : { ok: false, error: 'clipboard busy' }) as T
    }
    f.handlers['fs:readDir'] = () => ({ ok: true, entries: [], truncated: false })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    c.event({ type: 'click', target: 'sidebar:strip', x: 0, y: 0, button: 0, mods })
    await tick()
    expect(shellCalls).toEqual([['clip:write', { text: '/h' }]])
    expect(c.model().toast).toBe('Copied path')
    clipOk = false
    c.event({ type: 'click', target: 'sidebar:strip', x: 0, y: 0, button: 0, mods })
    await tick()
    expect(c.model().toast).toBe('Could not copy the path')
  })
  it('a right click opens the menu at the point; Escape, or a press elsewhere, closes it', async () => {
    const f = fakeDeps('/h')
    f.handlers['fs:readDir'] = () => ({ ok: true, entries: [entry('src', true), entry('a.ts', false)], truncated: false })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    await tick()
    c.event({ type: 'click', target: 'sidebar:row:/h/src', x: 40, y: 120, button: 2, mods })
    const menu = c.model().sidebar.menu
    expect(menu).toEqual({
      rowId: 'row:/h/src', x: 40, y: 120,
      items: [{ id: 'open-outside', label: 'Open Outside SeaShell', enabled: false }, { id: 'reveal', label: 'Reveal in Finder', enabled: true }],
    })
    expect(c.model().sidebar.rows.find((r) => r.path === '/h/src')?.selected).toBe(true)
    // A disabled item does nothing and leaves the menu up.
    c.event({ type: 'click', target: 'sidebar:menu:open-outside', x: 0, y: 0, button: 0, mods })
    expect(c.model().sidebar.menu).not.toBeNull()
    c.event({ type: 'key', target: 'sidebar:menu', key: 'Escape', mods })
    expect(c.model().sidebar.menu).toBeNull()
    c.event({ type: 'click', target: 'sidebar:row:/h/a.ts', x: 50, y: 140, button: 2, mods })
    expect(c.model().sidebar.menu?.items[0]!.enabled).toBe(true)
    c.event({ type: 'down', target: 'sidebar:menu:reveal', x: 0, y: 0, button: 0, mods })
    expect(c.model().sidebar.menu).not.toBeNull()
    const id = c.model().panes[0]!.id
    c.event({ type: 'down', target: `pane:${id}:grid`, x: 600, y: 300, button: 0, mods })
    expect(c.model().sidebar.menu).toBeNull()
  })
  it('the menu reveals in the file manager and opens a file outside SeaShell through openPath', async () => {
    const f = fakeDeps('/h')
    f.handlers['fs:readDir'] = () => ({ ok: true, entries: [entry('run.sh', false), entry('doc.pdf', false)], truncated: false })
    f.handlers['fs:probe'] = () => ({ exists: true, isDir: false, size: 1, ext: 'pdf', route: 'viewer' })
    f.handlers['open:revealInFinder'] = () => ({ ok: true })
    f.handlers['open:withDefaultApp'] = (p) => ((p as { path: string }).path.endsWith('.sh') ? { ok: false, error: 'refused-executable' } : { ok: true })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    await tick()
    c.event({ type: 'click', target: 'sidebar:row:/h/doc.pdf', x: 10, y: 10, button: 2, mods })
    c.event({ type: 'click', target: 'sidebar:menu:reveal', x: 10, y: 10, button: 0, mods })
    expect(c.model().sidebar.menu).toBeNull()
    expect(f.sent).toContainEqual(['open:revealInFinder', { path: '/h/doc.pdf' }])
    c.event({ type: 'click', target: 'sidebar:row:/h/doc.pdf', x: 10, y: 10, button: 2, mods })
    c.event({ type: 'click', target: 'sidebar:menu:open-outside', x: 10, y: 10, button: 0, mods })
    await tick()
    // force 'os' skips the viewer route the probe answered.
    expect(f.sent).toContainEqual(['open:withDefaultApp', { path: '/h/doc.pdf' }])
    c.event({ type: 'click', target: 'sidebar:row:/h/run.sh', x: 10, y: 10, button: 2, mods })
    c.event({ type: 'click', target: 'sidebar:menu:open-outside', x: 10, y: 10, button: 0, mods })
    await tick()
    expect(c.model().toast).toBe('That file is executable, revealed in Finder instead')
  })
  it('reveal of a directory expands it, and a new reveal restarts the flash', async () => {
    const f = fakeDeps('/h')
    f.handlers['fs:readDir'] = (p) => {
      const dir = (p as { path: string }).path
      return { ok: true, entries: dir === '/h' ? [entry('src', true), entry('b.md', false)] : dir === '/h/src' ? [entry('lib', true)] : [entry('c.ts', false)], truncated: false }
    }
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    await c.reveal('/h/src/lib', true)
    let sb = c.model().sidebar
    expect(sb.rows.find((r) => r.path === '/h/src/lib')).toMatchObject({ expanded: true, selected: true, flashing: true })
    expect(sb.rows.map((r) => r.path)).toContain('/h/src/lib/c.ts')
    const seq = sb.revealSeq
    f.advance(2000)
    await c.reveal('/h/b.md', false)
    sb = c.model().sidebar
    expect(sb.revealSeq).toBe(seq + 1)
    expect(sb.strip).toBe('/h/b.md')
    f.advance(1000)   // the first flash's timer would have fired here
    expect(c.model().sidebar.rows.find((r) => r.path === '/h/b.md')?.flashing).toBe(true)
    expect(c.model().sidebar.rows.find((r) => r.path === '/h/src/lib')?.flashing).toBe(false)
    f.advance(1600)
    expect(c.model().sidebar.rows.some((r) => r.flashing)).toBe(false)
  })
  it('a path outside the root only toasts, without opening the sidebar', async () => {
    const f = fakeDeps('/h')
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    await c.reveal('/hx/file', false)
    expect(c.model().toast).toBe('/hx/file is outside the file explorer')
    expect(c.model().sidebar.visible).toBe(false)
    expect(f.sent.some(([ch]) => ch === 'fs:readDir')).toBe(false)
  })
  it('the sidebar model has defaults while hidden and the toggle no longer toasts phase 2', async () => {
    const f = fakeDeps('/h')
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    expect(c.model().sidebar).toEqual({
      visible: false, rect: { x: 0, y: 0, w: 0, h: 0 }, gripRect: { x: 0, y: 0, w: 0, h: 0 }, width: 260,
      rows: [], revealSeq: 0, revealRowId: null, strip: '', menu: null,
    })
    c.command('explorer.refresh')
    expect(c.model().toast).toBeNull()
    c.event({ type: 'click', target: 'sidebar:row:/h', x: 0, y: 0, button: 0, mods })
    c.event({ type: 'down', target: 'sidebar:grip', x: 400, y: 0, button: 0, mods })
    c.event({ type: 'move', target: 'sidebar:grip', x: 500, y: 0, button: 0, mods })
    expect(c.model().sidebar.width).toBe(260)
  })
})
