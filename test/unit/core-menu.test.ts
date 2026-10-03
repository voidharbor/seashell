import { describe, expect, it } from 'vitest'
import { createShim } from '../../src/core/electron-shim.js'

describe('menu over the wire', () => {
  it('serializes the template with paths and runs a click by path', async () => {
    const lines: string[] = []
    const pushes: Array<[string, unknown]> = []
    const shim = createShim({ write: (l) => lines.push(l), hostPid: 1, userData: '/tmp/ud', version: '0', onPush: (ch, p) => pushes.push([ch, p]) })
    let clicked = 0
    const menu = shim.Menu.buildFromTemplate([
      { label: 'File', submenu: [{ label: 'New Tab', accelerator: 'Ctrl+Shift+T', click: () => { clicked++ } }, { type: 'separator' }, { role: 'quit' }] },
    ])
    shim.Menu.setApplicationMenu(menu)
    const out = lines.map((l) => JSON.parse(l)).find((e) => e.ch === 'shell:cmd' && e.p.op === 'menu')
    expect(out.p.items[0].submenu[0]).toMatchObject({ label: 'New Tab', accelerator: 'Ctrl+Shift+T', path: [0, 0], type: 'normal' })
    expect(out.p.items[0].submenu[1].type).toBe('separator')
    expect(out.p.items[0].submenu[2]).toMatchObject({ role: 'quit', path: [0, 2] })
    await shim.dispatch({ k: 'send', ch: 'menu:click', p: { path: [0, 0] } })
    expect(clicked).toBe(1)
  })
})
