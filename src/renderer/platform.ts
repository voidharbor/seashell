/**
 * The host platform as the preload reports it. Everything in the renderer that
 * spells or recognises a chord reads this, so it agrees with the menu.
 *
 * Falls back to 'darwin' when there is no bridge (the dom test project), which
 * keeps every existing expectation about ⌘ intact there.
 */
import { chordLabel, keyPlatform, zoomLabel } from '../shared/keys.js'

export const platform: string =
  typeof window !== 'undefined' && window.seashell?.platform ? window.seashell.platform : 'darwin'

export const isMac: boolean = keyPlatform(platform) === 'darwin'

/** A chord written in its Mac spelling, shown the way this machine writes it. */
export const k = (mac: string): string => chordLabel(mac, platform)

/** A zoom key with the primary modifier: ⌘= here, Ctrl+= there. */
export const z = (key: '=' | '-' | '+' | '_' | '0'): string => zoomLabel(key, platform)

/** The pane-only zoom pair, which is the shifted form of the global pair. */
export const paneZoomIn: string = isMac ? '⌘+' : 'Ctrl+Shift+='
export const paneZoomOut: string = isMac ? '⌘_' : 'Ctrl+Shift+-'

export const enterLabel: string = isMac ? '⏎' : 'Enter'
export const shiftEnterLabel: string = isMac ? '⇧⏎' : 'Shift+Enter'
