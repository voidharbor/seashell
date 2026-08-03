import { describe, expect, it } from 'vitest'
import { CardStore } from '../../src/main/lookout/card-store.js'

function makeStore(overrides: Partial<{ bytes: Map<string, number | null> }> = {}) {
  const bytes = overrides.bytes ?? new Map<string, number | null>([['p1', 1000]])
  const emitted: number[] = []
  const store = new CardStore({
    bytesOut: (id) => bytes.get(id) ?? null,
    emit: (cards) => emitted.push(cards.length),
    now: () => 42,
  })
  return { store, bytes, emitted }
}

describe('CardStore', () => {
  it('creates a detector card and emits', () => {
    const { store, emitted } = makeStore()
    expect(store.createFromDetector('p1', 'deploy?', 'input')).toBe(true)
    expect(store.cards()).toHaveLength(1)
    expect(store.cards()[0]).toMatchObject({ paneId: 'p1', source: 'detector', draft: null, state: 'active' })
    expect(emitted.length).toBe(1)
  })
  it('records the screen kind a card was born from', () => {
    const { store } = makeStore()
    store.createFromDetector('p1', 'pick one', 'selector')
    expect(store.cards()[0]?.kind).toBe('selector')
    store.createFromPush('p1', 'ship it?', 'yes')
    // A push arrives via the Stop hook, after a turn ends at the input box.
    expect(store.cards()[0]?.kind).toBe('input')
  })
  it('push replaces detector for the same pane', () => {
    const { store } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    expect(store.createFromPush('p1', 'deploy?', 'yes go')).toBe(true)
    expect(store.cards()).toHaveLength(1)
    expect(store.cards()[0]?.source).toBe('push')
    expect(store.cards()[0]?.draft).toBe('yes go')
  })
  it('a dismissed question does not re-card; a new question does', () => {
    const { store } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    store.dismiss(store.cards()[0]!.id)
    expect(store.cards()).toHaveLength(0)
    expect(store.createFromDetector('p1', 'deploy?', 'input')).toBe(false)
    expect(store.createFromDetector('p1', 'other thing?', 'input')).toBe(true)
  })
  // A pane repaints while it sits there waiting — the turn-timing line, the
  // status line, the input box — and a card is created at the exact moment
  // claude finishes rendering its question, so those repaints land right after
  // the baseline. Output volume must never retire an unanswered card, or
  // Approve disables itself seconds after the card appears.
  it('a card on a live pane stays answerable no matter how much the pane paints', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    const card = store.cards()[0]!
    expect(store.isFresh(card)).toBe(true)
    bytes.set('p1', 1_000_000) // a full screen of repaints and then some
    expect(store.isFresh(card)).toBe(true)
    store.sweep()
    expect(store.get(card.id)?.state).toBe('active')
  })
  it('a card is not fresh when its pane restarted and the byte counter dropped below the baseline', () => {
    // A pane restart reuses the pane id and resets the pty's bytesOut
    // counter to 0, so a card created before the restart sees a NEGATIVE
    // delta here. That must never read as fresh: it is a different pty
    // wearing the same pane id, not a quiet one.
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    const card = store.cards()[0]!
    bytes.set('p1', 10) // restarted pane: fresh pty, counter reset well below the 1000 baseline
    expect(store.isFresh(card)).toBe(false)
  })
  it('sweep drops a card when its pane restarted and the byte counter dropped below the baseline', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    const card = store.cards()[0]!
    bytes.set('p1', 10)
    store.sweep()
    expect(store.cards()).toHaveLength(0)
    expect(store.get(card.id)).toBeUndefined()
  })
  it('sweep drops cards whose pane is gone', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    bytes.set('p1', null)
    store.sweep()
    expect(store.cards()).toHaveLength(0)
  })
  it('sweep forgets dismissal memory for a pane that is gone, so a reused pane id is not suppressed by the old session', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    store.dismiss(store.cards()[0]!.id)
    expect(store.createFromDetector('p1', 'deploy?', 'input')).toBe(false) // still suppressed: same session, not yet swept

    bytes.set('p1', null) // pane exits
    store.sweep()

    bytes.set('p1', 0) // pane id reused by a brand new pty/session
    expect(store.createFromDetector('p1', 'deploy?', 'input')).toBe(true)
  })
  it('disabled store refuses creates', () => {
    const { store } = makeStore()
    store.setEnabled(false)
    expect(store.createFromDetector('p1', 'deploy?', 'input')).toBe(false)
    expect(store.createFromPush('p1', 'q?', null)).toBe(false)
  })
  it('mirrors index.ts wiring: emit arms the sweep loop whenever cards remain, so detector cards get swept too', () => {
    // index.ts wraps its CardStore emit dep to send to the window and then
    // arm the sweep timer while cards remain. That is the only place the
    // detector lane (createFromDetector, called from the renderer) ever
    // arms sweep: postCard's own ensureSweepLoop call only ever covered
    // pushed cards. Update this test alongside index.ts if that wiring
    // shape ever changes.
    const bytes = new Map<string, number | null>([['p1', 1000]])
    let armed = false
    const store = new CardStore({
      bytesOut: (id) => bytes.get(id) ?? null,
      emit: (cards) => {
        if (cards.length > 0) armed = true
      },
      now: () => 42,
    })
    expect(store.createFromDetector('p1', 'deploy?', 'input')).toBe(true)
    expect(armed).toBe(true)
  })
})
