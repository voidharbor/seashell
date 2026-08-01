import { describe, expect, it } from 'vitest'
import { CardStore, STALE_OUTPUT_BYTES } from '../../src/main/lookout/card-store.js'

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
    expect(store.createFromDetector('p1', 'deploy?')).toBe(true)
    expect(store.cards()).toHaveLength(1)
    expect(store.cards()[0]).toMatchObject({ paneId: 'p1', source: 'detector', draft: null, state: 'active' })
    expect(emitted.length).toBe(1)
  })
  it('push replaces detector for the same pane', () => {
    const { store } = makeStore()
    store.createFromDetector('p1', 'deploy?')
    expect(store.createFromPush('p1', 'deploy?', 'yes go')).toBe(true)
    expect(store.cards()).toHaveLength(1)
    expect(store.cards()[0]?.source).toBe('push')
    expect(store.cards()[0]?.draft).toBe('yes go')
  })
  it('a dismissed question does not re-card; a new question does', () => {
    const { store } = makeStore()
    store.createFromDetector('p1', 'deploy?')
    store.dismiss(store.cards()[0]!.id)
    expect(store.cards()).toHaveLength(0)
    expect(store.createFromDetector('p1', 'deploy?')).toBe(false)
    expect(store.createFromDetector('p1', 'other thing?')).toBe(true)
  })
  it('freshness follows the output counter', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?')
    const card = store.cards()[0]!
    expect(store.isFresh(card)).toBe(true)
    bytes.set('p1', 1000 + STALE_OUTPUT_BYTES)
    expect(store.isFresh(card)).toBe(false)
    store.sweep()
    expect(store.get(card.id)?.state).toBe('stale')
  })
  it('sweep drops cards whose pane is gone', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?')
    bytes.set('p1', null)
    store.sweep()
    expect(store.cards()).toHaveLength(0)
  })
  it('disabled store refuses creates', () => {
    const { store } = makeStore()
    store.setEnabled(false)
    expect(store.createFromDetector('p1', 'deploy?')).toBe(false)
    expect(store.createFromPush('p1', 'q?', null)).toBe(false)
  })
})
