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

export const STALE_OUTPUT_BYTES = 256 // grace for DA/CPR replies and redraws

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
  const { id, paneId, source, question, draft, state, createdAt } = card
  return { id, paneId, source, question, draft, state, createdAt }
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
  createFromDetector(paneId: string, question: string): boolean {
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

  /** True while the pane's output has advanced < STALE_OUTPUT_BYTES since creation. */
  isFresh(card: LookoutCard): boolean {
    const stored = this.findById(card.id)
    if (!stored) return false
    const current = this.deps.bytesOut(stored.paneId)
    if (current === null) return false
    return current - stored.bytesOutAtCreate < STALE_OUTPUT_BYTES
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

  /** Re-checks every active card; flips stale / drops gone panes; emits on change.
   *  The store owns no timer: the index.ts wiring calls this on a short
   *  interval armed only while cards exist, ensureFlushLoop-style. */
  sweep(): void {
    let changed = false
    for (const card of this.byPane.values()) {
      if (card.state !== 'active') continue

      // Gone must be checked before staleness: a gone pane has no output
      // counter to diff against, and outranks a staleness verdict anyway.
      const current = this.deps.bytesOut(card.paneId)
      if (current === null) {
        this.byPane.delete(card.paneId)
        changed = true
      } else if (current - card.bytesOutAtCreate >= STALE_OUTPUT_BYTES) {
        card.state = 'stale'
        changed = true
      }
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
