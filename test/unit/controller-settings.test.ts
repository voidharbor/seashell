import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, target: string) => c.event({ type: 'click', target, x: 0, y: 0, button: 0, mods })

describe('settings sheet', () => {
  it('opens with Aero current and the other themes greyed with the tooltip', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.settings')
    const sheet = c.model().sheet!
    expect(sheet.kind).toBe('settings')
    const theme = sheet.sections[0]!.fields.find((x) => x.id === 'theme')!
    expect(theme.options!.filter((o) => !o.disabled).map((o) => o.id)).toEqual(['aero'])
    expect(theme.options!.find((o) => o.id === 'retro')).toMatchObject({ disabled: true, tooltip: 'coming back' })
  })
  it('accent and palette apply to the tokens and the model, and persist', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const before = c.model().tokens.accent
    c.command('app.settings')
    click(c, 'sheet:settings:accent:0a84ff')
    expect(c.model().tokens.accent).not.toBe(before)
    expect(c.model().tokens.accent).toBe('#0a84ff')
    expect(c.model().tokens.selection).toBe('#0a84ff')
    expect(c.model().tokens.accentText).toMatch(/^#(ffffff|1d0f22)$/i)
    click(c, 'sheet:settings:palette:solar')
    expect(c.model().window.palette).not.toBeNull()
    expect(c.uiState().settings).toMatchObject({ accent: '#0a84ff', palette: 'solar' })
    click(c, 'sheet:settings:accent:default')
    expect(c.model().tokens.accent).toBe(before)
  })
  it('the new-pane command strips control characters and caps at 200, and Escape closes', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.settings')
    c.event({ type: 'text', target: 'sheet:settings:newPaneCommand', text: 'cla\x07ude ' + 'x'.repeat(300) })
    expect(c.uiState().settings.newPaneCommand).toBe(('claude ' + 'x'.repeat(300)).slice(0, 200))
    c.event({ type: 'key', target: 'sheet:settings', key: 'Escape', mods })
    expect(c.model().sheet).toBeNull()
  })
  it('the sheet checks and the sleep toggle share attentionGlow, Done closes, and no copy carries an em dash', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.settings')
    const glow = () => c.model().sheet!.sections[1]!.fields.find((x) => x.id === 'attentionGlow')!.value
    expect(glow()).toBe(true)
    click(c, 'sheet:settings:attentionGlow')
    expect(c.model().sleep).toBe(true)
    expect(glow()).toBe(false)
    click(c, 'sleep')
    expect(glow()).toBe(true)
    expect(JSON.stringify(c.model().sheet)).not.toMatch(/\u2014/)
    click(c, 'sheet:settings:palette:amber')
    expect(c.model().window.palette).toMatchObject({ background: '#140f04', foreground: '#ffb000' })
    click(c, 'sheet:settings:palette:native')
    expect(c.model().window.palette).toBeNull()
    click(c, 'sheet:settings:btn:done')
    expect(c.model().sheet).toBeNull()
  })
  it('the tab strip follows the Windows app theme by default and the setting overrides it', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.push('shell:colorization', { argb: '#FF881798', opaque: false, composition: true, appsDark: true })
    expect(c.model().tokens.stripDark).toBe('1')
    expect(c.model().tokens.tabActive).toBe('#2B2B2B')
    expect(c.model().tokens.tabText).toBe('#F0F0F0')
    expect(c.model().tokens.body).toBe('#ECE2F0') // below the strip nothing changes
    c.push('shell:colorization', { argb: '#FF881798', opaque: false, composition: true, appsDark: false })
    expect(c.model().tokens.stripDark).toBe('0')
    expect(c.model().tokens.tabActive).toBe('#FFFFFF')
    c.command('app.settings')
    click(c, 'sheet:settings:tabStrip:dark')
    expect(c.model().tokens.stripDark).toBe('1')
    expect(c.uiState().settings.tabStrip).toBe('dark')
    c.push('shell:colorization', { argb: '#FF881798', opaque: false, composition: true, appsDark: true })
    click(c, 'sheet:settings:tabStrip:light')
    expect(c.model().tokens.stripDark).toBe('0')
    expect(c.model().tokens.tabActive).toBe('#FFFFFF')
    click(c, 'sheet:settings:accent:0a84ff')
    expect(c.model().tokens.accent).toBe('#0a84ff') // the accent override survives a token rebuild
    click(c, 'sheet:settings:tabStrip:system')
    expect(c.model().tokens.stripDark).toBe('1')
    expect(c.model().tokens.accent).toBe('#0a84ff')
    expect(c.model().tokens.composition).toBe('1')
    const field = c.model().sheet!.sections[0]!.fields.find((x) => x.id === 'tabStrip')!
    expect(field.label).toBe('Tab strip')
    expect(field.options!.map((o) => [o.id, o.label, o.selected])).toEqual([
      ['system', 'System', true],
      ['light', 'Light', false],
      ['dark', 'Dark', false],
    ])
    const ids = c.model().sheet!.sections[0]!.fields.map((x) => x.id)
    expect(ids.indexOf('tabStrip')).toBe(ids.indexOf('accent') + 1)
  })
})
