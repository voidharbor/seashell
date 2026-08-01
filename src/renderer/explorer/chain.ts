/**
 * Which directories have to be open for a path to be visible in the tree.
 *
 * This module is [pure]: no React, no IPC, no filesystem. The reveal has been a
 * recurring source of "the double-click does nothing" reports, and every one of
 * them turned out to be an off-by-one in *this* calculation rather than
 * anything to do with events — so it is worth being able to test it directly
 * with plain strings.
 */

export function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/**
 * The directories between `root` and `p`, root first, ending at `p`'s parent.
 *
 * Stops as soon as it leaves the root: the tree can only expand to something
 * beneath its own root, so a path outside it yields nothing to open.
 */
export function ancestorsOf(p: string, root: string): string[] {
  const out: string[] = []
  let cur = parentOf(p)
  while (cur.startsWith(root) && cur.length >= root.length) {
    out.unshift(cur)
    if (cur === root) break
    cur = parentOf(cur)
  }
  return out
}

/**
 * Everything to expand in order to reveal `p`, deepest last.
 *
 * The difference between a file and a directory is the whole bug this fixes.
 * `ancestorsOf` stops at the *parent*, which is exactly right for a file — the
 * parent is what has to be open for the file's row to exist. For a directory it
 * left the folder selected, scrolled into view, and firmly shut: the chain
 * reached its parent and no further, so double-clicking a folder path in a
 * terminal landed on the row and stopped there.
 *
 * A file must keep expanding nothing beyond its parent. Opening the containing
 * folder is the point; dumping the reader into a subtree they did not ask for
 * is not.
 */
export function expandChain(p: string, root: string, isDir: boolean): string[] {
  const chain = ancestorsOf(p, root)
  // Only if the reveal actually landed inside the tree — appending a directory
  // whose ancestors are all outside the root would expand an orphan.
  if (isDir && chain.length > 0 && p !== root) chain.push(p)
  return chain
}
