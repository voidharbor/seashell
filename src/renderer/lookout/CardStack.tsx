import { useEffect, useRef, useState } from 'react'
import type { LookoutActionRequest, LookoutCard } from '../../shared/ipc.js'
import { ageLabel } from './age.js'
import { pruneDrafts, type DraftStore } from './drafts.js'

export interface CardStackProps {
  cards: LookoutCard[]
  /** Pane ids the stack must not show cards for (the focused pane). */
  suppressedPaneId: string | null
  pluginInstalled: boolean
  /**
   * False when the user has switched Lookout off. The stack still renders —
   * it is what carries the "off" state and the way back on. Cards are already
   * cleared in main when this flips (CardStore.setEnabled), so this is about
   * saying so, not about hiding anything.
   */
  enabled: boolean
  /** What the pane's own header shows — its claude session title or the user's
   *  custom label, numbered as in the pane header. The raw pane id is useless
   *  at a glance once several agents are running. */
  paneName(paneId: string): string
  /** The pane's colour tag, as hex, or null for an untagged pane. Panes are
   *  told apart by colour everywhere else in this app; a card that does not
   *  carry its pane's colour makes you read the label to find out which agent
   *  is asking. */
  paneColor(paneId: string): string | null
  /** Live screen mode of a pane, re-derived from its xterm buffer via
   *  extractQuestion at render and click time. 'selector' means typed text +
   *  Enter would blind-confirm the highlighted option — no send buttons. */
  screenMode(paneId: string): 'input' | 'selector' | null
  /** Wall clock for card ages. Passed in rather than read here so the caller
   *  owns the ticking — it arms a once-a-minute tick only while cards exist,
   *  and an idle Lookout re-renders nothing. */
  nowMs: number
  /**
   * Where edited drafts live while their card is unmounted. Owned by the
   * caller so it outlives this component — hiding Lookout unmounts the whole
   * stack, and an edit has to survive that too. See drafts.ts.
   */
  drafts: DraftStore
  onAction(req: LookoutActionRequest): void
  onGotoPane(paneId: string): void
}

const SELECTOR_HINT = "answer in the pane — it's showing a picker"
const STALE_LABEL = 'session moved on'

/**
 * The Lookout section's stack of cards.
 *
 * A card for the currently-focused pane is always suppressed — you are already
 * looking at it, so it only contributes to the badge count (computed by the
 * caller). With nothing to show, this renders an idle placeholder rather than
 * nothing: Lookout is a permanent section whose visibility belongs to the user
 * (⇧⌘B), and a section that silently disappeared when idle was indistinguishable
 * from a build that never had it.
 */
