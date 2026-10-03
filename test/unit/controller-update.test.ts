import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, t: string) => c.event({ type: 'click', target: t, x: 0, y: 0, button: 0, mods })

describe('update banner', () => {
  it('shows available, downloads, shows progress and ready, and Later remembers the version', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.push('update:state', { phase: 'available', version: '0.6.0', pageUrl: 'https://x/r', canInstall: true })
    expect(c.model().update).toMatchObject({ phase: 'available', text: 'SeaShell 0.6.0 is available.' })
    expect(c.model().update!.buttons.map((b) => b.id)).toEqual(['download', 'later'])
    click(c, 'update:download')
    expect(f.sent.some(([ch]) => ch === 'update:download')).toBe(true)
    c.push('update:state', { phase: 'downloading', version: '0.6.0', received: 50, total: 200 })
    expect(c.model().update).toMatchObject({ text: 'Downloading 0.6.0: 25%', progress: 0.25 })
    c.push('update:state', { phase: 'ready', version: '0.6.0' })
    expect(c.model().update!.buttons.map((b) => b.id)).toEqual(['install', 'later'])
    click(c, 'update:later')
    expect(c.model().update).toBeNull()
    expect(c.uiState().dismissedUpdate).toBe('0.6.0')
    c.push('update:state', { phase: 'available', version: '0.6.0', pageUrl: 'https://x/r', canInstall: true })
    expect(c.model().update).toBeNull()
    c.push('update:state', { phase: 'available', version: '0.7.0', pageUrl: 'https://x/r', canInstall: false })
    expect(c.model().update!.buttons.map((b) => b.id)).toEqual(['page', 'later'])
  })
  it('an error offers Try again and Dismiss, and Dismiss lasts the session', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.push('update:state', { phase: 'error', version: '0.6.0', message: 'checksum' })
    expect(c.model().update!.buttons.map((b) => b.id)).toEqual(['retry', 'dismiss'])
    click(c, 'update:dismiss')
    expect(c.model().update).toBeNull()
    expect(c.uiState().dismissedUpdate).toBeNull()
  })
  it('takes 28 DIP above the status bar while it shows, and the page and install buttons reach main', async () => {
    const f = fakeDeps()
    f.handlers['open:externalHttp'] = () => ({ ok: true })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const before = c.model().panes[0]!.rect
    const statusTop = GEO.clientH - c.model().window.statusH
    c.push('update:state', { phase: 'available', version: '9.9.9', pageUrl: 'https://x/r', canInstall: false })
    const u = c.model().update!
    expect(u.rect).toEqual({ x: 0, y: statusTop - 28, w: GEO.clientW, h: 28 })
    expect(c.model().panes[0]!.rect.h).toBe(before.h - 28)
    click(c, 'update:page')
    expect(f.sent.find(([ch]) => ch === 'open:externalHttp')?.[1]).toEqual({ url: 'https://x/r' })
    c.push('update:state', { phase: 'ready', version: '9.9.9' })
    expect(c.model().update!.text).toBe('SeaShell 9.9.9 is ready. Installing closes every pane and relaunches.')
    click(c, 'update:install')
    expect(f.sent.some(([ch]) => ch === 'update:install')).toBe(true)
    c.push('update:state', { phase: 'downloading', version: '9.9.9', received: 3 * 1024 * 1024, total: 0 })
    expect(c.model().update).toMatchObject({ text: 'Downloading 9.9.9: 3 MB', progress: null, buttons: [] })
    c.push('update:state', { phase: 'idle' })
    expect(c.model().update).toBeNull()
    expect(c.model().panes[0]!.rect).toEqual(before)
  })
})
