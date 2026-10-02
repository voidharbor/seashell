import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  accelerator,
  chordLabel,
  isAppChord,
  isPrimaryModifier,
  modifiersLabel,
} from '../../src/shared/keys.js'

/**
 * Off the Mac, Cmd is the Windows key and Windows keeps it (Win+D shows the
 * desktop), so every chord is respelled by rule. These pin the rules, and then
 * run the whole live menu through them so a new menu item cannot quietly
 * produce a bare Ctrl+letter (a shell control code) or a collision.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const menuTs = fs.readFileSync(path.join(root, 'src/main/menu.ts'), 'utf8')

/** Every accelerator menu.ts declares, in its macOS spelling. */
function menuChords(): string[] {
  const out: string[] = []
  for (const m of menuTs.matchAll(/item\(\s*[`'"][^`'"]*[`'"]\s*,\s*'([^']+)'/g)) out.push(m[1]!)
  // The tab loop: item(`Tab ${i + 1}`, `Cmd+${i + 1}`, …)
  if (/`Cmd\+\$\{i \+ 1\}`/.test(menuTs)) for (let i = 1; i <= 9; i++) out.push(`Cmd+${i}`)
  return out
}

describe('accelerator', () => {
  it('leaves macOS chords exactly as written', () => {
    for (const c of ['Cmd+D', 'Cmd+Shift+W', 'Cmd+Alt+W', 'Cmd+,', 'Cmd+Return', 'Cmd+]', 'Cmd+1']) {
      expect(accelerator(c, 'darwin')).toBe(c)
    }
  })

  it.each([
    ['Cmd+D', 'Ctrl+Shift+D'],
    ['Cmd+W', 'Ctrl+Shift+W'],
    ['Cmd+Shift+W', 'Ctrl+Alt+W'],
    ['Cmd+Alt+W', 'Ctrl+Alt+Shift+W'],
    ['Cmd+,', 'Ctrl+,'],
    ['Cmd+Return', 'Ctrl+Shift+Return'],
    ['Cmd+]', 'Ctrl+Shift+]'],
    ['Cmd+Shift+]', 'Ctrl+Alt+]'],
    ['Cmd+1', 'Ctrl+Shift+1'],
    ['Cmd+/', 'Ctrl+Shift+/'],
  ])('respells %s as %s off the Mac', (mac, other) => {
    expect(accelerator(mac, 'linux')).toBe(other)
    expect(accelerator(mac, 'win32')).toBe(other)
  })

  it('is reading the live menu', () => {
    const chords = menuChords()
    expect(chords.length).toBeGreaterThan(25)
    expect(chords).toContain('Cmd+D')
    expect(chords).toContain('Cmd+9')
  })

  it('never yields a Cmd, Super or bare Ctrl+key chord off the Mac', () => {
    for (const mac of menuChords()) {
      const a = accelerator(mac, 'linux')
      expect(a, mac).not.toMatch(/Cmd|Super|Meta/)
      if (a !== 'Ctrl+,') expect(a, mac).toMatch(/^Ctrl\+(Shift|Alt)\+/)
    }
  })

  it('keeps every menu chord distinct on both platforms', () => {
    const mac = menuChords()
    expect(new Set(mac).size).toBe(mac.length)
    const other = mac.map((c) => accelerator(c, 'linux'))
    expect(new Set(other).size).toBe(other.length)
  })
})

describe('labels', () => {
  it('uses glyphs on the Mac and words elsewhere', () => {
    expect(chordLabel('Cmd+Shift+R', 'darwin')).toBe('⌘⇧R')
    expect(chordLabel('Cmd+Return', 'darwin')).toBe('⌘⏎')
    expect(chordLabel('Cmd+=', 'darwin')).toBe('⌘=')
    expect(chordLabel('Cmd+Shift+R', 'linux')).toBe('Ctrl+Alt+R')
    expect(chordLabel('Cmd+Return', 'linux')).toBe('Ctrl+Shift+Enter')
    expect(chordLabel('Cmd+,', 'win32')).toBe('Ctrl+,')
  })

  it('spells bare modifiers for mouse chords', () => {
    expect(modifiersLabel(['Cmd', 'Alt'], 'darwin')).toBe('⌘⌥')
    expect(modifiersLabel(['Alt'], 'darwin')).toBe('⌥')
    expect(modifiersLabel(['Cmd', 'Alt'], 'linux')).toBe('Ctrl+Alt')
    expect(modifiersLabel(['Cmd'], 'linux')).toBe('Ctrl')
  })
})

describe('event classification', () => {
  const ev = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string }>) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: 'a',
    ...o,
  })

  it('treats Meta as the primary modifier on the Mac and Ctrl elsewhere', () => {
    expect(isPrimaryModifier(ev({ metaKey: true }), 'darwin')).toBe(true)
    expect(isPrimaryModifier(ev({ ctrlKey: true }), 'darwin')).toBe(false)
    expect(isPrimaryModifier(ev({ ctrlKey: true }), 'linux')).toBe(true)
    expect(isPrimaryModifier(ev({ metaKey: true }), 'linux')).toBe(false)
  })

  it('reserves Meta chords for the app on the Mac', () => {
    expect(isAppChord(ev({ metaKey: true, key: 'd' }), 'darwin')).toBe(true)
    expect(isAppChord(ev({ ctrlKey: true, shiftKey: true, key: 'd' }), 'darwin')).toBe(false)
  })

  it('reserves Ctrl+Shift, Ctrl+Alt and the Ctrl zoom keys off the Mac, and nothing else', () => {
    expect(isAppChord(ev({ ctrlKey: true, shiftKey: true, key: 'D' }), 'linux')).toBe(true)
    expect(isAppChord(ev({ ctrlKey: true, altKey: true, key: 'w' }), 'linux')).toBe(true)
    expect(isAppChord(ev({ ctrlKey: true, key: '=' }), 'linux')).toBe(true)
    expect(isAppChord(ev({ ctrlKey: true, key: '-' }), 'linux')).toBe(true)
    expect(isAppChord(ev({ ctrlKey: true, key: ',' }), 'linux')).toBe(true)
    // Ctrl+C is the shell's interrupt and must still reach the pty.
    expect(isAppChord(ev({ ctrlKey: true, key: 'c' }), 'linux')).toBe(false)
    expect(isAppChord(ev({ ctrlKey: true, key: 'd' }), 'linux')).toBe(false)
    expect(isAppChord(ev({ shiftKey: true, key: 'D' }), 'linux')).toBe(false)
    expect(isAppChord(ev({ metaKey: true, key: 'd' }), 'linux')).toBe(false)
  })
})
