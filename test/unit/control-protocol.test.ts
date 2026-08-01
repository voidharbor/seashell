import { describe, expect, it } from 'vitest'
import { parseControlRequest, MAX_TEXT_LENGTH } from '../../src/main/control/protocol.js'

const valid = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ cmd: 'type', paneId: 'pane-8-304837', text: 'yes do the relay now', ...over })

describe('parseControlRequest', () => {
  it('accepts a well-formed type request', () => {
    const r = parseControlRequest(valid())
    expect(r).toEqual({
      ok: true,
      req: { cmd: 'type', paneId: 'pane-8-304837', text: 'yes do the relay now' },
    })
  })

  it('rejects invalid JSON', () => {
    const r = parseControlRequest('{nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/JSON/i)
  })

  it('rejects a non-object payload', () => {
    expect(parseControlRequest('"hello"').ok).toBe(false)
    expect(parseControlRequest('[1,2]').ok).toBe(false)
    expect(parseControlRequest('null').ok).toBe(false)
  })

  it('rejects unknown commands', () => {
    const r = parseControlRequest(valid({ cmd: 'exec' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/cmd/i)
  })

  it('rejects a missing or empty paneId', () => {
    expect(parseControlRequest(valid({ paneId: undefined })).ok).toBe(false)
    expect(parseControlRequest(valid({ paneId: '' })).ok).toBe(false)
    expect(parseControlRequest(valid({ paneId: 42 })).ok).toBe(false)
  })

  it('rejects missing or empty text', () => {
    expect(parseControlRequest(valid({ text: undefined })).ok).toBe(false)
    expect(parseControlRequest(valid({ text: '' })).ok).toBe(false)
    expect(parseControlRequest(valid({ text: 7 })).ok).toBe(false)
  })

  it('rejects every control character, so a request can never submit', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\x1bb', 'a\x00b', 'a\x7fb']) {
      const r = parseControlRequest(valid({ text: bad }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/control/i)
    }
  })

  it('enforces the length cap at the boundary', () => {
    expect(parseControlRequest(valid({ text: 'x'.repeat(MAX_TEXT_LENGTH) })).ok).toBe(true)
    const r = parseControlRequest(valid({ text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/long/i)
  })
})
