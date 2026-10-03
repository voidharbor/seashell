import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { STEPS } from '../../src/core/controller/tutorial-steps.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const key = (c: Controller, k: string) => c.event({ type: 'key', target: 'sheet:tutorial', key: k, mods })
const click = (c: Controller, t: string) => c.event({ type: 'click', target: t, x: 0, y: 0, button: 0, mods })

/** A fresh userData of its own, so ui-state.json round trips and starts unseen. */
function freshDeps() {
  const ud = mkdtempSync(join(tmpdir(), 'ss-tut-'))
  onTestFinished(() => rmSync(ud, { recursive: true, force: true }))
  const f = fakeDeps('/h')
  f.handlers['app:getPaths'] = () => ({ home: '/h', hostname: 'jarvis', userData: ud, defaultShell: '/usr/bin/zsh', cwdOfLaunch: '/h', platform: 'win32', host: 'native' })
  return f
}

describe('tutorial', () => {
  it('has twelve steps with Windows spellings and shows on first run only', async () => {
    expect(STEPS('win32')).toHaveLength(12)
    expect(JSON.stringify(STEPS('win32'))).toContain('Ctrl+Shift+D')
    expect(JSON.stringify(STEPS('win32'))).not.toContain('Cmd+')
    expect(JSON.stringify(STEPS('win32'))).not.toContain('\u2014')
    const f = freshDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    expect(c.model().sheet?.kind).toBe('tutorial')
    key(c, 'ArrowRight'); key(c, 'ArrowRight')
    expect(c.model().sheet!.sections[0]!.title).toBe(STEPS('win32')[2]!.title)
    key(c, 'ArrowLeft')
    expect(c.model().sheet!.sections[0]!.title).toBe(STEPS('win32')[1]!.title)
    key(c, 'Escape')
    expect(c.model().sheet).toBeNull()
    expect(c.uiState().tutorialSeen).toBe(true)
    const c2 = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c2.boot(GEO)
    expect(c2.model().sheet).toBeNull()   // ui-state.json in the shared temp userData says seen
  })
  it('lays out a step as the sheet: dots, keys, the check, Skip, Back and Next', async () => {
    const f = freshDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const sheet = c.model().sheet!
    const fields = sheet.sections.flatMap((s) => s.fields)
    expect(sheet.sections[0]!.title).toBe('Welcome to SeaShell')
    const dots = fields.find((x) => x.id === 'step')!
    expect(dots.kind).toBe('buttons')
    expect(dots.options!.map((o) => o.selected)).toEqual(STEPS('win32').map((_, i) => i === 0))
    expect(fields.find((x) => x.id === 'keys')!.rows![0]).toMatchObject({ name: 'Ctrl+Shift+T', meta: 'New tab' })
    expect(fields.find((x) => x.id === 'dontShow')).toMatchObject({ kind: 'check', value: true })
    expect(sheet.buttons.map((b) => [b.id, b.label, b.disabled, b.isDefault])).toEqual([
      ['skip', 'Skip', false, false],
      ['back', 'Back', true, false],
      ['next', 'Next', false, true],
    ])
    click(c, 'sheet:tutorial:step:11')
    expect(c.model().sheet!.buttons.find((b) => b.id === 'next')!.label).toBe('Get started')
    click(c, 'sheet:tutorial:btn:back')
    expect(c.model().sheet!.sections[0]!.title).toBe(STEPS('win32')[10]!.title)
    key(c, 'ArrowRight'); key(c, 'ArrowRight')   // stays on the last step
    expect(c.model().sheet!.sections[0]!.title).toBe(STEPS('win32')[11]!.title)
    click(c, 'sheet:tutorial:dontShow')
    click(c, 'sheet:tutorial:btn:next')   // Get started closes
    expect(c.model().sheet).toBeNull()
    expect(c.uiState().tutorialSeen).toBe(false)   // unchecked: shown again next launch
  })
  it('waits for the restore card, and help.tutorial and the Settings Show button open it again', async () => {
    const f = freshDeps()
    f.handlers['session:load'] = () => ({ schemaVersion: 1, savedAt: '2026-10-03T00:00:00.000Z', tabs: [
      { id: 't1', name: 'a', nameIsCustom: false, cwd: '/h', zoomedPaneId: null, focusedPaneId: 'p1',
        tree: { type: 'row', ratios: [1], children: [{ type: 'col', ratios: [0.5, 0.5], children: [{ type: 'pane', paneId: 'p1' }, { type: 'pane', paneId: 'p2' }] }] },
        panes: { p1: { label: 'zsh', labelIsCustom: false, kind: 'term', command: 'zsh', cwd: '/h' }, p2: { label: 'zsh', labelIsCustom: false, kind: 'term', command: 'zsh', cwd: '/h' } } },
    ] })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    expect(c.model().restore).not.toBeNull()
    expect(c.model().sheet).toBeNull()
    click(c, 'restore:fresh')
    expect(c.model().sheet?.kind).toBe('tutorial')
    click(c, 'sheet:tutorial:btn:skip')
    expect(c.model().sheet).toBeNull()
    expect(c.uiState().tutorialSeen).toBe(true)
    c.command('help.tutorial')
    expect(c.model().sheet?.kind).toBe('tutorial')
    expect(c.model().sheet!.sections[0]!.title).toBe('Welcome to SeaShell')
    expect(c.model().toast).toBeNull()
    c.command('app.settings')
    click(c, 'sheet:settings:tutorial')
    expect(c.model().sheet?.kind).toBe('tutorial')
  })
})
