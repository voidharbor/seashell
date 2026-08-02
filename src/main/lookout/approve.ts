import type { LookoutActionResponse } from '../../shared/ipc.js'
import type { CardStore } from './card-store.js'

/**
 * The approve path — the only code path in the whole system that submits
 * into a pane. See
 * docs/superpowers/specs/2026-08-01-lookout-approval-cards-design.md, "Who
 * presses Enter."
 *
 * Every guard re-validates at click time rather than trusting the card that
 * was shown: pane liveness, freshness (no meaningful output since the card
 * was created) and foreground ownership can all have changed in the gap
 * between a card appearing and the user clicking it. Each failure returns its
 * code and writes nothing. Only once every guard has passed do the two writes
 * happen — the text, then a separate lone Enter — and they stay two calls on
 * purpose: combining them into one string would make the Enter
 * indistinguishable from user-typed text at every layer below this function.
 */

const MAX_TEXT_LENGTH = 4000

/** True for any C0 control character (codes 0x00-0x1f) or DEL (0x7f) — the
 *  same set control/protocol.ts rejects at the socket boundary, checked again
 *  here since approveCard is a second entry point for "typed, never
 *  submitted" text and cannot lean on the socket's parser. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export interface ApproveDeps {
  store: CardStore
  /** The pane's controlling tty (e.g. `ttys004`), or null if unknown/exited. */
  paneTty(paneId: string): string | null
  /** Whether the foreground process group on that tty is a main claude process. */
  checkForeground(ttyName: string): Promise<boolean>
  /** Like PtyManager.writeIfLive: reports whether the pane was live. */
  writeIfLive(paneId: string, data: string): boolean
  /** Main's own read of the pane's current screen (lookout/screen-kind.ts) —
   *  never the renderer's, whose buffer can lag the stream at click time. */
  screenKind(paneId: string): 'input' | 'selector' | null
}

export async function approveCard(
  deps: ApproveDeps,
  req: { cardId: string; text: string }
): Promise<LookoutActionResponse> {
  const text = req.text.trim()
  if (text === '' || text.length > MAX_TEXT_LENGTH || hasControlChar(text)) {
    return { ok: false, code: 'EINVALID', message: 'invalid approve text' }
  }

  const card = deps.store.get(req.cardId)
  if (!card) return { ok: false, code: 'ENOTFOUND', message: 'card not found' }

  // A card born from a selector screen never earns a send, no matter what the
  // screen shows now — its question quotes picker options, and its freshness
  // baseline was taken after the picker painted, so the byte delta is blind
  // to it.
  if (card.kind === 'selector') {
    return { ok: false, code: 'ESELECTOR', message: 'card is for a picker screen' }
  }

  // A card main itself marked stale must stay refused — the renderer disables
  // its buttons on the same verdict, and the byte delta alone can read fresh
  // again after e.g. a failed foreground check.
  if (card.state !== 'active') {
    return { ok: false, code: 'ESTALE', message: 'session moved on' }
  }

  if (!deps.store.isFresh(card)) {
    deps.store.markStale(req.cardId)
    return { ok: false, code: 'ESTALE', message: 'session moved on' }
  }

  const tty = deps.paneTty(card.paneId)
  if (tty === null) return { ok: false, code: 'EGONE', message: 'unknown or exited pane' }

  // Live read at click time from main's own stream: if the pane is showing a
  // picker right now, typed text + Enter would blind-confirm the highlighted
  // option. The renderer gates this too, but its xterm buffer lags the pty —
  // this is the check that holds when the renderer's is stale. The card is
  // not marked stale: the session has not moved on, the user should answer
  // in the pane.
  if (deps.screenKind(card.paneId) === 'selector') {
    return { ok: false, code: 'ESELECTOR', message: 'pane is showing a picker' }
  }

  let foreground = false
  try {
    foreground = await deps.checkForeground(tty)
  } catch {
    foreground = false
  }
  if (!foreground) {
    deps.store.markStale(req.cardId)
    return { ok: false, code: 'EFOREGROUND', message: 'pane foreground is not claude' }
  }

  // The pane can exit between the checks above and here; writeIfLive re-checks.
  if (!deps.writeIfLive(card.paneId, text)) {
    return { ok: false, code: 'EGONE', message: 'unknown or exited pane' }
  }

  // The only Enter in the whole system. A separate write from the text above,
  // never concatenated into it — see the module doc comment.
  deps.writeIfLive(card.paneId, '\r')
  deps.store.remove(req.cardId)
  return { ok: true, delivered: true }
}
