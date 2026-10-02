import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { startStdio } from '../../src/core/stdio-bridge.js'

describe('stdio bridge', () => {
  it('dispatches two envelopes in one chunk and one split across chunks, tolerating CRLF and blank lines', async () => {
    const seen: unknown[] = []
    const shim = { dispatch: async (e: unknown) => { seen.push(e) } } as never
    const input = new PassThrough()
    startStdio(shim, input)
    input.write('{"k":"send","ch":"a","p":{}}\r\n{"k":"send","ch":"b","p":{}}\n\n{"k":"se')
    await new Promise((r) => setTimeout(r, 5))
    input.write('nd","ch":"c","p":{"x":1}}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(seen.map((e) => (e as { ch: string }).ch)).toEqual(['a', 'b', 'c'])
  })
  it('skips a line that does not decode and keeps going', async () => {
    const seen: unknown[] = []
    const shim = { dispatch: async (e: unknown) => { seen.push(e) } } as never
    const input = new PassThrough()
    startStdio(shim, input)
    input.write('not json\n{"k":"send","ch":"ok","p":{}}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(seen).toHaveLength(1)
  })
})
