import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chordTableFromMenu, commandForItem } from '../../src/core/controller/chords.js'

describe('chord table', () => {
  it('maps the menu template accelerators to commands in Windows spelling', () => {
    const menu = { items: [{ label: 'File', submenu: { items: [{ label: 'New Tab', accelerator: 'Ctrl+Shift+T' }, { label: 'New Pane', accelerator: 'Ctrl+Shift+D' }] } }] }
    const t = chordTableFromMenu(menu, 'win32')
    expect(t).toContainEqual({ chord: 'Ctrl+Shift+T', command: 'tab.new' })
    expect(t).toContainEqual({ chord: 'Ctrl+Shift+D', command: 'pane.new' })
    expect(t).toContainEqual({ chord: 'Ctrl+=', command: 'ui.zoomIn' })
    expect(t).toContainEqual({ chord: 'Ctrl+Shift+=', command: 'pane.zoomIn' })
  })
  it('knows the command of every item(...) in menu.ts, so the copied table cannot drift', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const menuTs = fs.readFileSync(path.join(root, 'src/main/menu.ts'), 'utf8')
    const items = [...menuTs.matchAll(/item\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*'([^']+)'/g)]
    expect(items.length).toBeGreaterThan(20)
    for (const m of items) expect(commandForItem(m[1]!)).toBe(m[2])
    expect(commandForItem('Tab 3')).toBe('tab.select.2')
  })
})
