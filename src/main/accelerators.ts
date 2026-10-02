/**
 * [pure] Menu shortcuts off the Mac, matched by hand.
 *
 * On Linux the window is frameless with its menu bar hidden
 * (shared/window-chrome.ts), and Electron does not fire a menu accelerator for
 * such a window: the chord reached the page, xterm stepped aside for it as an
 * app chord, and then nothing happened. That was every Ctrl+Shift shortcut,
 * paste included. index.ts matches key-downs against the menu itself in
 * `before-input-event` and clicks the item, so the menu stays the one place
 * shortcuts are declared.
 *
 * Only the Ctrl chords SeaShell declares, F-keys and bare keys are matched.
 * `Command…` and `CommandOrControl…` come from Electron's stock roles (quit,
 * close, minimize), which resolve to bare Ctrl+Q/W/M here: control codes a
 * shell or an editor in the pane needs, never window commands.
 */

/** The fields of Electron's `Input` this needs. */
export interface KeyInput {
  type: string
  code: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

const NAMED_CODES: Record<string, string> = {
  Return: 'Enter',
  Enter: 'Enter',
  Tab: 'Tab',
  Space: 'Space',
  Escape: 'Escape',
  Esc: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
}

/** The physical key (KeyboardEvent.code) an accelerator's key names. */
export function keyCode(key: string): string | null {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
  return NAMED_CODES[key] ?? null
}

interface Parsed {
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  code: string
}

export function parseAccelerator(accel: string): Parsed | null {
  if (/^(Command|Cmd|CommandOrControl|CmdOrCtrl)\+/i.test(accel)) return null
  const parts = accel.split('+')
  const key = parts.pop()
  if (!key) return null
  const code = keyCode(key)
  if (!code) return null
  const out: Parsed = { control: false, shift: false, alt: false, meta: false, code }
  for (const p of parts) {
    const m = p.toLowerCase()
    if (m === 'ctrl' || m === 'control') out.control = true
    else if (m === 'shift') out.shift = true
    else if (m === 'alt' || m === 'option') out.alt = true
    else if (m === 'super' || m === 'meta') out.meta = true
    else return null
  }
  return out
}

export function matchesAccelerator(input: KeyInput, accel: string): boolean {
  if (input.type !== 'keyDown') return false
  const a = parseAccelerator(accel)
  if (!a) return false
  return (
    a.code === input.code &&
    a.control === input.control &&
    a.shift === input.shift &&
    a.alt === input.alt &&
    a.meta === input.meta
  )
}

/** Just the shape of Electron's Menu this walks. */
export interface MenuLike {
  items: MenuItemLike[]
}
export interface MenuItemLike {
  accelerator?: string | null
  enabled: boolean
  visible: boolean
  submenu?: MenuLike | null
}

/** The enabled menu item whose shortcut this key-down is, if any. */
export function findMenuItem<T extends MenuItemLike>(menu: MenuLike | null, input: KeyInput): T | null {
  if (!menu || input.type !== 'keyDown') return null
  for (const item of menu.items) {
    if (item.submenu) {
      const hit = findMenuItem<T>(item.submenu, input)
      if (hit) return hit
    }
    if (item.accelerator && item.enabled && matchesAccelerator(input, item.accelerator)) return item as T
  }
  return null
}
