/**
 * [pure] Envelopes the core answers on the stdin line handler itself, before
 * the controller routes and before the shim's dispatch. Only `core:ping`
 * (Phase 2 Task 1): the shell's driver times a bare round trip through the
 * wire with it, so the answer touches nothing but the pipe.
 */
import { encodeEnvelope, type Envelope } from './protocol.js'

/** True when `e` was answered here (and must not reach the shim). */
export function answerEarly(e: Envelope, write: (line: string) => void): boolean {
  if (e.k !== 'invoke' || e.ch !== 'core:ping') return false
  write(encodeEnvelope({ k: 'reply', ch: 'core:ping', id: e.id, p: e.p }))
  return true
}
