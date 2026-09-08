import type { SavedTab } from '../../shared/ipc.js'

/** A single fresh shell is not worth a prompt; anything more is. */
export function shouldOfferRestore(tabs: SavedTab[]): boolean {
  if (tabs.length === 0) return false
  if (tabs.length > 1) return true
  const panes = Object.values(tabs[0]!.panes)
  if (panes.length > 1) return true
  return panes.some((p) => p.command !== 'zsh')
}
