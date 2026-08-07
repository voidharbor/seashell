import type { LookoutCard } from '../../shared/ipc.js'

/**
 * In-memory store for Lookout cards — the approve/dismiss prompts that appear
 * when a pane looks like it is waiting on a decision.
 *
 * Kept pure of Electron (deps-injected, same style as control/server.ts) so it
 * runs under a plain node test with no renderer and no real pty. Cards are
 * process-lifetime only: a restart clears them and the detector re-notices
 * whatever is still waiting, so there is nothing here worth persisting.
 *
 * One card per pane, keyed by paneId. A push (a human-reviewed triage result
 * delivered over the control socket) always outranks a detector card (a raw
 * pattern match) while it stays active — see createFromPush/createFromDetector.
 * Dismissal is remembered per (paneId, question) so a dismissed prompt does
 * not immediately re-card the moment the detector notices the same
 * still-unanswered question again.
 */

/**
 * Cards used to go stale once the pane emitted this many bytes since the card
 * appeared. That measured the wrong thing. A pane repaints constantly while
 * sitting still — the end-of-turn timing line, the statusline clock, the input
 * box — and a card is created at exactly the moment claude finishes rendering
 * its question, so those repaints land immediately after the baseline is taken.
 * Measured idle drift is bursty: nothing for a minute, then a redraw worth
 * 130+ bytes. 256 was crossed within seconds of a card appearing, which is why
 * a card would announce `session moved on` and disable its own Approve button
 * while claude was still sitting there waiting for an answer.
 *
 * Byte drift is no longer a staleness verdict. It is still read to tell a pane
 * that RESTARTED (counter went backwards) from one that is merely quiet, which
 * is a fact about the pty, not about the conversation.
 *
 * Nothing about approving got looser: approveCard re-validates the picker
 * screen from main's own stream, re-checks that claude still owns the tty's
 * foreground process group, and re-checks pane liveness before either write.
 * Those are checks on what is true NOW; the byte counter was a guess about
 * what might have happened since.
 */
export const RESTART_GRACE_BYTES = 0

export interface CardStoreDeps {
  /** Monotonic pty output counter for the pane, or null when the pane is gone. */
  bytesOut(paneId: string): number | null
  /** Push the full card list to the renderer. */
  emit(cards: LookoutCard[]): void
  now(): number
}

/**
 * The public shape plus the output-byte baseline used to detect staleness.
 * bytesOutAtCreate never leaves this module — cards()/get() strip every
 * record back down to the public LookoutCard shape before returning it.
 */
interface StoredCard extends LookoutCard {
  bytesOutAtCreate: number
  /**
   * Every phrasing the DETECTOR has reported for this pane while this card was
   * the one on screen.
   *
   * A push card's question is written by the triage model; the detector's is
   * scraped off the pane. The same underlying ask therefore has two different
   * strings, and dismissal is remembered per (pane, question). Without this,
   * denying a drafted card suppressed only the model's phrasing — the detector
   * was still sitting on the unanswered question, and the moment the pane's
   * card slot freed up it raised its own card for the ask the user had just
   * answered. Recording the screen phrasing here lets dismiss() retire both.
   */
  screenQuestions: Set<string>
}

function toPublicCard(card: StoredCard): LookoutCard {
  const { id, paneId, source, kind, question, draft, state, createdAt } = card
  return { id, paneId, source, kind, question, draft, state, createdAt }
}

export class CardStore {
  private isEnabled = true
  private nextCardId = 1
  private readonly byPane = new Map<string, StoredCard>()
  /**
   * Questions dismissed per pane, so a re-detect of the same question does not
   * re-card — stamped with the pane's output counter at the time.
   *
   * The stamp is what ties a dismissal to the SESSION it was made in. A pane's
   * counter only ever grows, so a reading below the stamp can mean exactly one
   * thing: a different pty wearing the same pane id, i.e. the pane restarted.
   * Its dismissals belong to a conversation that no longer exists and must not
   * suppress the new one. See `isDismissed`.
   */
  private readonly dismissedByPane = new Map<string, { at: number; questions: Set<string> }>()

  constructor(private readonly deps: CardStoreDeps) {}

  /**
   * Turning Lookout off clears what is already on screen, not just what would
   * arrive next.
   *
   * "Disable" is reached for *because* cards are in the way, so a switch that
   * silences the future and leaves three cards sitting in the rail reads as
   * broken. This is the behaviour the one-click toggle on the rail depends on.
   *
   * The clear is an EVICTION, not an answer and not a refusal: nothing is
   * remembered as dismissed, because the user decided about the feature, not
   * about the question. Whatever is still pending must card again when they
   * turn it back on. (The renderer drops its own last-reported memory on
   * disable for the same reason, so the detector re-reports from scratch.)
   */
  setEnabled(enabled: boolean): void {
    if (this.isEnabled === enabled) return
    this.isEnabled = enabled
    if (enabled || this.byPane.size === 0) return
    this.byPane.clear()
    // The renderer only ever learns the card list from an emit. Clearing the
    // map without one would leave the rail rendering cards the store has
    // already forgotten — and a click on one of those would act on a card id
    // that no longer resolves.
    this.emitChange()
  }

