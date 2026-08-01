/**
 * Request validation for the control socket — see
 * docs/superpowers/specs/2026-07-31-pane-delivery-design.md.
 *
 * This module is [pure]: no I/O, no electron. The no-control-characters rule
 * is the load-bearing one — it makes "typed, never submitted" a property of
 * the boundary rather than good behavior by callers, and it shuts out escape
 * sequences along the way.
 */

export const MAX_TEXT_LENGTH = 4000

export interface ControlRequest {
  cmd: 'type'
  paneId: string
  text: string
}

export type ParseResult = { ok: true; req: ControlRequest } | { ok: false; error: string }

// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

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
  if (o['cmd'] !== 'type') return { ok: false, error: 'unknown cmd' }
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
  return { ok: true, req: { cmd: 'type', paneId, text } }
}
