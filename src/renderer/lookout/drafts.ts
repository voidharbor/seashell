/**
 * Edited draft text, held across a card unmounting.
 *
 * A card's reply box is local component state, and the card unmounts more
 * often than it looks like it should:
 *
 *   - focusing the card's OWN pane suppresses its card (you are looking at the
 *     pane, so the card is redundant) — which is precisely what someone does
 *     mid-edit to check what the agent actually asked;
 *   - hiding the Lookout section (⇧⌘B) unmounts the whole stack.
 *
 * Either one used to throw the edit away, and remounting re-seeded the box
 * from `card.draft` — the model's original wording. So the card silently
 * reverted to text the user had already decided against, one click from being
 * sent into a conversation. Losing typing is bad; replacing it with different
 * text that still looks ready to send is worse.
 *
 * Kept out of React state deliberately: this is written on every keystroke,
 * and routing that through a re-render of the app that hosts the terminals is
 * a real cost for something no other component reads.
 */

export type DraftStore = Map<string, string>

/**
 * Forgets drafts for cards that no longer exist.
 *
 * Card ids are never reused (CardStore counts up), so a stale entry can never
 * seed the wrong card's box — but without this the map grows for the life of
 * the window, one entry per card ever edited.
 */
export function pruneDrafts(store: DraftStore, liveCardIds: Iterable<string>): void {
  const live = liveCardIds instanceof Set ? liveCardIds : new Set(liveCardIds)
  for (const id of [...store.keys()]) {
    if (!live.has(id)) store.delete(id)
  }
}
