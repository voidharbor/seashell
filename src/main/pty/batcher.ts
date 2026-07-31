/**
 * Coalesces many small per-pane PTY writes into one frame-batched IPC
 * message, keyed by paneId.
 *
 * Why this exists (spec §6.6): node-pty can deliver up to ~4,300 chunks/s per
 * pane. Forwarding each chunk as its own IPC message would mean thousands of
 * structured-clone round trips per second per pane, starving the renderer.
 * Instead, writes accumulate in memory and are released together as one
 * `pty:data` message when either a flush deadline elapses or a size
 * threshold is crossed.
 *
 * This module is [pure]: it owns no real timer. The deadline math is driven
 * entirely by `nowMs` values the caller passes into `push`/`shouldFlush`, so
 * a test can simulate an arbitrary amount of elapsed time without waiting on
 * a real clock, and the real caller (elsewhere, non-pure) is free to drive it
 * from `requestAnimationFrame`-style scheduling or a `setInterval`.
 */

import type { PtyDataEvent } from '../../shared/ipc.js'

/** Total pending bytes across all panes that forces an immediate flush. */
export const IMMEDIATE_FLUSH_THRESHOLD_BYTES = 64 * 1024

/** Flush deadline for a pane belonging to the currently active tab. */
export const ACTIVE_FLUSH_INTERVAL_MS = 8

/** Flush deadline for a pane belonging to a background tab. */
export const BACKGROUND_FLUSH_INTERVAL_MS = 100

/**
 * Per-pane cap on buffered-but-unflushed bytes. Exists so a runaway build
 * log (or any pane producing output faster than the renderer can consume,
 * ahead of the separate ack-window backpressure kicking in) cannot grow this
 * buffer without bound and exhaust main-process memory. Chosen to match the
 * ack window's `pause()` threshold (spec §6.6): by the time a pane would hit
 * this cap, real backpressure should already have paused its PTY, so hitting
 * it at all indicates something is actively misbehaving.
 */
export const DEFAULT_MAX_BUFFERED_BYTES_PER_PANE = 1 * 1024 * 1024

interface PaneBuffer {
  /** Pending chunks not yet flushed, in arrival order. */
  chunks: string[]
  /** Sum of `chunks[i].length`. Byte accounting note: callers are expected to
   * decode raw PTY bytes with a byte-preserving encoding (e.g. `latin1`)
   * before calling `push`, so that `string.length` equals the original byte
   * count. (The shared `PtyDataEvent.data` field is a string, not a Buffer —
   * see `src/shared/ipc.ts` — so this module never touches `Buffer` itself,
   * keeping it usable in a bare Node test environment.) */
  pendingBytes: number
  /** Whether this pane currently belongs to the active tab (8ms deadline)
   * vs a background tab (100ms deadline). Defaults to background (safer,
   * less time-sensitive) until told otherwise. */
  active: boolean
  /** Bytes dropped since the last flush because the pane's buffer was full. */
  overflowDroppedBytes: number
}

export interface PtyBatcherOptions {
  /** Overrides `DEFAULT_MAX_BUFFERED_BYTES_PER_PANE`, for testing. */
  maxBufferedBytesPerPane?: number
}

/**
 * Stateful coalescing buffer. Not itself pure (it has mutable state, by
 * design — that's the point of a batcher) but every method is a deterministic
 * function of its arguments and current state, with no hidden clock or I/O,
 * which is what "pure module" means for the purposes of this codebase's test
 * strategy: fully unit-testable with fabricated timestamps.
 */
export class PtyBatcher {
  private readonly maxBufferedBytesPerPane: number
  private readonly panes = new Map<string, PaneBuffer>()
  private totalPendingBytes = 0
  private armedDeadlineMs: number | undefined

  constructor(options: PtyBatcherOptions = {}) {
    this.maxBufferedBytesPerPane = options.maxBufferedBytesPerPane ?? DEFAULT_MAX_BUFFERED_BYTES_PER_PANE
  }

