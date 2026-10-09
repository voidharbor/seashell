import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, target: string) => c.event({ type: 'click', target, x: 0, y: 0, button: 0, mods })

describe('settings sheet', () => {
  it('opens with every native theme enabled and Aero current', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.settings')
    const theme = () => c.model().sheet!.sections[0]!.fields.find((x) => x.id === 'theme')!
    expect(c.model().sheet!.kind).toBe('settings')
    expect(theme().options!.map((o) => [o.id, o.label, o.disabled])).toEqual([
      ['system', 'System', false],
      ['aero', 'Aero Glass', false],
      ['aeroDark', 'Aero Dark', false],
      ['mac', 'macOS Light', false],
      ['macDark', 'macOS Dark', false],
      ['nautical', 'Nautical', false],
      ['hacker', 'Hacker', false],
      ['homebrew', 'Homebrew', false],
    ])
    expect(theme().options!.filter((o) => o.selected).map((o) => o.id)).toEqual(['aero'])
    expect(theme().options!.some((o) => o.tooltip === 'coming back')).toBe(false)
    expect(theme().note).toBe('Current: Aero Glass, the Windows 7 era')
    click(c, 'sheet:settings:theme:aeroDark')
    expect(theme().options!.filter((o) => o.selected).map((o) => o.id)).toEqual(['aeroDark'])
    expect(theme().note).toBe('Current: Aero Dark, Windows 7 glass over dark surfaces')
    click(c, 'sheet:settings:theme:system')
    c.push('shell:colorization', { argb: '#FF881798', opaque: false, composition: true, appsDark: true })
    expect(theme().note).toBe('Current: System, showing Aero Dark while Windows apps are dark.')
    expect(JSON.stringify(c.model().sheet)).not.toMatch(/\u2014/)
  })
  it('the tab strip setting is for Aero only', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.settings')
    const strip = () => c.model().sheet!.sections[0]!.fields.find((x) => x.id === 'tabStrip')!
    expect(strip().options!.every((o) => !o.disabled)).toBe(true)
    click(c, 'sheet:settings:theme:macDark')
    expect(strip().options!.every((o) => o.disabled && o.tooltip === 'Aero Glass only')).toBe(true)
    expect(strip().note).toBe('For Aero Glass only. This theme sets its own tab strip.')
    click(c, 'sheet:settings:tabStrip:dark')
    expect(c.uiState().settings.tabStrip).toBe('system') // greyed: the click does nothing
    click(c, 'sheet:settings:theme:aero')
    click(c, 'sheet:settings:tabStrip:dark')
    expect(c.model().tokens.stripDark).toBe('1')
    expect(c.model().tokens.body).toBe('#ECE2F0') // light body, dark strip
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
