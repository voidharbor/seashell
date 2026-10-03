import { describe, expect, it } from 'vitest'
import { answerEarly } from '../../src/core/index-routes.js'

describe('core:ping', () => {
  it('is answered before the shim sees it, with the same t', () => {
    const out: string[] = []
    const handled = answerEarly({ k: 'invoke', ch: 'core:ping', id: 3, p: { t: 12.5 } }, (line) => out.push(line))
    expect(handled).toBe(true)
    expect(JSON.parse(out[0]!)).toEqual({ k: 'reply', ch: 'core:ping', id: 3, p: { t: 12.5 } })
  })
  it('leaves every other channel alone', () => {
    const out: string[] = []
    expect(answerEarly({ k: 'invoke', ch: 'fs:probe', id: 1, p: {} }, (line) => out.push(line))).toBe(false)
    expect(out).toEqual([])
  })
})
