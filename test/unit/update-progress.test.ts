import { describe, expect, it } from 'vitest'
import { shouldEmitProgress, UNKNOWN_TOTAL_MS } from '../../src/main/update/progress.js'

const at = (received: number, total: number, ms: number) => ({ received, total, at: ms })

describe('shouldEmitProgress', () => {
  it('stays quiet while the whole percent is unchanged', () => {
    // A 60 MB zip arrives in roughly 64 KB chunks, so most of them land inside
    // the same percent and would only redraw the same banner.
    expect(shouldEmitProgress(at(1_000_000, 60_000_000, 0), at(1_064_000, 60_000_000, 20))).toBe(
      false
    )
  })

  it('emits when the whole percent moves', () => {
    expect(shouldEmitProgress(at(599_000, 60_000_000, 0), at(601_000, 60_000_000, 20))).toBe(true)
    expect(shouldEmitProgress(at(0, 100, 0), at(1, 100, 1))).toBe(true)
  })

  it('emits at the end even from the same percent', () => {
    expect(shouldEmitProgress(at(99_500, 100_000, 0), at(100_000, 100_000, 5))).toBe(true)
  })

  it('falls back to a time gap when the total is unknown', () => {
    expect(shouldEmitProgress(at(0, 0, 0), at(64_000, 0, UNKNOWN_TOTAL_MS - 1))).toBe(false)
    expect(shouldEmitProgress(at(0, 0, 0), at(64_000, 0, UNKNOWN_TOTAL_MS))).toBe(true)
  })

  it('never divides by a negative or absent total', () => {
    expect(shouldEmitProgress(at(0, -1, 0), at(10, -1, 1))).toBe(false)
    expect(shouldEmitProgress(at(0, -1, 0), at(10, -1, UNKNOWN_TOTAL_MS))).toBe(true)
  })
})
