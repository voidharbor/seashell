/**
 * Returns a flood's memory to the OS once the core goes quiet (Phase 1
 * follow-up 2). A 50 MB flood leaves the core about 60 MB over its floor
 * (about 20 MB of it V8's young generation, grown to its maximum), and V8 on
 * its own hands most of that back over a minute or two. Under `--expose-gc`
 * one collection does it at once, but only while no pty is writing, so the
 * pause never lands in the middle of output.
 */

const MB = 1024 * 1024
/** How far over its floor RSS must sit before a collection is worth a pause. */
const OVER_FLOOR_BYTES = 30 * MB
/** No pty output for this long counts as idle. */
const QUIET_MS = 3000
const TICK_MS = 5000

export interface IdleCollectorOptions {
  /** The process's resident set, in bytes. */
  rss: () => number
  /** When any pty last produced output, in `now()` milliseconds; 0 for never. */
  lastPtyActivity: () => number
  now: () => number
  /** `global.gc`, defined only under `node --expose-gc`. */
  gc: (() => void) | undefined
  setInterval: (fn: () => void, ms: number) => unknown
  log: (s: string) => void
}

const mb = (bytes: number): string => (bytes / MB).toFixed(1)

/**
 * Every 5 s: the floor is the lowest RSS seen so far, so a quiet core sets it
 * within its first minute. The first sample is taken at the start, not on the
 * first tick: a pane can start a flood within a second of boot, and a floor
 * first read in the middle of it is never left far enough behind to collect.
 * Start it after boot, so what boot loads counts as floor.
 *
 * When RSS sits more than 30 MB over the floor, no pty has written for 3 s and
 * `gc` exists, collect once and log the change. A collection then restarts
 * the floor at the RSS it left behind (and later ticks lower it further, since
 * the OS gets pages back a little after the call returns), so the next one
 * waits until RSS has grown another 30 MB over its post-collection level and a
 * heap that is genuinely live is not collected again on every tick. That
 * level is never under the all-time lowest, so the plain "30 MB over the
 * lowest seen" rule still holds too.
 */
export function startIdleCollector(opts: IdleCollectorOptions): { stop(): void } {
  let stopped = false
  /** The lowest RSS since the start, or since the last collection. */
  let floor = Infinity

  const tick = (): void => {
    const gc = opts.gc
    if (stopped || !gc) return
    const before = opts.rss()
    floor = Math.min(floor, before)
    if (before <= floor + OVER_FLOOR_BYTES) return
    if (opts.now() - opts.lastPtyActivity() <= QUIET_MS) return
    gc()
    const after = opts.rss()
    floor = after
    opts.log(`idle gc: ${mb(before)} -> ${mb(after)} MB`)
  }

  if (opts.gc) floor = opts.rss()
  const handle = opts.setInterval(tick, TICK_MS)
  return {
    stop(): void {
      stopped = true
      clearInterval(handle as Parameters<typeof clearInterval>[0])
    },
  }
}
