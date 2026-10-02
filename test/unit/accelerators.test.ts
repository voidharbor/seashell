import { describe, expect, it } from 'vitest'
import { findMenuItem, keyCode, matchesAccelerator, type KeyInput } from '../../src/main/accelerators.js'

function key(code: string, mods: Partial<KeyInput> = {}): KeyInput {
  return { type: 'keyDown', code, control: false, shift: false, alt: false, meta: false, ...mods }
}

describe('matchesAccelerator', () => {
  it('matches the paste chord by physical key, whatever case the key reports', () => {
    expect(matchesAccelerator(key('KeyV', { control: true, shift: true }), 'Ctrl+Shift+V')).toBe(true)
  })

  it('needs the modifiers to be exact', () => {
    expect(matchesAccelerator(key('KeyV', { control: true }), 'Ctrl+Shift+V')).toBe(false)
    expect(matchesAccelerator(key('KeyV', { control: true, shift: true, alt: true }), 'Ctrl+Shift+V')).toBe(false)
  })

  it('handles punctuation, digits, Return and F-keys', () => {
    expect(matchesAccelerator(key('Comma', { control: true }), 'Ctrl+,')).toBe(true)
    expect(matchesAccelerator(key('BracketRight', { control: true, shift: true }), 'Ctrl+Shift+]')).toBe(true)
    expect(matchesAccelerator(key('Digit3', { control: true, shift: true }), 'Ctrl+Shift+3')).toBe(true)
    expect(matchesAccelerator(key('Enter', { control: true, shift: true }), 'Ctrl+Shift+Return')).toBe(true)
    expect(matchesAccelerator(key('Slash', { control: true, shift: true }), 'Ctrl+Shift+/')).toBe(true)
    expect(matchesAccelerator(key('F11'), 'F11')).toBe(true)
    expect(matchesAccelerator(key('KeyW', { control: true, alt: true, shift: true }), 'Ctrl+Alt+Shift+W')).toBe(true)
  })

  it('never claims the stock Command roles, which are bare Ctrl+letter off the Mac', () => {
    expect(matchesAccelerator(key('KeyW', { control: true }), 'CommandOrControl+W')).toBe(false)
    expect(matchesAccelerator(key('KeyQ', { control: true }), 'CommandOrControl+Q')).toBe(false)
    expect(matchesAccelerator(key('KeyH', { meta: true }), 'Command+H')).toBe(false)
  })

  it('ignores key-ups', () => {
    expect(matchesAccelerator({ ...key('KeyV', { control: true, shift: true }), type: 'keyUp' }, 'Ctrl+Shift+V')).toBe(false)
  })

  it('knows the keys it cannot map', () => {
    expect(keyCode('Plus')).toBeNull()
  })
})

describe('findMenuItem', () => {
  const paste = { label: 'Paste', accelerator: 'Ctrl+Shift+V', enabled: true, visible: true }
  const off = { label: 'Off', accelerator: 'Ctrl+Shift+X', enabled: false, visible: true }
  const menu = {
    items: [
      { label: 'Edit', enabled: true, visible: true, submenu: { items: [paste, off] } },
      { label: 'Close', accelerator: 'CommandOrControl+W', enabled: true, visible: true },
    ],
  }

  it('finds an item inside a submenu', () => {
    expect(findMenuItem(menu, key('KeyV', { control: true, shift: true }))).toBe(paste)
  })

  it('skips disabled items and the stock roles', () => {
    expect(findMenuItem(menu, key('KeyX', { control: true, shift: true }))).toBeNull()
    expect(findMenuItem(menu, key('KeyW', { control: true }))).toBeNull()
  })
})
