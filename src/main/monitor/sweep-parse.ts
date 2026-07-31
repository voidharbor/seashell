/**
 * Parses the STDOUT of `ps -axo pid,ppid,rss,pcpu,stat,comm` into a process
 * tree and sums RSS over a subtree.
 *
 * This module is [pure]: it never runs `ps` itself. Keeping the string-in,
 * struct-out boundary here means the parsing and tree-walking logic — the
 * part with actual edge cases (cycles, vanished pids, orphans) — is testable
 * with plain fixture strings in a bare Node environment, with no process
 * spawning, timers, or Electron involved.
 */

/** One parsed row of `ps` output. */
export interface ProcessRow {
  pid: number
  ppid: number
  /** As reported by `ps`, in kilobytes. See the honesty note on `sumSubtreeRss`. */
  rssKb: number
  pcpu: number
  stat: string
  /** `ps`'s `comm` column. May contain spaces (e.g. an app bundle path). */
  comm: string
}

/** A parsed snapshot: every row, plus a ppid -> children index built from it. */
export interface ProcessTree {
  rows: Map<number, ProcessRow>
  childrenOf: Map<number, number[]>
}

const FIELD_COUNT = 5 // pid, ppid, rss, pcpu, stat — comm is everything left over

/**
 * Splits one `ps` line into its five fixed fields plus a `comm` remainder.
 *
 * `comm` is rejoined with single spaces rather than taken as the 6th
 * whitespace token, because `ps -o comm` on macOS prints the resolved
 * executable path, which can itself contain spaces (e.g.
 * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`). Splitting
 * on whitespace and rejoining the tail recovers that exactly, since the only
 * separators inside the original line are single literal spaces.
 */
function splitLine(line: string): string[] | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  const parts = trimmed.split(/\s+/)
  if (parts.length < FIELD_COUNT + 1) return undefined
  const head = parts.slice(0, FIELD_COUNT)
  const comm = parts.slice(FIELD_COUNT).join(' ')
  return [...head, comm]
}

/**
 * Parses full `ps -axo pid,ppid,rss,pcpu,stat,comm` stdout into a process
 * tree. Skips the header row and any malformed line rather than throwing,
 * because a sweep is best-effort telemetry, not a correctness-critical path:
 * a single garbled line (or the header itself, whose "PID" column fails the
 * numeric check the same as any other bad row) should not lose every other
 * row in the snapshot.
 */
export function parsePsOutput(stdout: string): ProcessTree {
  const rows = new Map<number, ProcessRow>()
  const childrenOf = new Map<number, number[]>()

  for (const line of stdout.split('\n')) {
    const fields = splitLine(line)
    if (!fields) continue
    const [pidStr, ppidStr, rssStr, pcpuStr, stat, comm] = fields
    if (
      pidStr === undefined ||
      ppidStr === undefined ||
      rssStr === undefined ||
      pcpuStr === undefined ||
      stat === undefined ||
      comm === undefined
    ) {
      continue
    }

    const pid = Number(pidStr)
    const ppid = Number(ppidStr)
    const rssKb = Number(rssStr)
    const pcpu = Number(pcpuStr)
    // Also rejects the header row: "PID"/"PPID"/etc. are not finite numbers.
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb) || !Number.isFinite(pcpu)) {
      continue
    }

    rows.set(pid, { pid, ppid, rssKb, pcpu, stat, comm })
    const siblings = childrenOf.get(ppid)
    if (siblings) {
      siblings.push(pid)
    } else {
      childrenOf.set(ppid, [pid])
    }
  }

  return { rows, childrenOf }
}

/** Result of summing RSS over a process subtree rooted at some pid. */
export interface SubtreeRssSum {
  rootPid: number
  /** Every pid actually found and counted, including the root. */
  pids: number[]
  /**
   * Sum of `ps`'s `rss` column (KB) across every process in the subtree.
   *
   * HONESTY NOTE — this over-counts and must never be presented as "memory
   * used by this pane". `ps` RSS includes shared pages (dynamic linker
   * caches, shared frameworks, `__TEXT`/`__DATA_CONST` mapped by every
   * process running the same binary), so summing it across a tree adds that
   * shared memory once per process instead of once total. It also excludes
   * compressed and swapped-out pages, which can make a heavily-idle,
   * neglected process look smaller than it really is. The only honest
   * per-pane figure is `phys_footprint` (see `system-mem.ts` and the spec's
   * §10.2), which is not available from `ps` at all — hence this function's
   * result is named `rssSumKb`, not `memoryUsageKb` or `footprintKb`.
   */
  rssSumKb: number
  /** True when `rootPid` itself was not present in the sweep (already exited). */
  rootMissing: boolean
}

/**
 * Sums RSS over the subtree rooted at `rootPid` using an explicit-stack DFS.
 *
 * Defends against three things that are guaranteed to happen in a live
 * sweep of a real process tree, per the spec:
 *  - `rootPid` itself vanished between the caller sampling it and the sweep
 *    running (`rootMissing: true`, empty sum — never throws).
 *  - a pid recorded as someone's child vanished mid-sweep before its own row
 *    was captured (its ppid-recorded existence outlives its row); such a
 *    pid is silently skipped rather than crashing the walk.
 *  - a ppid cycle (malformed/adversarial input — a real kernel process tree
 *    can't produce one, but nothing should hang if fixture or corrupted data
 *    does). A `visited` set makes revisiting any pid a no-op, so a cycle
 *    degrades to "counted once" instead of an infinite loop.
 *
 * Reparented descendants (e.g. a backgrounded job that got adopted by
 * launchd, ppid 1) are correctly excluded here — they are no longer part of
 * this ppid-based tree. Catching those requires matching on controlling tty
 * (`e_tdev`), which needs the native `seashell-procsweep` helper's richer
 * output and is out of scope for this `ps`-based parser.
 */
export function sumSubtreeRss(tree: ProcessTree, rootPid: number): SubtreeRssSum {
  const rootRow = tree.rows.get(rootPid)
  if (!rootRow) {
    return { rootPid, pids: [], rssSumKb: 0, rootMissing: true }
  }

  const visited = new Set<number>()
  const pids: number[] = []
  let rssSumKb = 0
  const stack: number[] = [rootPid]

  while (stack.length > 0) {
    const pid = stack.pop()
    if (pid === undefined) continue
    if (visited.has(pid)) continue // cycle guard: already counted
    visited.add(pid)

    const row = tree.rows.get(pid)
    if (!row) continue // vanished mid-sweep: recorded as a child, but no row of its own

    pids.push(pid)
    rssSumKb += row.rssKb

    const children = tree.childrenOf.get(pid)
    if (children) {
      for (const child of children) {
        if (!visited.has(child)) stack.push(child)
      }
    }
  }

  return { rootPid, pids, rssSumKb, rootMissing: false }
}
