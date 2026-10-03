/** [pure] The one envelope shape on the shell pipe (spec 4.2). */
export type EnvelopeKind = 'invoke' | 'send' | 'on' | 'reply'
export interface Envelope { k: EnvelopeKind; ch: string; id?: number; p: unknown }
const KINDS: readonly EnvelopeKind[] = ['invoke', 'send', 'on', 'reply']

/** Channels the shell answers itself (spec 4.2); the core never handles these. */
export const SHELL_CHANNELS: readonly string[] = [
  'window:minimize', 'window:toggleMaximize', 'window:close', 'window:isMaximized', 'window:maximized',
  'app:pickFolder', 'clip:read', 'clip:write',
  'open:withDefaultApp', 'open:revealInFinder', 'open:externalHttp',
  'display:list', 'display:colorization', 'grid:cmd', 'test:screenshot',
]

/** The only `on` channels the core writes to the pipe. Every other push is for the controller. */
export const CORE_PUSH_TO_SHELL: readonly string[] = ['pty:data', 'ui:model', 'grid:cmd', 'shell:cmd']

export function encodeEnvelope(e: Envelope): string {
  // JSON.stringify escapes every newline inside strings, so one envelope is one line.
  return JSON.stringify(e)
}

export function decodeEnvelope(line: string): Envelope {
  const raw: unknown = JSON.parse(line)
  if (typeof raw !== 'object' || raw === null) throw new Error('envelope: not an object')
  const r = raw as Record<string, unknown>
  if (!KINDS.includes(r.k as EnvelopeKind)) throw new Error(`envelope: bad k ${String(r.k)}`)
  if (typeof r.ch !== 'string' || !r.ch) throw new Error('envelope: bad ch')
  if (r.id !== undefined && typeof r.id !== 'number') throw new Error('envelope: bad id')
  if (r.k === 'invoke' && (typeof r.p !== 'object' || r.p === null)) throw new Error('envelope: invoke payload must be an object')
  return { k: r.k as EnvelopeKind, ch: r.ch, id: r.id as number | undefined, p: r.p }
}
