import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { changeGroups, pageTheme, sessionFromLookup } from '../../src/core/controller/changes.js'
import type { ChangeEntry } from '../../src/shared/ipc.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const HOME = '/home/user'
const SID = '01a13d10-dbe9-7514-819f-26fe33fe4b2a'
const mods = { ctrl: false, alt: false, shift: false }
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r))
}

const entry = (over: Partial<ChangeEntry>): ChangeEntry => ({
  path: `${HOME}/proj/src/a.ts`,
  rel: 'src/a.ts',
  change: 'edited',
  added: 3,
  removed: 1,
  source: 'both',
  at: 1,
  ...over,
})

async function setup(entries: ChangeEntry[] = [], agent = true) {
  const f = fakeDeps(HOME)
  const list = { entries }
  f.handlers['projects:sessionIds'] = (p) => {
    const id = (p as { panes: Array<{ paneId: string }> }).panes[0]!.paneId
    return agent
      ? { ids: {}, sources: {}, agents: { [id]: { kind: 'jarvis', sid: SID, source: 'process' } }, agentsChecked: true }
      : { ids: {}, sources: {}, agentsChecked: true }
  }
  f.handlers['changes:watch'] = () => ({ ok: true })
  f.handlers['changes:list'] = (p) => ({
    paneId: (p as { paneId: string }).paneId,
    agent: 'jarvis',
    agentLabel: 'Jarvis',
    cwd: `${HOME}/proj`,
    entries: list.entries,
    note: null,
  })
  f.handlers['changes:file'] = (p) => ({
    ok: true,
    path: (p as { path: string }).path,
    rel: 'src/a.ts',
    change: 'edited',
    before: 'a\n',
    after: 'b\n',
    beforeKnown: true,
    binary: false,
    truncated: false,
  })
  f.handlers['open:externalHttp'] = () => ({ ok: true })
  f.handlers['open:withDefaultApp'] = () => ({ ok: true })
  f.handlers['fs:probe'] = () => ({ ok: true, kind: 'file', size: 1 })
  const c = new Controller(f.deps, { home: HOME, version: '0.6.0', chords: [] })
  await c.boot(GEO)
  const paneId = c.state().tabs[0]!.focusedPaneId!
  return { f, c, paneId, list }
}

