import { describe, expect, it } from 'vitest'
import { CardStore } from '../../src/main/lookout/card-store.js'
import { approveCard } from '../../src/main/lookout/approve.js'

function setup(
  opts: {
    foreground?: boolean
    tty?: string | null
    screenKind?: 'input' | 'selector' | null
  } = {}
) {
  const bytes = new Map<string, number | null>([['p1', 500]])
  const store = new CardStore({ bytesOut: (id) => bytes.get(id) ?? null, emit: () => {}, now: () => 1 })
  store.createFromPush('p1', 'ship it?', 'yes ship')
  const writes: string[] = []
  const deps = {
    store,
    paneTty: () => (opts.tty === undefined ? 'ttys009' : opts.tty),
    checkForeground: async () => opts.foreground ?? true,
    writeIfLive: (_id: string, data: string) => { writes.push(data); return true },
    screenKind: () => (opts.screenKind === undefined ? ('input' as const) : opts.screenKind),
  }
  return { store, deps, writes, bytes, cardId: store.cards()[0]!.id }
}

describe('approveCard', () => {
  it('writes text then a single Enter and removes the card', async () => {
    const { deps, writes, cardId, store } = setup()
    const res = await approveCard(deps, { cardId, text: 'yes ship' })
    expect(res.ok).toBe(true)
    expect(writes).toEqual(['yes ship', '\r'])
    expect(store.cards()).toHaveLength(0)
  })
  // The pane restarted under the card: a different pty wearing the same pane
  // id. Byte volume no longer retires a card, but a counter that went
  // BACKWARDS still means the session the card belongs to is gone.
  it('refuses a card whose pane restarted, without writing', async () => {
    const { deps, writes, cardId, bytes, store } = setup()
    bytes.set('p1', 10) // below the creation baseline
    const res = await approveCard(deps, { cardId, text: 'yes ship' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ESTALE')
    expect(writes).toHaveLength(0)
    expect(store.get(cardId)?.state).toBe('stale')
  })
  it('still writes after the pane has painted a great deal', async () => {
    const { deps, writes, cardId, bytes } = setup()
    bytes.set('p1', 1_000_000)
    const res = await approveCard(deps, { cardId, text: 'yes ship' })
    expect(res.ok).toBe(true)
    expect(writes).toEqual(['yes ship', '\r'])
  })
  it('refuses when foreground is not claude', async () => {
    const { deps, writes, cardId } = setup({ foreground: false })
    const res = await approveCard(deps, { cardId, text: 'ok' })
    if (!res.ok) expect(res.code).toBe('EFOREGROUND')
    expect(writes).toHaveLength(0)
  })
  it('refuses control characters and over-long text', async () => {
    const { deps, cardId } = setup()
    const a = await approveCard(deps, { cardId, text: 'a\nb' })
    if (!a.ok) expect(a.code).toBe('EINVALID')
    const b = await approveCard(deps, { cardId, text: 'x'.repeat(4001) })
    if (!b.ok) expect(b.code).toBe('EINVALID')
  })
  it('refuses a gone pane', async () => {
    const { deps, cardId } = setup({ tty: null })
    const res = await approveCard(deps, { cardId, text: 'ok' })
    if (!res.ok) expect(res.code).toBe('EGONE')
  })
  it('refuses while the pane is showing a selector screen, and writes nothing', async () => {
    // Typed text + Enter on a picker blind-confirms the highlighted option.
    // The renderer gates this too, but its read lags main's pty stream — this
    // is the check that has to hold when the renderer's is stale.
    const { deps, writes, cardId, store } = setup({ screenKind: 'selector' })
    const res = await approveCard(deps, { cardId, text: 'yes ship' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ESELECTOR')
    expect(writes).toHaveLength(0)
    // The card is not stale — the session did not move on — so it stays.
    expect(store.get(cardId)?.state).toBe('active')
  })
  it('refuses a card born from a selector screen even when the live read is blind', async () => {
    const { deps, writes } = setup({ screenKind: null })
    deps.store.remove(deps.store.cards()[0]!.id)
    deps.store.createFromDetector('p1', 'pick one — options: 1. Yes / 2. No', 'selector')
    const cardId = deps.store.cards()[0]!.id
    const res = await approveCard(deps, { cardId, text: 'yes' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ESELECTOR')
    expect(writes).toHaveLength(0)
  })
  /**
   * The render-to-click window is not the only window. `checkForeground` shells
   * out to `ps` — tens of milliseconds during which the pane keeps painting —
   * and the selector check sat entirely BEFORE that await. So a pane that was
   * at an input box when the click arrived, and painted an AskUserQuestion
   * picker while the `ps` was in flight, still reached the write: text, then
   * the only Enter in the system, into a live picker. Enter on a picker
   * confirms whatever option is highlighted, which is the one outcome this
   * whole subsystem exists to make impossible.
   *
   * The check has to be re-asked on the far side of every await, immediately
   * before the write, for the same reason every other guard here re-validates
   * at click time instead of trusting what the card was born with.
   */
  it('refuses a picker that paints DURING the foreground check, and writes nothing', async () => {
    const { deps, writes, cardId, store } = setup()
    let screen: 'input' | 'selector' = 'input'
    deps.screenKind = () => screen
    deps.checkForeground = async () => {
      // The pane repaints as a picker while `ps` is in flight.
      screen = 'selector'
      return true
    }
    const res = await approveCard(deps, { cardId, text: 'yes ship' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ESELECTOR')
    expect(writes).toHaveLength(0)
    // Not stale: the session has not moved on, the user answers in the pane.
    expect(store.get(cardId)?.state).toBe('active')
  })

  it('refuses a card already marked stale even when the byte delta is small', async () => {
    // markStale is main's own verdict (e.g. a failed foreground check); the
    // renderer disables the buttons, and main must agree with itself.
    const { deps, writes, cardId, store } = setup()
    store.markStale(cardId)
    const res = await approveCard(deps, { cardId, text: 'yes ship' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ESTALE')
    expect(writes).toHaveLength(0)
  })
})
