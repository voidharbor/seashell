import { describe, expect, it } from 'vitest'
import { CORE_PUSH_TO_SHELL, decodeEnvelope, encodeEnvelope, SHELL_CHANNELS } from '../../src/core/protocol.js'

describe('core envelope', () => {
  it('round trips an invoke with an id on one line', () => {
    const line = encodeEnvelope({ k: 'invoke', ch: 'fs:probe', id: 7, p: { path: '/x' } })
    expect(line.includes('\n')).toBe(false)
    expect(decodeEnvelope(line)).toEqual({ k: 'invoke', ch: 'fs:probe', id: 7, p: { path: '/x' } })
  })
  it('rejects unknown kinds, bad channels, bad ids and non-object invoke payloads', () => {
    expect(() => decodeEnvelope('{"k":"exec","ch":"x","p":{}}')).toThrow(/k/)
    expect(() => decodeEnvelope('{"k":"send","ch":5,"p":{}}')).toThrow(/ch/)
    expect(() => decodeEnvelope('{"k":"reply","ch":"x","id":"1","p":{}}')).toThrow(/id/)
    expect(() => decodeEnvelope('{"k":"invoke","ch":"fs:probe","id":1,"p":"str"}')).toThrow(/payload/)
  })
  it('keeps newlines inside strings escaped', () => {
    const line = encodeEnvelope({ k: 'send', ch: 'pty:write', p: { paneId: 'a', data: 'ls\n' } })
    expect(line.split('\n')).toHaveLength(1)
  })
  it('names the shell-owned and shell-bound channels', () => {
    expect(SHELL_CHANNELS).toContain('clip:write')
    expect(SHELL_CHANNELS).not.toContain('pty:spawn')
    expect(CORE_PUSH_TO_SHELL).toEqual(['pty:data', 'ui:model', 'grid:cmd'])
  })
})