describe('controller: the changes column', () => {
  it('stays away until the pane is full screen, then shows once the agent has changed something', async () => {
    const { f, c, paneId, list } = await setup([])
    expect(c.model().changes).toBeNull()
    c.event({ type: 'dblclick', target: `pane:${paneId}:title`, x: 0, y: 0, button: 0, mods })
    await settle()
    // An agent with no changes yet: the button, no column.
    expect(c.model().changes).toBeNull()
    expect(c.model().panes[0]!.changes).toBe('off')
    expect(f.sent.some(([ch, p]) => ch === 'changes:watch' && (p as { kind: string; sid: string }).kind === 'jarvis')).toBe(true)

    list.entries = [entry({})]
    f.advance(2_000)
    await settle()
    const m = c.model()
    expect(m.changes).not.toBeNull()
    expect(m.panes[0]!.changes).toBe('on')
    // The pane gives up the right of the area to the column and its grip.
    const area = m.panes[0]!.rect
    expect(area.x + area.w + 6).toBeCloseTo(m.changes!.rect.x, 5)
    expect(m.changes!.rect.w).toBeCloseTo((area.w + 6 + m.changes!.rect.w) * 0.38, 0)
    expect(m.changes!.groups).toEqual([
      expect.objectContaining({ id: 'edited', count: 1, rows: [expect.objectContaining({ name: 'a.ts', dir: 'src', stat: '+3 -1' })] }),
    ])
    expect(m.changes!.subtitle).toBe('Jarvis · 1 file')
  })

  it('previews a row through view:cmd, never through the model', async () => {
    const { f, c, paneId } = await setup([entry({})])
    c.command('changes.toggle')
    await settle()
    expect(c.model().changes).not.toBeNull()
    c.event({ type: 'click', target: `changes:row:${HOME}/proj/src/a.ts`, x: 0, y: 0, button: 0, mods })
    await settle()
    const m = c.model()
    expect(m.changes!.preview).toMatchObject({ path: `${HOME}/proj/src/a.ts` })
    expect(JSON.stringify(m)).not.toContain('"before"')
    const views = f.shellOut.filter(([ch]) => ch === 'view:cmd').map(([, p]) => p as { op: string; message: { type: string; file?: { after: string } } })
    expect(views.at(-1)).toMatchObject({ op: 'post', message: { type: 'show', file: { after: 'b\n' } } })
    // The page loading late asks again and gets the same file.
    c.view({ type: 'message', message: { type: 'ready' } })
    expect(f.shellOut.filter(([ch]) => ch === 'view:cmd').length).toBe(views.length + 1)
    // Close from the page.
    c.view({ type: 'message', message: { type: 'action', action: 'close' } })
    expect(c.model().changes!.preview).toBeNull()
    void paneId
  })

  it('the chord on a pane that is not full screen zooms it and opens the column', async () => {
    const { c } = await setup([])
    c.command('changes.toggle')
    await settle()
    expect(c.model().zoomedPaneId).not.toBeNull()
    // Opened by hand, so it shows even with nothing changed yet.
    expect(c.model().changes?.empty).toBe('No changes yet')
    c.command('changes.toggle')
    await settle()
    expect(c.model().changes).toBeNull()
    expect(c.model().zoomedPaneId).not.toBeNull()
  })

  it('a pane with no agent gets no column and says so', async () => {
    const { c } = await setup([], false)
    c.command('changes.toggle')
    await settle()
    expect(c.model().changes).toBeNull()
    expect(c.model().panes[0]!.changes).toBe('none')
    expect(c.model().toast).toBe('No agent session is running in this pane')
  })

  it('resizes with the grip, remembers the width, and leaves with the zoom', async () => {
    const { f, c, paneId } = await setup([entry({})])
    c.command('changes.toggle')
    await settle()
    const m = c.model().changes!
    const right = m.rect.x + m.rect.w
    c.event({ type: 'down', target: 'changes:grip', x: m.gripRect.x, y: 10, button: 0, mods })
    c.event({ type: 'up', target: 'changes:grip', x: right - 0.5 * (right - c.model().panes[0]!.rect.x), y: 10, button: 0, mods })
    expect(c.uiState().changesWidth).toBeCloseTo(0.5, 2)
    c.event({ type: 'dblclick', target: `pane:${paneId}:title`, x: 0, y: 0, button: 0, mods })
    await settle()
    expect(c.model().changes).toBeNull()
    void f
  })

  it('opens http links from the preview in the browser, drops anything else, and never twice in two seconds', async () => {
    const { f, c } = await setup([entry({})])
    c.command('changes.toggle')
    await settle()
    const opened = () => f.sent.filter(([ch]) => ch === 'open:externalHttp').map(([, p]) => (p as { url: string }).url)
    c.view({ type: 'navigate', uri: 'javascript:alert(1)' })
    c.view({ type: 'message', message: { type: 'link', url: 'file:///etc/passwd' } })
    c.view({ type: 'navigate', uri: 'https://example.com/a' })
    c.view({ type: 'navigate', uri: 'https://example.com/b' })
    expect(opened()).toEqual(['https://example.com/a'])
    f.advance(2_000)
    c.view({ type: 'message', message: { type: 'link', url: 'http://example.com/c' } })
    expect(opened()).toEqual(['https://example.com/a', 'http://example.com/c'])
  })
})

describe('changes helpers', () => {
  it('groups rows Created, Edited, Deleted and folds on request', () => {
    const g = changeGroups(
      [entry({ change: 'deleted', path: '/x/b', rel: 'b' }), entry({ change: 'created', path: '/x/c/d', rel: 'c/d' }), entry({})],
      '/x/b',
      new Set(['created'])
    )
    expect(g.map((x) => [x.id, x.count, x.folded])).toEqual([
      ['created', 1, true],
      ['edited', 1, false],
      ['deleted', 1, false],
    ])
    expect(g[2]!.rows[0]!.selected).toBe(true)
  })

  it('reads the session out of a lookup answer, claude included', () => {
    const pane = { id: 'p', kind: 'term', cwd: '/home/user/proj', label: '', labelIsCustom: false, command: 'zsh', pid: 1, status: 'live' } as const
    expect(sessionFromLookup({ ids: { p: SID }, sources: { p: 'process' } }, pane)).toEqual({ kind: 'claude', sid: SID, cwd: '/home/user/proj' })
    expect(sessionFromLookup({ ids: { p: SID }, sources: { p: 'carried' } }, pane)).toBeNull()
    expect(sessionFromLookup({ ids: {}, sources: {}, agents: { p: { kind: 'opencode', source: 'process' } } }, pane)).toEqual({ kind: 'opencode', cwd: '/home/user/proj' })
  })

  it('hands the page the theme’s colours and radius', () => {
    expect(pageTheme({ panel: '#FAF5FC', titleText: '#1D0F22', accent: '#881798', radius: '8' })).toMatchObject({ bg: '#FAF5FC', light: true, radius: 8 })
    expect(pageTheme({ panel: '#18191B' })).toMatchObject({ light: false, radius: 6 })
  })
})
