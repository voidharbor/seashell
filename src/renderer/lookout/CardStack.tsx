import { useState } from 'react'
import type { LookoutActionRequest, LookoutCard } from '../../shared/ipc.js'

export interface CardStackProps {
  cards: LookoutCard[]
  /** Pane ids the stack must not show cards for (the focused pane). */
  suppressedPaneId: string | null
  pluginInstalled: boolean
  open: boolean // badge toggles the (possibly empty) stack
  /** Live screen mode of a pane, re-derived from its xterm buffer via
   *  extractQuestion at render and click time. 'selector' means typed text +
   *  Enter would blind-confirm the highlighted option — no send buttons. */
  screenMode(paneId: string): 'input' | 'selector' | null
  onAction(req: LookoutActionRequest): void
  onGotoPane(paneId: string): void
  onClose(): void
}

const SELECTOR_HINT = "answer in the pane — it's showing a picker"
const STALE_LABEL = 'session moved on'

/**
 * The bottom-right stack of Lookout cards, plus the (possibly empty) open
 * state reached from the status-bar badge.
 *
 * A card for the currently-focused pane is always suppressed — you are
 * already looking at it, it only contributes to the badge count (computed by
 * the caller). Every other active/stale card renders regardless of `open`;
 * `open` only decides whether an otherwise-empty stack still shows something
 * when the badge is clicked with nothing pending — either a reassurance or
 * the plugin install commands. With nothing to show and the stack unopened,
 * this renders nothing at all rather than an empty decorative box.
 */
export function CardStack(props: CardStackProps): React.JSX.Element {
  const visible = props.cards.filter((c) => c.paneId !== props.suppressedPaneId)

  if (visible.length === 0 && !props.open) return <></>

  return (
    <div className="lookout-stack">
      {visible.map((card) => (
        <CardItem
          key={card.id}
          card={card}
          screenMode={props.screenMode}
          onAction={props.onAction}
          onGotoPane={props.onGotoPane}
        />
      ))}
      {visible.length === 0 && (
        <div className="card">
          {props.pluginInstalled ? (
            <div className="card__question">nothing needs you</div>
          ) : (
            <>
              <div className="card__question">smart cards need the c-assistant plugin:</div>
              <code className="card__cmd">/plugin marketplace add voidharbor/claude-plugins</code>
              <code className="card__cmd">/plugin install c-assistant@voidharbor</code>
            </>
          )}
          <div className="card__actions">
            <button className="btn" onClick={props.onClose}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

interface CardItemProps {
  card: LookoutCard
  screenMode(paneId: string): 'input' | 'selector' | null
  onAction(req: LookoutActionRequest): void
  onGotoPane(paneId: string): void
}

/** Go to pane + a bare dismiss — the fallback button pair shown whenever a
 *  card has nothing safe to send (a draft-less push card by design, or any
 *  card sitting on a non-input screen). */
function gotoPaneAndDismiss(
  disabled: boolean,
  gotoPane: () => void,
  dismiss: () => void
): React.ReactNode {
  return (
    <>
      <button className="btn" disabled={disabled} onClick={gotoPane}>
        Go to pane
      </button>
      <button className="btn" disabled={disabled} onClick={dismiss}>
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
 * button shape (so the layout does not jump) but every button is disabled
 * and labelled `session moved on`, regardless of what screenMode currently
 * reads, because the card can never fire into a changed conversation.
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
  const interactive = props.screenMode(card.paneId) === 'input'
  const hasDraft = card.draft !== null
  // A stale card keeps its normal button shape (disabled) instead of
  // collapsing to the look-only fallback — see the doc comment above.
  const showShape = stale || interactive
  const editable = interactive && !stale

  const [text, setText] = useState(card.draft ?? '')

  const send = (value: string): void => {
    if (props.screenMode(card.paneId) !== 'input') return
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
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    ) : (
      <div className="card__draft card__draft--ref">{card.draft}</div>
    )
    if (showShape) {
      hintNode = stale ? <div className="card__hint">{STALE_LABEL}</div> : null
      actions = (
        <>
          <button className="btn btn--primary" disabled={stale} onClick={() => send(text)}>
            Approve ✓
          </button>
          <button className="btn" disabled={stale} onClick={dismiss}>
            Deny ✕
          </button>
        </>
      )
    } else {
      hintNode = <div className="card__hint">{SELECTOR_HINT}</div>
      actions = gotoPaneAndDismiss(false, gotoPane, dismiss)
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
          <button className="btn" disabled={stale} onClick={gotoPane}>
            Go to pane
          </button>
          <button className="btn" disabled={stale} onClick={dismiss}>
            ✕
          </button>
        </>
      )
    } else {
      hintNode = <div className="card__hint">{SELECTOR_HINT}</div>
      actions = gotoPaneAndDismiss(false, gotoPane, dismiss)
    }
  } else {
    // Draft-less push card — money/legal/irreversible never one-clicks, so
    // there was never a send affordance here to gate on screen mode.
    if (stale) hintNode = <div className="card__hint">{STALE_LABEL}</div>
    actions = gotoPaneAndDismiss(stale, gotoPane, dismiss)
  }

  return (
    <div className={'card' + (stale ? ' card--stale' : '')}>
      <div className="card__pane">{card.paneId}</div>
      <div className="card__question">{card.question}</div>
      {draftNode}
      {hintNode}
      <div className="card__actions">{actions}</div>
    </div>
  )
}
