import { describe, expect, it } from 'vitest'
import {
  ACTIVE_FLUSH_INTERVAL_MS,
  BACKGROUND_FLUSH_INTERVAL_MS,
  IMMEDIATE_FLUSH_THRESHOLD_BYTES,
  PtyBatcher,
} from '../../src/main/pty/batcher.js'

describe('PtyBatcher coalescing', () => {
  it('does not flush before the armed deadline elapses', () => {
    const batcher = new PtyBatcher()
    batcher.push('pane-1', 'hello ', 0)
    batcher.push('pane-1', 'world', 1)
    expect(batcher.shouldFlush(1)).toBe(false)
    expect(batcher.shouldFlush(BACKGROUND_FLUSH_INTERVAL_MS - 1)).toBe(false)
  })

  it('flushes once the background deadline elapses, joining chunks in arrival order', () => {
    const batcher = new PtyBatcher()
    batcher.push('pane-1', 'hello ', 0)
    batcher.push('pane-1', 'world', 1)

    expect(batcher.shouldFlush(BACKGROUND_FLUSH_INTERVAL_MS)).toBe(true)
    const result = batcher.flush()
    expect(result).toEqual({ batches: [{ paneId: 'pane-1', data: 'hello world' }] })
  })

  it('flush() returns undefined when nothing is pending', () => {
    const batcher = new PtyBatcher()
    expect(batcher.flush()).toBeUndefined()
  })

  it('uses the faster active-tab interval for a pane marked active', () => {
    const batcher = new PtyBatcher()
    batcher.setPaneActive('pane-1', true)
    batcher.push('pane-1', 'x', 0)

    expect(batcher.shouldFlush(ACTIVE_FLUSH_INTERVAL_MS - 1)).toBe(false)
    expect(batcher.shouldFlush(ACTIVE_FLUSH_INTERVAL_MS)).toBe(true)
  })

  it('defaults an unmarked pane to the slower background interval', () => {
    const batcher = new PtyBatcher()
    batcher.push('pane-1', 'x', 0)

    expect(batcher.shouldFlush(ACTIVE_FLUSH_INTERVAL_MS)).toBe(false)
    expect(batcher.shouldFlush(BACKGROUND_FLUSH_INTERVAL_MS)).toBe(true)
  })

  it('batches multiple panes into a single flush, each with its own joined data', () => {
    const batcher = new PtyBatcher()
    batcher.push('pane-1', 'aaa', 0)
    batcher.push('pane-2', 'bbb', 0)
    batcher.push('pane-1', 'ccc', 1)

    const result = batcher.flush()
    expect(result?.batches).toHaveLength(2)
    expect(result?.batches).toEqual(
      expect.arrayContaining([
        { paneId: 'pane-1', data: 'aaaccc' },
        { paneId: 'pane-2', data: 'bbb' },
      ]),
    )
  })

  it('forces an immediate flush once total pending crosses the 64 KiB threshold, even before any deadline', () => {
    const batcher = new PtyBatcher()
    const big = 'x'.repeat(IMMEDIATE_FLUSH_THRESHOLD_BYTES)
    batcher.push('pane-1', big, 0)

    // Well before the 100ms background deadline.
    expect(batcher.shouldFlush(1)).toBe(true)
  })

  it('tightens an already-armed background deadline when an active pane pushes afterward', () => {
    const batcher = new PtyBatcher()
    batcher.push('pane-bg', 'slow', 0) // arms a 100ms-out deadline
    batcher.setPaneActive('pane-active', true)
    batcher.push('pane-active', 'fast', 1) // should tighten the deadline to 1 + 8 = 9

    expect(batcher.shouldFlush(9)).toBe(true)
    expect(batcher.shouldFlush(8)).toBe(false)
  })

  it('flush() disarms the deadline so an empty batcher does not immediately re-flush', () => {
    const batcher = new PtyBatcher()
    batcher.push('pane-1', 'x', 0)
    batcher.flush()
    expect(batcher.shouldFlush(1_000_000)).toBe(false)
  })

  it('removePane clears pending bytes so they no longer count toward totals or a later flush', () => {
    const batcher = new PtyBatcher()
    batcher.push('pane-1', 'x'.repeat(100), 0)
    batcher.removePane('pane-1')
    expect(batcher.flush()).toBeUndefined()
  })
})

