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
  /**
   * Turning Lookout off has to take the cards off the screen, not merely stop
   * new ones arriving. "Disable" reached for while three cards are sitting
   * there means "make these go away" — a switch that leaves them showing
   * looks broken, and the whole point of the one-click toggle on the rail is
   * to be the fast way out when cards are in the way.
   */
  it('disabling clears the cards that are already showing', () => {
    const { store, emitted } = makeStore({
      bytes: new Map<string, number | null>([['p1', 1000], ['p2', 500]]),
    })
    store.createFromDetector('p1', 'deploy?', 'input')
    store.createFromPush('p2', 'ship it?', 'yes')
    expect(store.cards()).toHaveLength(2)

    const before = emitted.length
    store.setEnabled(false)
    expect(store.cards()).toHaveLength(0)
    // The renderer only ever learns about cards from an emit — clearing the
    // map without one would leave the rail showing cards the store has
    // already forgotten, and clicking one would act on a card that is gone.
    expect(emitted.length).toBe(before + 1)
    expect(emitted[emitted.length - 1]).toBe(0)
  })

  /**
   * Clearing on disable is an eviction, not an answer and not a refusal. The
   * user turned the feature off; they did not decide anything about the
   * question. So turning it back on must show whatever is still pending,
   * rather than treating every cleared ask as dismissed forever.
   */
  it('a card cleared by disabling is not remembered as dismissed', () => {
    const { store } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    store.setEnabled(false)
    expect(store.createFromDetector('p1', 'deploy?', 'input')).toBe(false) // still off
    store.setEnabled(true)
    expect(store.createFromDetector('p1', 'deploy?', 'input')).toBe(true)
  })

  it('disabling an already-empty Lookout emits nothing', () => {
    const { store, emitted } = makeStore()
    store.setEnabled(false)
    expect(emitted.length).toBe(0)
  })

  /**
   * A stale card whose pane then dies has to go, like any other dead card.
   *
   * The sweep skipped every card that was not `active`, which read as "only
   * active cards can go stale" — true, but the same loop is also the only
   * thing that drops cards whose pane has exited. So a card that went stale
   * first (a failed foreground check, say) and whose pane then closed stayed
   * in the rail for the life of the window: unanswerable, un-sweepable, and
   * holding the sweep timer on — that timer is armed only while cards exist,
   * so a card that can never be removed means it never stops ticking either.
   */
  it('drops a stale card once its pane exits', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    const card = store.cards()[0]!
    store.markStale(card.id)
    expect(store.cards()).toHaveLength(1)

    bytes.set('p1', null) // the pane exits
    store.sweep()
    expect(store.cards()).toHaveLength(0)
  })

  it('drops a stale card when its pane restarts under the same id', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?', 'input')
    store.markStale(store.cards()[0]!.id)
    bytes.set('p1', 5) // counter went backwards: a different pty, same pane id
    store.sweep()
    expect(store.cards()).toHaveLength(0)
  })

  /**
   * A dismissal belongs to the session it was made in, and must not outlive it.
   *
   * The only thing that forgot dismissals for a dead pane lived in `sweep()`,
   * and the sweep timer is armed only while cards exist. So the ordinary
   * sequence — dismiss the last card, pane goes quiet, shell exits, pane
   * restarted — never ran it: there were no cards, so nothing swept, and once
   * the pane is live again its byte counter is non-null so no later sweep
   * collects it either. The brand-new claude session in that pane then hit the
   * same permission prompt (identical wording; extraction is deterministic)
   * and was silently suppressed. A genuinely blocked pane, no card, forever.
   */
  it('forgets a dismissal when the pane restarts under the same id', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'Do you want to proceed?', 'input')
    store.dismiss(store.cards()[0]!.id)
    expect(store.createFromDetector('p1', 'Do you want to proceed?', 'input')).toBe(false)

    // The shell exits and the pane is restarted: a fresh pty under the same
    // pane id, whose output counter starts again from zero.
    bytes.set('p1', 0)
    expect(store.createFromDetector('p1', 'Do you want to proceed?', 'input')).toBe(true)
  })

  it('still suppresses a repeat within the same session', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'Do you want to proceed?', 'input')
    store.dismiss(store.cards()[0]!.id)
    bytes.set('p1', 9000) // same session, just noisier
    expect(store.createFromDetector('p1', 'Do you want to proceed?', 'input')).toBe(false)
  })

  it('a dismissal does not survive its pane exiting for good', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'Do you want to proceed?', 'input')
    store.dismiss(store.cards()[0]!.id)
    bytes.set('p1', null) // exited; no sweep runs, because no cards exist
    // A pane id handed to something live again must start clean.
    bytes.set('p1', 500)
    expect(store.createFromDetector('p1', 'Do you want to proceed?', 'input')).toBe(true)
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
  // The push card's question is written by the triage model; the detector's is
  // scraped off the pane. Two strings, one ask. Denying the drafted card used
  // to retire only the model's phrasing, so the detector raised its own card
  // for the same question minutes later, once the pane's slot was free.
  it('denying a drafted card also retires the screen phrasing of the same ask', () => {
    const { store } = makeStore()
    store.createFromPush('p1', 'Keep probing for the actual answer?', 'yeah, keep asking')
    // The detector is looking at the same unanswered screen while the push card
    // shows; it defers, but its phrasing is recorded.
    expect(store.createFromDetector('p1', 'Want me to keep asking?', 'input')).toBe(true)
    expect(store.cards()).toHaveLength(1)
    expect(store.cards()[0]?.source).toBe('push')

    store.dismiss(store.cards()[0]!.id)
    expect(store.cards()).toHaveLength(0)

    // The screen has not changed yet — the detector must not re-card it.
    expect(store.createFromDetector('p1', 'Want me to keep asking?', 'input')).toBe(false)
    expect(store.cards()).toHaveLength(0)
  })
  it('approving a card also retires the screen phrasing, so an answered ask never re-cards', () => {
    const { store } = makeStore()
    store.createFromPush('p1', 'Ship it?', 'yes')
    store.createFromDetector('p1', 'Ready to ship?', 'input')
    store.remove(store.cards()[0]!.id) // approveCard's success path
    expect(store.createFromDetector('p1', 'Ready to ship?', 'input')).toBe(false)
  })
  // A push outranks the detector only while the screen still shows the ask it
  // was pushed for. The FIRST screen phrasing seen under a push card is that
  // same ask as the detector scrapes it (two strings, one ask — unavoidable).
  // But a SECOND, different phrasing means the screen's question itself
  // changed: the user answered in the pane and claude moved on. Keeping the
  // push card then leaves its stale draft one click from landing in a question
  // it never answered — byte staleness used to bound that window; nothing
  // else does.
  it('a push card yields when the screen provably moves to a different ask', () => {
    const { store } = makeStore()
    store.createFromPush('p1', 'Ship the release?', 'yes, ship it')
    // Same ask, scraped off the screen — the push card rightly survives.
    expect(store.createFromDetector('p1', 'Ready to ship the release?', 'input')).toBe(true)
    expect(store.cards()[0]).toMatchObject({ source: 'push', question: 'Ship the release?' })

    // The screen now shows a DIFFERENT question: the ask under the card is gone.
    expect(store.createFromDetector('p1', 'Delete the old feature branch?', 'input')).toBe(true)
    const card = store.cards()[0]!
    expect(card.source).toBe('detector')
    expect(card.question).toBe('Delete the old feature branch?')
    expect(card.draft).toBeNull()
  })
  it('an evicted push card was never answered, so its ask is not remembered as dismissed', () => {
    const { store } = makeStore()
    store.createFromPush('p1', 'Ship the release?', 'yes, ship it')
    store.createFromDetector('p1', 'Ready to ship the release?', 'input')
    store.createFromDetector('p1', 'Delete the old feature branch?', 'input')
    store.dismiss(store.cards()[0]!.id)
    // The ORIGINAL ask coming back must card again — the user never acted on it.
    expect(store.createFromDetector('p1', 'Ready to ship the release?', 'input')).toBe(true)
  })
  it('a genuinely new question still cards after a dismissal', () => {
    const { store } = makeStore()
    store.createFromPush('p1', 'Ship it?', 'yes')
    store.createFromDetector('p1', 'Ready to ship?', 'input')
    store.dismiss(store.cards()[0]!.id)
    expect(store.createFromDetector('p1', 'Delete the branch?', 'input')).toBe(true)
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
