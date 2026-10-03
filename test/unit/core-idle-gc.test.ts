import { describe, expect, it } from 'vitest'
import { startIdleCollector } from '../../src/core/idle-gc.js'

function harness(rssSeq: number[]) {
  let i = 0; let t = 0; let lastPty = 0; const gcs: number[] = []; const ticks: Array<() => void> = []
  const c = startIdleCollector({
    rss: () => rssSeq[Math.min(i, rssSeq.length - 1)]! * 1024 * 1024,
    lastPtyActivity: () => lastPty, now: () => t, gc: () => gcs.push(t),
    setInterval: (fn) => { ticks.push(fn); return 0 }, log: () => {},
  })
  const tick = (ms: number, pty = false) => { t += ms; if (pty) lastPty = t; ticks[0]!(); i++ }
  return { tick, gcs, stop: c.stop }
}

describe('idle collector', () => {
  it('collects once when RSS sits 30 MB over its floor with no pty traffic for 3 s', () => {
    const h = harness([70, 70, 120, 120, 120])
    h.tick(5000); h.tick(5000); h.tick(5000)
    expect(h.gcs).toHaveLength(1)
    h.tick(5000); h.tick(5000)
    expect(h.gcs).toHaveLength(1)   // not again until it grows another 30 MB
  })
  it('waits while bytes are still flowing', () => {
    const h = harness([70, 120, 120, 120])
    h.tick(5000, true); h.tick(2000, true)
    expect(h.gcs).toHaveLength(0)
    h.tick(5000)
    expect(h.gcs).toHaveLength(1)
  })
  it('takes its floor when it starts, so a flood before the first tick still counts', () => {
    let rss = 60; const gcs: number[] = []; const ticks: Array<() => void> = []
    startIdleCollector({
      rss: () => rss * 1024 * 1024, lastPtyActivity: () => 0, now: () => 10_000, gc: () => gcs.push(1),
      setInterval: (fn) => { ticks.push(fn); return 0 }, log: () => {},
    })
    rss = 120
    ticks[0]!()
    expect(gcs).toHaveLength(1)
  })
  it('does nothing without a gc function', () => {
    let called = 0
    const c = startIdleCollector({ rss: () => 500e6, lastPtyActivity: () => 0, now: () => 10_000, gc: undefined, setInterval: (fn) => { fn(); return 0 }, log: () => { called++ } })
    expect(called).toBe(0); c.stop()
  })
})
