/**
 * Request validation for the control socket — see
 * docs/superpowers/specs/2026-07-31-pane-delivery-design.md.
 *
 * This module is [pure]: no I/O, no electron. The no-control-characters rule
 * is the load-bearing one — it makes "typed, never submitted" a property of
 * the boundary rather than good behavior by callers, and it shuts out escape
 * sequences along the way.
 *
 * The socket has one command, `type`, which cannot submit.
 */

export const MAX_TEXT_LENGTH = 4000

export interface TypeRequest {
  cmd: 'type'
  paneId: string
  text: string
  /** The tty the sender believes this pane has (from the session registry).
   *  When present, the server refuses on mismatch — a pane id can outlive
   *  the SeaShell run that minted it and be reused by a different pane. */
  tty: string | null
}

export type ControlRequest = TypeRequest

export type ParseResult = { ok: true; req: ControlRequest } | { ok: false; error: string }

// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const MAX_TTY_LENGTH = 64

/** Optional tty field shared by both commands: absent -> ok with null,
 *  present -> must be a short control-free non-empty string. */
function parseTty(raw: unknown): { ok: true; tty: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, tty: null }
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_TTY_LENGTH) return { ok: false }
  if (CONTROL_CHARS.test(raw)) return { ok: false }
  return { ok: true, tty: raw }
}

export function parseControlRequest(line: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'request must be a JSON object' }
  }
  const o = parsed as Record<string, unknown>
  if (o['cmd'] === 'type') {
    const paneId = o['paneId']
    if (typeof paneId !== 'string' || paneId === '') return { ok: false, error: 'missing paneId' }
    const text = o['text']
    if (typeof text !== 'string' || text === '') return { ok: false, error: 'missing or empty text' }
    if (text.length > MAX_TEXT_LENGTH) {
      return { ok: false, error: `text too long (max ${MAX_TEXT_LENGTH} chars)` }
    }
    if (CONTROL_CHARS.test(text)) {
      return { ok: false, error: 'control characters rejected: text is typed, never submitted' }
    }
    const tty = parseTty(o['tty'])
    if (!tty.ok) return { ok: false, error: 'malformed tty' }
    return { ok: true, req: { cmd: 'type', paneId, text, tty: tty.tty } }
  }
  return { ok: false, error: 'unknown cmd' }
}
