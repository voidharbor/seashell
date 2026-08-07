import { describe, expect, it } from 'vitest'
import { pruneDrafts, type DraftStore } from '../../src/renderer/lookout/drafts.js'

describe('pruneDrafts', () => {
  it('keeps drafts for cards that still exist', () => {
    const store: DraftStore = new Map([['card-1', 'hold off'], ['card-2', 'yes']])
    pruneDrafts(store, ['card-1', 'card-2'])
    expect([...store.keys()].sort()).toEqual(['card-1', 'card-2'])
  })

  it('drops drafts for cards that are gone', () => {
    const store: DraftStore = new Map([['card-1', 'hold off'], ['card-2', 'yes']])
    pruneDrafts(store, ['card-2'])
    expect([...store.keys()]).toEqual(['card-2'])
  })

  it('empties completely when no cards remain', () => {
    const store: DraftStore = new Map([['card-1', 'x']])
    pruneDrafts(store, [])
    expect(store.size).toBe(0)
  })

  it('accepts a Set as well as a list', () => {
    const store: DraftStore = new Map([['card-1', 'x'], ['card-2', 'y']])
    pruneDrafts(store, new Set(['card-1']))
    expect([...store.keys()]).toEqual(['card-1'])
  })

  /**
   * The reason this is safe to call against the FULL card list rather than the
   * visible one: a card suppressed because its own pane has focus is still in
   * `cards`, so its draft is kept — which is the whole case the store exists
   * for.
   */
  it('keeps a draft for a card that is merely hidden right now', () => {
    const store: DraftStore = new Map([['card-1', 'mid-edit']])
    pruneDrafts(store, ['card-1'])
    expect(store.get('card-1')).toBe('mid-edit')
  })
})