describe('PtyBatcher overflow', () => {
  it('drops a chunk that would exceed the per-pane cap and reports it as not accepted', () => {
    const batcher = new PtyBatcher({ maxBufferedBytesPerPane: 10 })
    expect(batcher.push('pane-1', '0123456789', 0)).toBe(true) // exactly at cap
    expect(batcher.push('pane-1', 'more', 1)).toBe(false) // would exceed cap -> dropped
  })

  it('appends a trailing overflow notice on the next flush instead of silently losing data', () => {
    const batcher = new PtyBatcher({ maxBufferedBytesPerPane: 10 })
    batcher.push('pane-1', '0123456789', 0)
    batcher.push('pane-1', 'dropped-chunk', 1)

    const result = batcher.flush()
    expect(result).toBeDefined()
    const paneBatch = result?.batches.find((b) => b.paneId === 'pane-1')
    expect(paneBatch?.data.startsWith('0123456789')).toBe(true)
    expect(paneBatch?.data).toContain('dropped')
    expect(paneBatch?.data).toContain('13') // 'dropped-chunk'.length === 13
  })

  it('does not corrupt buffered real data — the overflow notice is appended, not spliced in', () => {
    const batcher = new PtyBatcher({ maxBufferedBytesPerPane: 5 })
    batcher.push('pane-1', 'abcde', 0) // fills the cap exactly
    batcher.push('pane-1', 'z', 1) // dropped

    const result = batcher.flush()
    const data = result?.batches[0]?.data ?? ''
    expect(data.startsWith('abcde')).toBe(true)
  })

  it('clears the overflow flag after reporting it, so a clean subsequent flush has no notice', () => {
    const batcher = new PtyBatcher({ maxBufferedBytesPerPane: 5 })
    batcher.push('pane-1', 'abcde', 0)
    batcher.push('pane-1', 'z', 1) // dropped, recorded
    batcher.flush() // reports the notice once

    batcher.push('pane-1', 'fresh', 100)
    const second = batcher.flush()
    expect(second?.batches[0]?.data).toBe('fresh')
  })

  it('an overflow with no other pending data for the pane still surfaces a notice on flush', () => {
    const batcher = new PtyBatcher({ maxBufferedBytesPerPane: 5 })
    batcher.push('pane-1', 'abcde', 0) // fill cap
    batcher.flush() // drains it, buffer now empty but cap still 5
    batcher.push('pane-1', 'toolong', 1) // exceeds cap on an empty buffer -> dropped

    const result = batcher.flush()
    expect(result).toBeDefined()
    expect(result?.batches[0]?.data).toContain('dropped')
  })
})

/**
 * The flush loop's lifetime.
 *
 * The loop runs at the active deadline — 8ms — so whether it is running at all
 * is a real cost, not a detail: it used to be armed by the first spawn and
 * cleared only by the last close, which is 125 timer wakeups a second in the
 * main process for the whole life of the app, including a window full of panes
 * all sitting quietly at a prompt.
 *
 * `shouldFlush` cannot answer "is the loop still needed", because it is
 * deliberately false while data waits inside its deadline — precisely when the
 * loop must keep running. Hence a separate question.
 */
describe('PtyBatcher.hasPending', () => {
  it('is false for a batcher nobody has written to', () => {
    expect(new PtyBatcher().hasPending()).toBe(false)
  })

  it('is true while data waits inside its deadline', () => {
    const batcher = new PtyBatcher()
    batcher.push('pane-1', 'hello', 0)
    // Not yet due to flush, and yet the loop must not stop.
    expect(batcher.shouldFlush(1)).toBe(false)
    expect(batcher.hasPending()).toBe(true)
  })

  it('is false again once everything has been drained', () => {
    const batcher = new PtyBatcher()
    batcher.push('pane-1', 'hello', 0)
    batcher.flush()
    expect(batcher.hasPending()).toBe(false)
  })

  it('stays true for an overflow notice that owes a pane an explanation', () => {
    const batcher = new PtyBatcher({ maxBufferedBytesPerPane: 8 })
    // Dropped outright: no chunk buffered and no byte counted.
    expect(batcher.push('pane-1', 'x'.repeat(64), 0)).toBe(false)
    // The notice still has to reach the user, so the loop must stay alive and
    // the deadline must be reachable — otherwise a single overflowing pane
    // waits for some unrelated write that may never come.
    expect(batcher.hasPending()).toBe(true)
    // A pane defaults to the background deadline until told otherwise.
    expect(batcher.shouldFlush(BACKGROUND_FLUSH_INTERVAL_MS)).toBe(true)
    expect(batcher.flush()?.batches[0]?.data).toContain('dropped')
    expect(batcher.hasPending()).toBe(false)
  })

  it('never reports work that no flush could ever drain', () => {
    // The loop stops when this goes false and spins when it is true, so a
    // "pending but unflushable" state would spin at 8ms forever.
    const batcher = new PtyBatcher({ maxBufferedBytesPerPane: 8 })
    batcher.push('pane-1', 'x'.repeat(64), 0)
    batcher.push('pane-2', 'ok', 0)
    expect(batcher.hasPending()).toBe(true)
    expect(batcher.shouldFlush(BACKGROUND_FLUSH_INTERVAL_MS)).toBe(true)
    batcher.flush()
    expect(batcher.hasPending()).toBe(false)
  })

  it('goes quiet after a burst rather than staying armed', () => {
    const batcher = new PtyBatcher()
    for (let i = 0; i < 50; i++) batcher.push('pane-1', 'line\r\n', i)
    expect(batcher.hasPending()).toBe(true)
    batcher.flush()
    expect(batcher.hasPending()).toBe(false)
  })
})
