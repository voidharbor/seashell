import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, target: string) => c.event({ type: 'click', target, x: 0, y: 0, button: 0, mods })
const tick = () => new Promise((r) => setImmediate(r))

async function twoTabs() {
  const f = fakeDeps()
  const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
  await c.boot(GEO)
  c.command('tab.new')
  expect(c.model().tabs).toHaveLength(2)
  return { f, c }
}

describe('closing a tab asks first', () => {
  it('tab.close opens the confirmation and the tab stays until Close tab', async () => {
    const { f, c } = await twoTabs()
    c.command('tab.close')
    await tick()
    expect(c.model().tabs).toHaveLength(2)
    const sheet = c.model().sheet!
    expect(sheet.kind).toBe('closeTab')
    expect(sheet.buttons.map((b) => [b.id, b.isDefault])).toEqual([['keep', false], ['close', true]])
    expect(f.sent.some(([ch]) => ch === 'pty:kill')).toBe(false)
    click(c, 'sheet:closeTab:btn:close')
    await tick()
    expect(c.model().sheet).toBeNull()
    expect(c.model().tabs).toHaveLength(1)
    expect(f.sent.some(([ch]) => ch === 'pty:kill')).toBe(true)
  })
  it('Escape, Keep it and the card close all keep the tab', async () => {
    const { f, c } = await twoTabs()
    const id = c.model().tabs[1]!.id
    for (const dismiss of ['escape', 'keep', 'x'] as const) {
      click(c, `tab:${id}:close`)
      expect(c.model().sheet?.kind).toBe('closeTab')
      if (dismiss === 'escape') c.event({ type: 'key', target: 'sheet:closeTab', key: 'Escape', mods })
      else if (dismiss === 'keep') click(c, 'sheet:closeTab:btn:keep')
      else click(c, 'sheet:close')
      await tick()
      expect(c.model().sheet).toBeNull()
      expect(c.model().tabs).toHaveLength(2)
    }
    expect(f.sent.some(([ch]) => ch === 'pty:kill')).toBe(false)
  })
  it('closing the last pane of a tab asks like closing the tab', async () => {
    const { c } = await twoTabs()
    const pane = c.model().panes.find((p) => p.focused)!
    click(c, `pane:${pane.id}:close`)
    await tick()
    expect(c.model().sheet?.kind).toBe('closeTab')
    expect(c.model().tabs).toHaveLength(2)
    click(c, 'sheet:closeTab:btn:close')
    await tick()
    expect(c.model().tabs).toHaveLength(1)
    // With two panes, a pane's X closes just that pane, no question asked.
    c.command('pane.new')
    const other = c.model().panes.find((p) => p.focused)!
    click(c, `pane:${other.id}:close`)
    await tick()
    expect(c.model().sheet).toBeNull()
    expect(c.model().panes).toHaveLength(1)
  })
  it('a tab whose shells have all exited closes without asking', async () => {
    const { c } = await twoTabs()
    const pane = c.model().panes.find((p) => p.focused)!
    c.push('pty:exit', { paneId: pane.id, exitCode: 0, signal: null, ranMs: 10 })
    c.command('tab.close')
    await tick()
    expect(c.model().sheet).toBeNull()
    expect(c.model().tabs).toHaveLength(1)
  })
  it('the question names the tab and counts its panes', async () => {
    const { c } = await twoTabs()
    c.command('pane.new')
    c.command('tab.close')
    const sheet = c.model().sheet!
    expect(sheet.title).toBe('Close tab?')
    expect(sheet.sections[0]!.title).toBe(c.model().tabs[1]!.name)
    expect(sheet.sections[0]!.fields[0]!.label).toBe('Its 2 panes and whatever is running in them will be stopped.')
  })
})
