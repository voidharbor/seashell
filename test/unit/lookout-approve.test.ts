import { describe, expect, it } from 'vitest'
import { CardStore, STALE_OUTPUT_BYTES } from '../../src/main/lookout/card-store.js'
import { approveCard } from '../../src/main/lookout/approve.js'

function setup(opts: { foreground?: boolean; tty?: string | null } = {}) {
  const bytes = new Map<string, number | null>([['p1', 500]])
  const store = new CardStore({ bytesOut: (id) => bytes.get(id) ?? null, emit: () => {}, now: () => 1 })
  store.createFromPush('p1', 'ship it?', 'yes ship')
  const writes: string[] = []
  const deps = {
    store,
    paneTty: () => (opts.tty === undefined ? 'ttys009' : opts.tty),
    checkForeground: async () => opts.foreground ?? true,
    writeIfLive: (_id: string, data: string) => { writes.push(data); return true },
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
  it('refuses a stale card without writing', async () => {
    const { deps, writes, cardId, bytes, store } = setup()
    bytes.set('p1', 500 + STALE_OUTPUT_BYTES)
    const res = await approveCard(deps, { cardId, text: 'yes ship' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ESTALE')
    expect(writes).toHaveLength(0)
    expect(store.get(cardId)?.state).toBe('stale')
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
})
