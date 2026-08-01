import type { LookoutCard } from '../../shared/ipc.js'

/**
 * How many cards the status-bar badge should report.
 *
 * Deliberately pane-agnostic: suppression (hiding the focused pane's card
 * from the visible stack, in `CardStack`) is a stack-*visibility* rule, never
 * a count rule — the spec's "gets the badge only" for the focused pane means
 * the badge is exactly where that pane's pending card still shows up, not
 * one more place it disappears from. Counting every active card regardless
 * of pane is what keeps the badge stable across a focus change: switching
 * focus onto or off of the pane with the pending card must not move the
 * count, only whether that card is also drawn in the stack.
 */
export function lookoutBadgeCount(cards: LookoutCard[]): number {
  return cards.filter((c) => c.state === 'active').length
}