  enabled(): boolean {
    return this.isEnabled
  }

  cards(): LookoutCard[] {
    return [...this.byPane.values()].map(toPublicCard)
  }

  /** One card per pane; a push replaces a detector card, never vice versa
   *  while the push card is active. Returns false when disabled or the pane
   *  is gone or the question was just dismissed on this pane. */
  createFromDetector(paneId: string, question: string, kind: 'input' | 'selector'): boolean {
    if (!this.isEnabled) return false
    const bytesOutAtCreate = this.deps.bytesOut(paneId)
    if (bytesOutAtCreate === null) return false
    if (this.isDismissed(paneId, question)) return false

    const existing = this.byPane.get(paneId)
    if (existing && existing.state === 'active') {
      // A push outranks a detector — but only while the screen still shows
      // the ask it was pushed for. The FIRST phrasing the detector reports
      // under a push card is that same ask as scraped off the screen (two
      // strings, one ask; that ambiguity is why screenQuestions exists). A
      // LATER reading matching none of the recorded phrasings means the
      // screen's question itself changed — the user answered in the pane and
      // claude moved on — and keeping the push card would leave its draft one
      // click from landing in a question it never answered. Extraction is a
      // pure function of the buffer, so a changed phrasing is a changed
      // screen, not jitter. Record the phrasing either way, so dismissing the
      // card that IS showing also retires it — see StoredCard.screenQuestions.
      const samePushAsk =
        existing.question === question ||
        existing.screenQuestions.size === 0 ||
        existing.screenQuestions.has(question)
      existing.screenQuestions.add(question)
      if (existing.source === 'push' && samePushAsk) return true
      if (existing.source === 'detector' && existing.question === question) return true
      // Falls through to replace: a detector card whose question changed, or
      // a push card whose screen has provably moved to a different ask. The
      // evicted card was never acted on, so nothing is remembered as
      // dismissed — the old ask coming back must card again.
    }

    this.byPane.set(paneId, {
      id: this.newId(),
      paneId,
      source: 'detector',
      kind,
      question,
      draft: null,
      state: 'active',
      createdAt: this.deps.now(),
      bytesOutAtCreate,
      screenQuestions: new Set(),
    })
    this.emitChange()
    return true
  }

  createFromPush(paneId: string, question: string, draft: string | null): boolean {
    if (!this.isEnabled) return false
    const bytesOutAtCreate = this.deps.bytesOut(paneId)
    if (bytesOutAtCreate === null) return false
    if (this.isDismissed(paneId, question)) return false

    this.byPane.set(paneId, {
      id: this.newId(),
      paneId,
      source: 'push',
      // A push arrives via the Stop hook, after a turn has ended at the input
      // box — it has no screen reading of its own. approveCard's live
      // screenKind check is what guards it if the screen has since changed.
      kind: 'input',
      question,
      draft,
      state: 'active',
      createdAt: this.deps.now(),
      bytesOutAtCreate,
      screenQuestions: new Set(),
    })
    this.emitChange()
    return true
  }

  dismiss(cardId: string): void {
    const card = this.findById(cardId)
    if (!card) return
    // Retire every phrasing of this ask, not just the one that happened to be
    // on the card — otherwise the detector re-cards the question the user just
    // answered as soon as the pane's slot is free.
    this.rememberDismissed(card.paneId, card.question)
    for (const q of card.screenQuestions) this.rememberDismissed(card.paneId, q)
    this.byPane.delete(card.paneId)
    this.emitChange()
  }

  get(cardId: string): LookoutCard | undefined {
    const card = this.findById(cardId)
    return card ? toPublicCard(card) : undefined
  }

  /** True while the card's pane is still the same live pty it was created on.
   *  A negative delta (current below the baseline) means the counter went
   *  backwards: a different pty wearing the same pane id (the pane restarted),
   *  which can never be fresh. Output volume alone no longer decides this —
   *  see RESTART_GRACE_BYTES. */
  isFresh(card: LookoutCard): boolean {
    const stored = this.findById(card.id)
    if (!stored) return false
    const current = this.deps.bytesOut(stored.paneId)
    if (current === null) return false
    return current - stored.bytesOutAtCreate >= RESTART_GRACE_BYTES
  }

  markStale(cardId: string): void {
    const card = this.findById(cardId)
    if (!card || card.state === 'stale') return
    card.state = 'stale'
    this.emitChange()
  }