  private getOrCreate(paneId: string): PaneBuffer {
    const existing = this.panes.get(paneId)
    if (existing) return existing
    const created: PaneBuffer = { chunks: [], pendingBytes: 0, active: false, overflowDroppedBytes: 0 }
    this.panes.set(paneId, created)
    return created
  }

  /**
   * Marks whether `paneId` is in the foreground (active) tab. Affects which
   * flush deadline arms when data next arrives for it. Safe to call before
   * any data has been pushed for the pane.
   */
  setPaneActive(paneId: string, active: boolean): void {
    this.getOrCreate(paneId).active = active
  }

  /** Drops all buffered state for a pane, e.g. on pane close/exit. */
  removePane(paneId: string): void {
    const buf = this.panes.get(paneId)
    if (!buf) return
    this.totalPendingBytes -= buf.pendingBytes
    this.panes.delete(paneId)
  }

  /**
   * Appends one PTY read's worth of data for `paneId`.
   *
   * Returns `false` (chunk dropped, not appended) when the pane's buffer is
   * already at `maxBufferedBytesPerPane` — the overflow-with-notice path.
   * The drop is whole-chunk, never a partial truncation, so it can never
   * split an escape sequence mid-stream; the notice injected at the next
   * `flush()` is likewise appended as its own complete chunk, at a clean
   * boundary.
   */
  push(paneId: string, data: string, nowMs: number): boolean {
    if (data.length === 0) return true
    const buf = this.getOrCreate(paneId)

    if (buf.pendingBytes + data.length > this.maxBufferedBytesPerPane) {
      buf.overflowDroppedBytes += data.length
      return false
    }

    buf.chunks.push(data)
    buf.pendingBytes += data.length
    this.totalPendingBytes += data.length

    const interval = buf.active ? ACTIVE_FLUSH_INTERVAL_MS : BACKGROUND_FLUSH_INTERVAL_MS
    const candidateDeadline = nowMs + interval
    if (this.armedDeadlineMs === undefined || candidateDeadline < this.armedDeadlineMs) {
      // First pending byte overall arms the timer. An active-tab pane's data
      // arriving after a background-tab deadline is already armed tightens
      // the deadline instead of waiting for the slower one, so a pane the
      // user is actually looking at is never held hostage by a quieter
      // background pane's longer interval.
      this.armedDeadlineMs = candidateDeadline
    }

    return true
  }

  /**
   * Whether the caller should invoke `flush()` now: either the 64 KiB
   * total-pending threshold was crossed (flush immediately regardless of
   * timing) or the armed deadline has elapsed.
   */
  shouldFlush(nowMs: number): boolean {
    if (this.totalPendingBytes >= IMMEDIATE_FLUSH_THRESHOLD_BYTES) return true
    if (this.armedDeadlineMs !== undefined && nowMs >= this.armedDeadlineMs) return true
    return false
  }

  /**
   * Drains every pane's pending chunks into one `PtyDataEvent`, joining each
   * pane's chunks with `Buffer.concat`-equivalent string concatenation, and
   * disarms the timer. Any pane that dropped data since the last flush gets
   * a plain-text notice appended as its own trailing chunk (never spliced
   * into the middle of real output). Returns `undefined` if there is nothing
   * to send, so callers don't emit empty IPC messages on every idle tick.
   */
  flush(): PtyDataEvent | undefined {
    const batches: PtyDataEvent['batches'] = []

    for (const [paneId, buf] of this.panes) {
      if (buf.overflowDroppedBytes > 0) {
        buf.chunks.push(
          `\r\n\x1b[33m[SeaShell: dropped ${String(buf.overflowDroppedBytes)} bytes, pane buffer full]\x1b[0m\r\n`,
        )
        buf.overflowDroppedBytes = 0
      }

      if (buf.chunks.length === 0) continue

      batches.push({ paneId, data: buf.chunks.join('') })
      buf.chunks = []
      buf.pendingBytes = 0
    }

    this.totalPendingBytes = 0
    this.armedDeadlineMs = undefined

    if (batches.length === 0) return undefined
    return { batches }
  }
}
