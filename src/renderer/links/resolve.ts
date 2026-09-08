/**
 * What a double-clicked path resolves to. [pure, apart from two injected calls]
 *
 * A pane and the shell drawer both hit-test a double-click against their own
 * xterm buffer, and both then have to answer the same question: given this
 * token, this row and this working directory, which file did the user mean,
 * and if none, what should it say? That question was answered twice, in two
 * copies of the same handler, and the two copies had already drifted. It lives
 * here once instead, with the filesystem reached only through `deps`, so every
 * branch is testable in bare node.
 */
import { isSuffixCandidate, joinCandidates, normaliseSuffix } from './wrap-join.js'

/** What `pathAtPoint` found: the token, its column span on the clicked row
 *  (`[start, end)`, 0-based), and the absolute (1-based) buffer row. */
export interface PathHit {
  path: string
  start: number
  end: number
  absY: number
}

/** What `rowContext` read off the buffer around the hit. */
export interface RowContext {
  prevRow: string | null
  nextRow: string | null
  startCol: number
  endCol: number
  cols: number
}

export interface ResolveDeps {
  statBatch: (req: {
    cwd: string
    candidates: string[]
  }) => Promise<{ results: Array<{ i: number; resolved: string; kind: 'file' | 'dir' | 'other' }> }>
  findBySuffix: (req: {
    root: string
    suffix: string
    limit: number
  }) => Promise<{ paths: string[]; truncated: boolean }>
}

export interface ResolveHit {
  resolved: string
  isDir: boolean
}

/** A miss always carries a message. Silence is what made this feature read as
 *  dead: a near miss and a dead handler produced exactly the same nothing. */
export type ResolveOutcome = { kind: 'hit'; hit: ResolveHit } | { kind: 'miss'; message: string }

/** How many matches a suffix search asks for. Three are named in the toast;
 *  the rest only have to be enough to say "more than one". */
const SUFFIX_LIMIT = 10

export interface ResolveInput {
  hit: PathHit
  rows: RowContext
  /** The directory a relative candidate is resolved against. */
  cwd: string
  /** The explorer's root: as much of the disk as a suffix search may walk. */
  searchRoot: string
}

export async function resolvePathClick(input: ResolveInput, deps: ResolveDeps): Promise<ResolveOutcome> {
  const { hit, rows, cwd, searchRoot } = input

  /**
   * `…/renderer/app.tsx`. The leading segments are gone, so there is nothing
   * to resolve against a working directory; the only way back to the file is
   * to search for the tail that survived.
   *
   * The pane's own directory is searched first, and the explorer's root only
   * if that finds nothing. Not an optimisation: measured on the machine this
   * was written for, the explorer root is the home directory (it is set once
   * at boot and never reassigned), and a walk from there spends its whole
   * 50,000-entry budget in ~/Library and friends after 3 seconds without ever
   * reaching a project six directories down. The same search rooted at the
   * repo the pane is sitting in answers in 22ms. A truncated path was printed
   * by a program running in that directory, so it is also the likelier answer,
   * not merely the cheaper one.
   */
  if (isSuffixCandidate(hit.path)) {
    const suffix = normaliseSuffix(hit.path)
    const roots = cwd && cwd !== searchRoot ? [cwd, searchRoot] : [searchRoot]
    let found = { paths: [] as string[], truncated: false }
    let searched = searchRoot
    for (const root of roots) {
      searched = root
      found = await deps.findBySuffix({ root, suffix, limit: SUFFIX_LIMIT })
      // A narrower root that found something is the better answer, and the
      // wider one would only add copies of it from other checkouts.
      if (found.paths.length > 0) break
    }
    if (found.paths.length === 1) return { kind: 'hit', hit: { resolved: found.paths[0]!, isDir: false } }
    if (found.paths.length === 0) {
      // A truncated search that found nothing did not prove there is nothing:
      // it ran out of budget. Saying "nothing ends in this" would be a claim
      // the walk never actually made.
      return {
        kind: 'miss',
        message: found.truncated
          ? `Gave up searching ${searched} for something ending in ${suffix}`
          : `Nothing under ${searched} ends in ${suffix}`,
      }
    }
    /**
     * Several. Guessing one would open the wrong file half the time, so the
     * toast names enough of them for the user to retype the one they meant.
     *
     * The count is a lower bound whenever the walk stopped early, and it stops
     * early for two different reasons: the limit (so `10+`) and the visit
     * budget, which under a home directory can trip after only a handful of
     * matches. Deriving the `+` from what was actually found says `2+` there
     * instead of inventing eight files that were never seen.
     */
    const count = found.truncated ? `${found.paths.length}+` : String(found.paths.length)
    return {
      kind: 'miss',
      message: `${count} files end in ${suffix}: ${found.paths.slice(0, 3).join(', ')}`,
    }
  }

  /**
   * Everything else. `joinCandidates` adds the hard-wrapped forms, and they
   * all go in one round trip: statBatch omits what does not exist, so the
   * lowest surviving index is the earliest candidate that is a real file.
   *
   * A file outranks a directory whatever the order, because of where a hard
   * wrap usually falls. `/Users/j/repo/src/renderer/links/` broken at the
   * screen edge leaves a prefix that ends on a separator, so the unjoined
   * candidate is a real directory and would win on index alone, revealing the
   * folder the user was looking past. The joined form only exists as a file
   * when the wrap really did split that path, so preferring it costs nothing.
   */
  const candidates = joinCandidates({ candidate: hit.path, ...rows })
  const res = await deps.statBatch({ cwd, candidates })
  const byIndex = [...res.results].sort((a, b) => a.i - b.i)
  const first = byIndex.find((r) => r.kind !== 'dir') ?? byIndex[0]
  if (first) return { kind: 'hit', hit: { resolved: first.resolved, isDir: first.kind === 'dir' } }
  return {
    kind: 'miss',
    message: `No file at ${hit.path} from ${cwd || 'an unknown directory'}`,
  }
}
