import { describe, expect, it } from 'vitest'
import { lookoutBadgeCount } from '../../src/renderer/lookout/badge.js'
import type { LookoutCard } from '../../src/shared/ipc.js'

function card(overrides: Partial<LookoutCard> = {}): LookoutCard {
  return {
    id: 'card-1',
    paneId: 'p1',
    source: 'push',
    kind: 'input',
    question: 'ship it?',
    draft: null,
    state: 'active',
    createdAt: 1,
    ...overrides,
  }
}

describe('lookoutBadgeCount', () => {
  it('counts an active card even on the suppressed (focused) pane', () => {
    // Suppression only hides a card from the visible stack (CardStack.tsx);
    // it must never fall out of the badge count too.
    expect(lookoutBadgeCount([card({ paneId: 'focused-pane' })])).toBe(1)
  })

  it('does not count a stale card', () => {
    expect(lookoutBadgeCount([card({ state: 'stale' })])).toBe(0)
  })

  it('sums active cards across panes and ignores stale ones in the mix', () => {
    const cards = [
      card({ id: 'card-1', paneId: 'p1' }),
      card({ id: 'card-2', paneId: 'p2', state: 'stale' }),
      card({ id: 'card-3', paneId: 'p3' }),
    ]
    expect(lookoutBadgeCount(cards)).toBe(2)
  })

  it('returns 0 for an empty list', () => {
    expect(lookoutBadgeCount([])).toBe(0)
  })
})
