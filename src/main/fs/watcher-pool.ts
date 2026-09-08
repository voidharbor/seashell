import { ALWAYS_HIDDEN_NAMES } from './gitignore.js'

/** Which directories to drop so the pool is back under `max`, oldest touch first. [pure] */
export function pickEvictions(entries: Array<{ dir: string; lastTouch: number }>, max: number): string[] {
  const over = entries.length - max
  if (over <= 0) return []
  return [...entries]
    .sort((a, b) => a.lastTouch - b.lastTouch)
    .slice(0, over)
    .map((e) => e.dir)
}

/** The explorer never lists these, so it never expands them; refuse them
 *  anyway so a bad request cannot pin a watch on node_modules. [pure] */
export function isWatchable(dir: string): boolean {
  return !dir.split(/[\\/]/).some((seg) => ALWAYS_HIDDEN_NAMES.has(seg))
}
