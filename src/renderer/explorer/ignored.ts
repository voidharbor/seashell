/**
 * Whether a directory is one .gitignore matched. [pure]
 *
 * Spec section 8: the watch pool refuses any directory the gitignore module
 * marks ignored. The renderer is where that is decided, because the flag is
 * already in hand: `readDir` returns `ignored` per entry so the tree can dim
 * rather than hide, and a directory's own listing does not carry it, only its
 * parent's does. A build output directory is the case this exists for: `dist`
 * or `target` rewrites itself on every compile, and a watch there spends a
 * pool slot and a re-list on churn nobody asked to see. The always-hidden
 * names (`node_modules`, `.git`) never reach here at all: `readDir` omits
 * them, and the watch pool in main refuses them a second time.
 *
 * Unknown means no. The flag arrives with the parent's listing, and a
 * directory expanded before its parent has been read is not evidence of
 * anything; the effect re-runs when that listing lands.
 */

export interface IgnoredEntry {
  name: string
  ignored: boolean
}

/** Just the part of the explorer's `dirs` map this needs. */
export type IgnoredLookup = Record<string, { entries: IgnoredEntry[] } | undefined>

export function isIgnoredDir(dirs: IgnoredLookup, dirPath: string): boolean {
  const slash = dirPath.lastIndexOf('/')
  if (slash <= 0) return false
  const parent = dirPath.slice(0, slash)
  const name = dirPath.slice(slash + 1)
  if (name === '') return false
  const entry = dirs[parent]?.entries.find((e) => e.name === name)
  return entry?.ignored === true
}
