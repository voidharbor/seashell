/**
 * [pure] Keyboard chords, spelled once in their macOS form and translated for
 * every other platform.
 *
 * SeaShell's bindings are written as `Cmd+…` because on macOS that is the only
 * modifier that never collides with the shell: every Ctrl+<letter> is a C0
 * control code that zsh, vim or a full-screen TUI already owns. On Linux and
 * Windows (SeaShell runs on Windows through WSLg) Electron maps `Cmd` to the
 * Super key, which is the Windows key, and Windows takes those chords for
 * itself before the app ever sees them: Win+D shows the desktop, Win+T walks
 * the taskbar. So off the Mac every chord is respelled here, by rule, so the
 * letter you learned on one machine is the letter on the other:
 *
 *   Cmd+X        →  Ctrl+Shift+X        the Linux terminal convention, and
 *                                       Ctrl+Shift never reaches the pty
 *   Cmd+Shift+X  →  Ctrl+Alt+X          the second tier keeps its letter
 *   Cmd+Alt+X    →  Ctrl+Alt+Shift+X    the third tier, one binding today
 *   Cmd+,        →  Ctrl+,              settings, the editor convention
 *
 * Bare Ctrl+<letter> is never produced, for the reason above. The menu, the
 * tutorial and the renderer's own key listeners all go through this file, so a
 * chord is defined in exactly one place.
 */

export type KeyPlatform = 'darwin' | 'other'

/** Collapses process.platform to the two spellings that matter here. */
export function keyPlatform(platform: string): KeyPlatform {
  return platform === 'darwin' ? 'darwin' : 'other'
}

/** The Electron accelerator for a chord written in its macOS spelling. */
export function accelerator(mac: string, platform: string): string {
  if (keyPlatform(platform) === 'darwin') return mac
  if (!mac.startsWith('Cmd+')) return mac
  const rest = mac.slice('Cmd+'.length)
  if (rest === ',') return 'Ctrl+,'
  if (rest.startsWith('Alt+')) return 'Ctrl+Alt+Shift+' + rest.slice('Alt+'.length)
  if (rest.startsWith('Shift+')) return 'Ctrl+Alt+' + rest.slice('Shift+'.length)
  return 'Ctrl+Shift+' + rest
}

const MAC_GLYPH: Record<string, string> = {
  Cmd: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Ctrl: '⌃',
  Return: '⏎',
}

/**
 * How a chord is written in the UI: glyphs on macOS (⌘⇧R), words elsewhere
 * (Ctrl+Alt+R). Takes the macOS spelling, like everything else here.
 */
export function chordLabel(mac: string, platform: string): string {
  const parts = accelerator(mac, platform).split('+')
  if (keyPlatform(platform) === 'darwin') return parts.map((p) => MAC_GLYPH[p] ?? p).join('')
  return parts.map((p) => (p === 'Return' ? 'Enter' : p)).join('+')
}

export type Modifier = 'Cmd' | 'Alt' | 'Shift'

/**
 * Modifiers on their own, for chords that end in a mouse gesture rather than
 * a key: "⌘ double-click" on the Mac is "Ctrl double-click" elsewhere.
 */
export function modifiersLabel(mods: Modifier[], platform: string): string {
  if (keyPlatform(platform) === 'darwin') return mods.map((m) => MAC_GLYPH[m]!).join('')
  return mods.map((m) => (m === 'Cmd' ? 'Ctrl' : m)).join('+')
}

/**
 * The "command" modifier of a keyboard or mouse event on this platform: Meta
 * on the Mac, Ctrl elsewhere. Used by the renderer's own listeners (zoom keys,
 * modified double-clicks) so they agree with the accelerators above.
 */
export function isPrimaryModifier(
  e: { metaKey: boolean; ctrlKey: boolean },
  platform: string
): boolean {
  return keyPlatform(platform) === 'darwin' ? e.metaKey : e.ctrlKey
}

/**
 * True when a key event is a chord reserved for the app rather than the pty.
 * On the Mac that is any Meta chord. Elsewhere it is Ctrl+Shift and Ctrl+Alt
 * (the two tiers above) plus the Ctrl zoom keys, which the renderer binds
 * itself because each comes in a shifted and unshifted form.
 */
export function isAppChord(
  e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string },
  platform: string
): boolean {
  if (keyPlatform(platform) === 'darwin') return e.metaKey
  if (!e.ctrlKey || e.metaKey) return false
  if (e.shiftKey || e.altKey) return true
  return e.key === ',' || ZOOM_KEYS.has(e.key)
}

/** The keys the renderer's zoom listener handles with the primary modifier. */
export const ZOOM_KEYS: ReadonlySet<string> = new Set(['=', '-', '+', '_', '0'])

/**
 * Label for a zoom chord. These are not menu accelerators (each comes in a
 * shifted and unshifted pair, see app.tsx), so they carry the primary modifier
 * alone: ⌘= on the Mac, Ctrl+= elsewhere.
 */
export function zoomLabel(key: '=' | '-' | '+' | '_' | '0', platform: string): string {
  return keyPlatform(platform) === 'darwin' ? '⌘' + key : 'Ctrl+' + key
}