export function CardStack(props: CardStackProps): React.JSX.Element {
  const visible = props.enabled
    ? props.cards.filter((c) => c.paneId !== props.suppressedPaneId)
    : []

  /**
   * Forget drafts for cards that are gone.
   *
   * In an effect, not during render, and the ordering is the point: a card
   * leaving the list unmounts its CardItem, whose cleanup writes the draft it
   * was holding. React runs that cleanup during the commit, AFTER render — so
   * a prune done in the render body ran first and the unmounting card wrote
   * its draft straight back in behind it, leaking one entry per card ever
   * edited. Effects run after the commit, which is after every cleanup.
   *
   * Against the FULL card list, not the visible one: a card suppressed because
   * its own pane has focus is still very much alive, and dropping its draft
   * would defeat the entire point of keeping it.
   *
   * `liveKey` is a change-detection key and nothing more — the prune reads the
   * live array through a ref rather than splitting the key back apart, so no
   * delimiter has to be chosen or trusted.
   */
  const liveKey = props.cards.map((c) => c.id).join(',')
  const cardsRef = useRef(props.cards)
  cardsRef.current = props.cards
  useEffect(() => {
    pruneDrafts(
      props.drafts,
      cardsRef.current.map((c) => c.id)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey])

  return (
    <div className="lookout-stack">
      {visible.map((card) => (
        <CardItem
          key={card.id}
          card={card}
          paneName={props.paneName}
          paneColor={props.paneColor}
          screenMode={props.screenMode}
          nowMs={props.nowMs}
          drafts={props.drafts}
          onAction={props.onAction}
          onGotoPane={props.onGotoPane}
        />
      ))}
      {/* The section is permanent, so its idle state has to say something
          useful rather than vanish. No dismiss button here — hiding Lookout
          belongs to the section header (and ⇧⌘B), not to a placeholder. */}
      {visible.length === 0 && (
        <div className="card card--idle">
          {/* Off is a state the user chose, and it outranks every other thing
              this placeholder could say: telling someone who switched cards
              off that "nothing needs you" is a lie by omission, and telling
              them to install a plugin for a feature they just turned off is
              noise. The way back on is the toggle in the section header. */}
          {!props.enabled ? (
            <div className="card__question">cards are off</div>
          ) : props.cards.length > 0 ? (
            // There IS something waiting — it is the pane you are looking at,
            // whose card is suppressed for exactly that reason. Saying
            // "nothing needs you" here flatly contradicted the count in the
            // header directly above, which counts suppressed cards too.
            <div className="card__question">the pane you’re in is the one asking</div>
          ) : props.pluginInstalled ? (
            <div className="card__question">nothing needs you</div>
          ) : (
            <>
              <div className="card__question">smart cards need the c-assistant plugin:</div>
              <code className="card__cmd">/plugin marketplace add voidharbor/claude-plugins</code>
              <code className="card__cmd">/plugin install c-assistant@voidharbor</code>
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface CardItemProps {
  card: LookoutCard
  paneName(paneId: string): string
  paneColor(paneId: string): string | null
  screenMode(paneId: string): 'input' | 'selector' | null
  nowMs: number
  drafts: DraftStore
  onAction(req: LookoutActionRequest): void
  onGotoPane(paneId: string): void
}

/**
 * Rows for the draft box, from the draft itself.
 *
 * A fixed five rows meant "yes ship it" got a box with three empty lines under
 * it, and four cards like that pushed the file tree off the bottom of the
 * screen for no content at all. Clamped at both ends: two rows so a one-word
 * draft still looks like something you can type in, eight so a long one
 * scrolls instead of eating the rail. Line count only — a wrapped long line
 * scrolls, which is what the resize handle is for.
 */
export function draftRows(draft: string): number {
  return Math.min(8, Math.max(2, draft.split('\n').length))
}

/**
 * Go to pane + a bare dismiss — the fallback button pair shown whenever a
 * card has nothing safe to send (a draft-less push card by design, or any
 * card sitting on a non-input screen). Never disabled, even on a stale card:
 * neither one fires anything into the pane's conversation, so staleness has
 * nothing to guard against here.
 */
function gotoPaneAndDismiss(gotoPane: () => void, dismiss: () => void): React.ReactNode {
  return (
    <>
      <button className="btn" onClick={gotoPane}>
        Go to pane
      </button>
      <button className="btn" onClick={dismiss}>
        ✕
      </button>
    </>
  )
}

/**
 * One card. Its shape — which buttons exist at all — is set by (draft,
 * source); whether those buttons are live is set by staleness and the pane's
 * live screen mode.
 *
 * Selector safety rule: every send affordance (canned words, Approve, the
 * edited draft) renders only while `screenMode` reads 'input'; 'selector' and
 * an unreadable pane (null) both fall back to the same look-only view. A
 * stale card is a separate, stronger gate — it always shows its normal
 * button shape (so the layout does not jump) and is labelled
 * `session moved on`, but only its *send* affordances (Approve, Continue /
 * Yes / No) are disabled, because those are the only buttons that fire
 * anything into a conversation that has since moved on. `Go to pane` and the
 * dismiss button stay live on a stale card — neither one sends, and a card
 * whose own dismiss button is disabled would be stuck in the stack forever.
 *
 * `screenMode` is re-read a second time inside `send`, at the moment of the
 * click, rather than trusting the `interactive` value computed at render.
 * The prop is documented as a live read of the pane's xterm buffer, not a
 * snapshot — this component can sit rendered for a while, and the screen
 * behind it can change without a re-render (nothing about the card's own
 * props changed). Re-deriving at the actual moment of the click is the same
 * "closed by the check at the moment of the click" principle the design spec
 * uses for staleness, applied to the selector gate too.
 */
function CardItem(props: CardItemProps): React.JSX.Element {
  const { card } = props
  const stale = card.state === 'stale'
  const mode = props.screenMode(card.paneId)
  /**
   * A card born from a selector screen is look-only for life, whatever the live
   * read says now — main refuses its approve too (ESELECTOR).
   *
   * Only a POSITIVE 'selector' read takes the buttons away. `null` means the
   * renderer could not parse the pane, which is not the same claim at all, and
   * treating the two alike is what put "it's showing a picker" on cards whose
   * pane was sitting at an ordinary input box. Extraction returns null for
   * plenty of ordinary reasons — chrome it does not recognise, a question that
   * scrolled past its window — and the user was told, wrongly and
   * unanswerably, to go deal with a picker that was not there.
   *
   * Sending on an unreadable screen is safe because the renderer was never the
   * guard: approveCard re-reads the screen from main's own pty stream at click
   * time and refuses a real picker there (ESELECTOR). Per screen-kind.ts, that
   * check "can only block a send, never permit one the renderer would have
   * blocked".
   */
  const interactive = card.kind !== 'selector' && mode !== 'selector'
  const hasDraft = card.draft !== null
  // A stale card keeps its normal button shape (send buttons disabled)
  // instead of collapsing to the look-only fallback — see the doc above.
  const showShape = stale || interactive
  const editable = interactive && !stale

  /**
   * Seeded from the edit in progress if there is one, and only otherwise from
   * the model's draft.
   *
   * A card unmounts whenever its own pane takes focus (it is suppressed — you
   * are looking at the pane) and whenever Lookout is hidden. Both are things
   * people do in the middle of editing a reply, to go and read the question.
   * Re-seeding from `card.draft` on the way back replaced what they had
   * written with wording they had already rejected, still sitting one click
   * from being sent.
   */
  const [text, setText] = useState(() => props.drafts.get(card.id) ?? card.draft ?? '')

  // Written on unmount rather than on every keystroke: this only has to be
  // right at the moment the component goes away.
  const textRef = useRef(text)
  textRef.current = text
  useEffect(() => {
    const store = props.drafts
    const id = card.id
    return () => {
      store.set(id, textRef.current)
    }
    // Mount/unmount only — the ref carries the latest value into the cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = (value: string): void => {
    // Same rule as `interactive`: refuse on a positive picker read, not on an
    // unreadable one. Re-derived here rather than reusing the render-time
    // value, because the screen behind a rendered card can change without
    // anything about the card's own props changing.
    if (card.kind === 'selector' || props.screenMode(card.paneId) === 'selector') return
    props.onAction({ cardId: card.id, action: 'approve', text: value })
  }
  const dismiss = (): void => props.onAction({ cardId: card.id, action: 'dismiss' })
  const gotoPane = (): void => props.onGotoPane(card.paneId)

  let draftNode: React.ReactNode = null
  let hintNode: React.ReactNode = null
  let actions: React.ReactNode

  if (hasDraft) {
    draftNode = editable ? (
      <textarea
        className="card__draft"
        rows={draftRows(text)}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    ) : (
      // The user's current text, not `card.draft`. This branch is what a card
      // drops to when a picker appears on the pane or the card goes stale —
      // and showing the model's original wording at that moment tells someone
      // who had rewritten the reply that their edit is gone, when it is not:
      // it is held in the draft store and comes straight back the moment the
      // card is answerable again.
      <div className="card__draft card__draft--ref">{text}</div>
    )
    if (showShape) {
      hintNode = stale ? <div className="card__hint">{STALE_LABEL}</div> : null
      actions = (
        <>
          <button className="btn btn--primary" disabled={stale} onClick={() => send(text)}>
            Approve ✓
          </button>
          <button className="btn" onClick={dismiss}>
            Deny ✕
          </button>
          {/* A drafted card is the one most likely to need a look at the pane
              before answering — approving blind is exactly what it should not
              encourage. Never disabled: going to a pane sends nothing. */}
          <button className="btn" onClick={gotoPane}>
            Go to pane
          </button>
        </>
      )
    } else {
      hintNode = <div className="card__hint">{SELECTOR_HINT}</div>
      actions = gotoPaneAndDismiss(gotoPane, dismiss)
    }
  } else if (card.source === 'detector') {
    if (showShape) {
      hintNode = stale ? <div className="card__hint">{STALE_LABEL}</div> : null
      actions = (
        <>
          <button className="btn btn--primary" disabled={stale} onClick={() => send('continue')}>
            Continue
          </button>
          <button className="btn" disabled={stale} onClick={() => send('yes')}>
            Yes
          </button>
          <button className="btn" disabled={stale} onClick={() => send('no')}>
            No
          </button>
          <button className="btn" onClick={gotoPane}>
            Go to pane
          </button>
          <button className="btn" onClick={dismiss}>
            ✕
          </button>
        </>
      )
    } else {
      hintNode = <div className="card__hint">{SELECTOR_HINT}</div>
      actions = gotoPaneAndDismiss(gotoPane, dismiss)
    }
  } else {
    // Draft-less push card — money/legal/irreversible never one-clicks, so
    // there was never a send affordance here to gate on screen mode or
    // staleness; Go to pane / dismiss stay live even once stale.
    if (stale) hintNode = <div className="card__hint">{STALE_LABEL}</div>
    actions = gotoPaneAndDismiss(gotoPane, dismiss)
  }

  const colour = props.paneColor(card.paneId)
  const age = ageLabel(card.createdAt, props.nowMs)

  return (
    <div
      className={'card' + (stale ? ' card--stale' : '')}
      // The pane's colour as a left edge on the whole card, not just a dot:
      // with several agents running, which pane is asking is the first thing
      // you need and the last thing you should have to read a label for. Falls
      // back to the chrome line for an untagged pane, so the border is always
      // drawn and cards never differ in width.
      style={{ borderLeftColor: colour ?? undefined }}
    >
      <div className="card__head">
        <span className="card__pane" title={card.paneId}>
          {props.paneName(card.paneId)}
        </span>
        {age && <span className="card__age">{age}</span>}
      </div>
      <div className="card__question">{card.question}</div>
      {draftNode}
      {hintNode}
      <div className="card__actions">{actions}</div>
    </div>
  )
}
