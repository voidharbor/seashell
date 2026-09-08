import { describe, expect, it, vi } from 'vitest'
import { createSnapshotGate } from '../../src/main/state/snapshot-gate.js'

/**
 * The wait that quit hangs on. `awaitSnapshot` in the router is this gate plus
 * one `win.webContents.send`, so the fake window below stands in for the real
 * one and the timing is all that is under test.
 */
const fakeWin = (): { webContents: { send: (channel: string) => void } } => ({
  webContents: { send: vi.fn<(channel: string) => void>() },
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('snapshot gate', () => {
  it('asks the window once and resolves when the timeout passes', async () => {
    const gate = createSnapshotGate()
    const win = fakeWin()
    const t0 = Date.now()
    await gate.request(() => win.webContents.send('session:request-snapshot'), 20)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
  })

  it('resolves as soon as the save handler answers', async () => {
    const gate = createSnapshotGate()
    const win = fakeWin()
    let done = false
    const p = gate.request(() => win.webContents.send('session:request-snapshot'), 60_000).then(() => {
      done = true
    })
    await tick()
    expect(done).toBe(false)
    gate.answer()
    await p
    expect(done).toBe(true)
  })

  it('resolves when the clear handler answers instead', async () => {
    // A renderer with nothing worth keeping clears rather than saves, and that
    // is just as much an answer: quit must not sit out the timeout for it.
    const gate = createSnapshotGate()
    const win = fakeWin()
    let done = false
    const p = gate.request(() => win.webContents.send('session:request-snapshot'), 60_000).then(() => {
      done = true
    })
    await tick()
    gate.answer()
    await p
    expect(done).toBe(true)
  })

  it('resolves at once when there is nobody to ask', async () => {
    const gate = createSnapshotGate()
    await gate.request(() => {
      throw new Error('window destroyed')
    }, 60_000)
  })

  it('a late answer after the timeout is a no-op', async () => {
    const gate = createSnapshotGate()
    const win = fakeWin()
    await gate.request(() => win.webContents.send('session:request-snapshot'), 10)
    expect(() => gate.answer()).not.toThrow()

    // And the stale answer above did not consume the next request's slot.
    let done = false
    const p = gate.request(() => win.webContents.send('session:request-snapshot'), 60_000).then(() => {
      done = true
    })
    await tick()
    expect(done).toBe(false)
    gate.answer()
    await p
    expect(done).toBe(true)
  })

  it('an answer with nothing pending is a no-op', () => {
    const gate = createSnapshotGate()
    expect(() => gate.answer()).not.toThrow()
  })
})
