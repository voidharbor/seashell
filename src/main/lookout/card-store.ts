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
}

function toPublicCard(card: StoredCard): LookoutCard {
  const { id, paneId, source, kind, question, draft, state, createdAt } = card
  return { id, paneId, source, kind, question, draft, state, createdAt }
}

export class CardStore {
  private isEnabled = true
  private nextCardId = 1
  private readonly byPane = new Map<string, StoredCard>()
  /** Questions dismissed per pane, so a re-detect of the same question does not re-card. */
  private readonly dismissedByPane = new Map<string, Set<string>>()

  constructor(private readonly deps: CardStoreDeps) {}

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled
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
      // A push outranks a detector unconditionally while active; a same-question
      // detector card is already showing exactly this, so there is nothing to do.
      if (existing.source === 'push') return true
      if (existing.question === question) return true
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
    })
    this.emitChange()
    return true
  }

  dismiss(cardId: string): void {
    const card = this.findById(cardId)
    if (!card) return
    this.rememberDismissed(card.paneId, card.question)
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

  remove(cardId: string): void {
    const card = this.findById(cardId)
    if (!card) return
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
      if (card.state !== 'active') continue

      // Dead must be checked before staleness: a dead pane outranks a
      // staleness verdict anyway, and a gone one has no counter to diff.
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

  private isDismissed(paneId: string, question: string): boolean {
    return this.dismissedByPane.get(paneId)?.has(question) ?? false
  }

  private rememberDismissed(paneId: string, question: string): void {
    const existing = this.dismissedByPane.get(paneId)
    if (existing) existing.add(question)
    else this.dismissedByPane.set(paneId, new Set([question]))
  }

  private emitChange(): void {
    this.deps.emit(this.cards())
  }
}
