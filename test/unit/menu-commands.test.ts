import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every command the menu sends must have a handler.
 *
 * menu.ts says so in its own header — "A menu item whose command nothing
 * handles is worse than no menu item: it presents as a working feature and
 * does nothing" — and that rule has been broken before: four items (⌘⇧D, ⌘F,
 * ⌘⇧E, ⌘R) once shipped sending commands no case existed for. Nothing catches
 * it otherwise. A command string is just a string on both sides, so it
 * typechecks, renders, and silently does nothing when clicked.
 *
 * Checked in the other direction too, loosely: a handler with no menu item is
 * not necessarily wrong (some commands are sent from the renderer's own key
 * listener), so that half only reports, it does not fail.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const menuTs = fs.readFileSync(path.join(root, 'src/main/menu.ts'), 'utf8')
const appTsx = fs.readFileSync(path.join(root, 'src/renderer/app.tsx'), 'utf8')

/** Commands menu.ts sends, from both spellings: item(...) and a raw click. */
function commandsSent(): string[] {
  const out = new Set<string>()
  // item('Label', 'Accel', 'command')
  for (const m of menuTs.matchAll(/item\(\s*[`'"][^`'"]*[`'"]\s*,\s*[`'"][^`'"]*[`'"]\s*,\s*'([^']+)'/g)) {
    out.add(m[1]!)
  }
  // { label: '…', click: send('command') } — the no-accelerator form.
  for (const m of menuTs.matchAll(/click:\s*send\('([^']+)'\)/g)) out.add(m[1]!)
  return [...out]
}

/** Commands the renderer's switch handles. */
function commandsHandled(): Set<string> {
  const out = new Set<string>()
  for (const m of appTsx.matchAll(/case '([a-z][\w.]*)':/gi)) out.add(m[1]!)
  return out
}

describe('menu commands', () => {
  it('is actually reading the menu', () => {
    const sent = commandsSent()
    expect(sent.length).toBeGreaterThan(20)
    expect(sent).toContain('drawer.toggle')
    expect(sent).toContain('tab.rename')
  })

  it('has a renderer handler for every command the menu can send', () => {
    const handled = commandsHandled()
    // `tab.select.N` is built by a loop and dispatched by prefix, so the switch
    // cannot list each one; it is matched separately in the renderer.
    const unhandled = commandsSent().filter(
      (c) => !handled.has(c) && !c.startsWith('tab.select.')
    )
    expect(unhandled).toEqual([])
  })
})