  /** Retires a card that has been ANSWERED (approveCard's success path). The
   *  question is settled, so every phrasing of it is remembered as dismissed —
   *  without that the detector, which is still looking at the pre-answer
   *  screen, raises its own card for the ask that was just answered. */
  remove(cardId: string): void {
    const card = this.findById(cardId)
    if (!card) return
    this.rememberDismissed(card.paneId, card.question)
    for (const q of card.screenQuestions) this.rememberDismissed(card.paneId, q)
    this.byPane.delete(card.paneId)
    this.emitChange()
  }

  /** Re-checks every active card; flips stale / drops dead panes; emits on
   *  change. Also forgets dismissal memory for any pane that has exited —
   *  a card already dismissed before its pane died leaves byPane with
   *  nothing to sweep here, so that leak needs its own pass rather than
   *  riding along with dropDeadCard below.
   *  The store owns no timer: the index.ts wiring calls this on a short
   *  interval armed only while cards exist, ensureFlushLoop-style. */
  sweep(): void {
    let changed = false
    for (const card of this.byPane.values()) {
      // Every card, whatever its state — NOT just the active ones.
      //
      // This loop is the only thing that drops a card whose pane has died, and
      // it used to skip anything already stale. A card that went stale first
      // (a failed foreground check marks one) and whose pane then exited was
      // therefore never removed: it sat in the rail for the life of the
      // window, unanswerable and un-dismissable-by-anything-but-hand, holding
      // on the sweep timer that is armed only while cards exist.
      //
      // Dead outranks stale anyway, so there is nothing to preserve by
      // skipping: a stale card on a dead pane is exactly as gone as an active
      // one on a dead pane.
      const current = this.deps.bytesOut(card.paneId)
      const delta = current === null ? null : current - card.bytesOutAtCreate
      if (delta === null || delta < 0) {
        // null: the pane exited outright. Negative: the counter went
        // backwards — this is a different pty wearing the same pane id
        // (the pane restarted). Either way the card's session is dead, so
        // drop it rather than merely marking it stale.
        this.dropDeadCard(card.paneId)
        changed = true
      }
      // A live pane that is merely noisy is NOT stale. A card stays until the
      // user answers or dismisses it, which is the whole point of raising one:
      // an unanswered question does not stop mattering because the pane
      // repainted its status line.
    }

    // A pane can exit after its last card was already dismissed (and so
    // already gone from byPane above) — catch that leak here too, or a
    // pane id reused by a brand new session stays permanently suppressed
    // by dismissals that belonged to the old one.
    for (const paneId of this.dismissedByPane.keys()) {
      if (this.deps.bytesOut(paneId) === null) this.dismissedByPane.delete(paneId)
    }

    if (changed) this.emitChange()
  }

  private newId(): string {
    return `card-${this.nextCardId++}`
  }

  /** Linear scan is fine here: one card per pane, capped by MAX_PANES (24). */
  private findById(cardId: string): StoredCard | undefined {
    for (const card of this.byPane.values()) {
      if (card.id === cardId) return card
    }
    return undefined
  }

  /** Drops a card whose pty session is dead (pane exited, or restarted
   *  under the same id) and forgets that pane's dismissal memory along
   *  with it — a new session on a reused pane id must not have its
   *  questions suppressed by the previous session's dismissals. */
  private dropDeadCard(paneId: string): void {
    this.byPane.delete(paneId)
    this.dismissedByPane.delete(paneId)
  }

  /**
   * Checked at the moment a card would be raised, and it collects as it goes.
   *
   * The sweep also prunes dismissals for dead panes, but the sweep timer is
   * armed only while cards exist — so the ordinary case (dismiss the last
   * card, pane later exits, pane restarted) never reached it, and the next
   * session in that pane was suppressed for a question it had never been
   * asked about. Deciding it here instead means the check cannot be skipped:
   * this runs on exactly the path that would suppress a card.
   */
  private isDismissed(paneId: string, question: string): boolean {
    const entry = this.dismissedByPane.get(paneId)
    if (!entry) return false

    const current = this.deps.bytesOut(paneId)
    // null: the pane is gone. Below the stamp: the counter restarted, so this
    // is a different pty under the same pane id. Either way the session that
    // did the dismissing is over and its memory goes with it.
    if (current === null || current < entry.at) {
      this.dismissedByPane.delete(paneId)
      return false
    }
    return entry.questions.has(question)
  }

  private rememberDismissed(paneId: string, question: string): void {
    const existing = this.dismissedByPane.get(paneId)
    if (existing) {
      existing.questions.add(question)
      return
    }
    // Stamped with the counter now, which is the baseline a later reading is
    // compared against to spot a restart.
    this.dismissedByPane.set(paneId, {
      at: this.deps.bytesOut(paneId) ?? 0,
      questions: new Set([question]),
    })
  }

  private emitChange(): void {
    this.deps.emit(this.cards())
  }
}
