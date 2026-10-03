import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, t: string) => c.event({ type: 'click', target: t, x: 0, y: 0, button: 0, mods })
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup() {
  const f = fakeDeps()
  const projects: Array<{ id: string; name: string; savedAt: string; tabs: unknown[] }> = []
  f.handlers['projects:list'] = () => ({ projects })
  f.handlers['projects:save'] = (p) => { const r = p as { id?: string; name: string; tabs: unknown[] }; const proj = { id: r.id ?? `p${projects.length + 1}`, name: r.name, savedAt: new Date(1_700_000_000_000).toISOString(), tabs: r.tabs }; const i = projects.findIndex((x) => x.id === proj.id); if (i >= 0) projects[i] = proj; else projects.push(proj); return { ok: true, project: proj } }
  f.handlers['projects:delete'] = (p) => { const i = projects.findIndex((x) => x.id === (p as { id: string }).id); if (i >= 0) projects.splice(i, 1); return { ok: true } }
  f.handlers['projects:sessionIds'] = () => ({ ids: {}, sources: {} })
  f.handlers['projects:resumeModes'] = () => ({ modes: {}, bypassConsented: false })
  return { f, projects }
}

// The toasts carry the project's name as app.tsx writes them (`Saved project “Work”`),
// and Open and Add close the sheet as they close the renderer's panel (app.tsx:708, 745).
describe('projects sheet', () => {
  it('saves the window under a name, lists it, and Overwrite appears for the same name', async () => {
    const { f, projects } = setup()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('tab.new')
    c.command('app.saveProject'); await flush()
    expect(c.model().sheet?.kind).toBe('projects')
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'Work' })
    click(c, 'sheet:projects:save'); await flush()
    expect(projects.map((p) => p.name)).toEqual(['Work'])
    expect(c.model().toast).toBe('Saved project “Work”')
    const rows = c.model().sheet!.sections[1]!.fields[0]!.rows!
    expect(rows[0]!.meta).toMatch(/^2 tabs · 2 panes · saved /)
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'work' })
    expect(c.model().sheet!.sections[0]!.fields.find((x) => x.id === 'save')!.label).toBe('Overwrite')
  })
  it('Open replaces the window and kills live panes; Add appends; Delete asks inline', async () => {
    const { f, projects } = setup()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.saveProject'); await flush()
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'One' })
    click(c, 'sheet:projects:save'); await flush()
    const id = projects[0]!.id
    c.command('tab.new'); c.command('tab.new')
    click(c, `sheet:projects:row:${id}:open`); await flush(); await flush()
    expect(c.model().tabs).toHaveLength(1)
    expect(f.sent.filter(([ch]) => ch === 'pty:kill').length).toBeGreaterThanOrEqual(3)
    expect(c.model().toast).toBe('Opened “One”')
    expect(c.model().sheet).toBeNull()
    c.command('app.projects'); await flush()
    click(c, `sheet:projects:row:${id}:add`); await flush(); await flush()
    expect(c.model().tabs).toHaveLength(2)
    expect(c.model().toast).toBe('Added “One”')
    expect(c.model().sheet).toBeNull()
    c.command('app.projects'); await flush()
    click(c, `sheet:projects:row:${id}:delete`)
    expect(c.model().sheet!.sections[1]!.fields[0]!.rows![0]!.confirming).toBe(true)
    click(c, `sheet:projects:row:${id}:cancel`)
    expect(projects).toHaveLength(1)
    click(c, `sheet:projects:row:${id}:delete`); click(c, `sheet:projects:row:${id}:confirm`); await flush()
    expect(projects).toHaveLength(0)
  })
  it('tab scope saves only the active tab and toasts Saved tab as', async () => {
    const { f, projects } = setup()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('tab.new')
    c.command('app.saveTab'); await flush()
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'Just this' })
    c.event({ type: 'key', target: 'sheet:projects:name', key: 'Enter', mods }); await flush()
    expect(projects[0]!.tabs).toHaveLength(1)
    expect(c.model().toast).toBe('Saved tab as “Just this”')
  })
  it('a window save arms Save “<current>” in place, the name clears, and a refused save toasts its code', async () => {
    const { f, projects } = setup()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.projects'); await flush()
    const save = () => c.model().sheet!.sections[0]!.fields.find((x) => x.id === 'save')!
    expect(save()).toMatchObject({ label: 'Save', disabled: true })
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'Work' })
    click(c, 'sheet:projects:save'); await flush()
    const name = c.model().sheet!.sections[0]!.fields.find((x) => x.id === 'name')!
    expect(name.value).toBe('')
    const current = c.model().sheet!.sections[0]!.fields.find((x) => x.id === 'saveCurrent')!
    expect(current.label).toBe('Save “Work”')
    c.command('tab.new')
    click(c, 'sheet:projects:saveCurrent'); await flush()
    expect(projects).toHaveLength(1)
    expect(projects[0]!.tabs).toHaveLength(2)
    click(c, 'sheet:projects:scope:tab')
    expect(c.model().sheet!.sections[0]!.fields.some((x) => x.id === 'saveCurrent')).toBe(false)
    f.handlers['projects:save'] = () => ({ ok: false, code: 'EWRITE', message: 'no' })
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'Other' })
    click(c, 'sheet:projects:save'); await flush()
    expect(c.model().toast).toBe('Could not save project (EWRITE)')
    c.event({ type: 'key', target: 'sheet:projects', key: 'Escape', mods })
    expect(c.model().sheet).toBeNull()
  })
})
