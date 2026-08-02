import { describe, expect, it } from 'vitest'
import { pickFallbackSessionIds, pickSessionIds } from '../../src/main/state/session-lookup.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

/** The registry lane is only as good as the hook that fills it. These cover the
 *  transcript fallback that has to carry restore when the hook never fired. */
describe('pickFallbackSessionIds', () => {
  const lister = (byCwd: Record<string, { sid: string; mtimeMs: number }[]>) =>
    (cwd: string): { sid: string; mtimeMs: number }[] => byCwd[cwd] ?? []

  it('resolves a pane the registry missed, newest transcript first', () => {
    const out = pickFallbackSessionIds(
      [{ paneId: 'p1', cwd: '/w' }],
      {},
      lister({ '/w': [{ sid: A, mtimeMs: 10 }, { sid: B, mtimeMs: 90 }] })
    )
    expect(out).toEqual({ p1: B })
  })

  it('leaves panes the registry already resolved alone', () => {
    const out = pickFallbackSessionIds(
      [{ paneId: 'p1', cwd: '/w' }],
      { p1: C },
      lister({ '/w': [{ sid: A, mtimeMs: 99 }] })
    )
    expect(out).toEqual({})
  })

  it('never hands the same session to two panes sharing a cwd', () => {
    const out = pickFallbackSessionIds(
      [
        { paneId: 'p1', cwd: '/w' },
        { paneId: 'p2', cwd: '/w' },
      ],
      {},
      lister({ '/w': [{ sid: A, mtimeMs: 10 }, { sid: B, mtimeMs: 90 }] })
    )
    expect(out).toEqual({ p1: B, p2: A })
  })

  it('never reuses a session the registry already claimed', () => {
    const out = pickFallbackSessionIds(
      [
        { paneId: 'p1', cwd: '/w' },
        { paneId: 'p2', cwd: '/w' },
      ],
      { p1: B },
      lister({ '/w': [{ sid: A, mtimeMs: 10 }, { sid: B, mtimeMs: 90 }] })
    )
    expect(out).toEqual({ p2: A })
  })

  it('runs dry rather than guessing when a cwd has no transcripts left', () => {
    const out = pickFallbackSessionIds(
      [
        { paneId: 'p1', cwd: '/w' },
        { paneId: 'p2', cwd: '/w' },
      ],
      {},
      lister({ '/w': [{ sid: A, mtimeMs: 10 }] })
    )
    expect(out).toEqual({ p1: A })
  })

  it('drops ids that are not UUID-shaped, same as every other boundary', () => {
    const out = pickFallbackSessionIds(
      [{ paneId: 'p1', cwd: '/w' }],
      {},
      lister({ '/w': [{ sid: 'claude; rm -rf /', mtimeMs: 99 }, { sid: A, mtimeMs: 10 }] })
    )
    expect(out).toEqual({ p1: A })
  })

  it('never claims a session that is already live in another pane', () => {
    const out = pickFallbackSessionIds(
      [{ paneId: 'p1', cwd: '/w' }],
      {},
      lister({ '/w': [{ sid: B, mtimeMs: 90 }, { sid: A, mtimeMs: 10 }] }),
      new Set([B])
    )
    expect(out).toEqual({ p1: A })
  })

  it('leaves a pane unresolved rather than doubling up on a live session', () => {
    const out = pickFallbackSessionIds(
      [{ paneId: 'p1', cwd: '/w' }],
      {},
      lister({ '/w': [{ sid: B, mtimeMs: 90 }] }),
      new Set([B])
    )
    expect(out).toEqual({})
  })

  it('keeps panes in different cwds independent', () => {
    const out = pickFallbackSessionIds(
      [
        { paneId: 'p1', cwd: '/w' },
        { paneId: 'p2', cwd: '/x' },
      ],
      {},
      lister({ '/w': [{ sid: A, mtimeMs: 10 }], '/x': [{ sid: B, mtimeMs: 10 }] })
    )
    expect(out).toEqual({ p1: A, p2: B })
  })
})

describe('pickSessionIds still owns the registry lane', () => {
  it('prefers the newest live registration for a pane', () => {
    const out = pickSessionIds(
      [
        { pane_id: 'p1', session_id: A, pid: 1, registered_at: 1 },
        { pane_id: 'p1', session_id: B, pid: 1, registered_at: 5 },
      ],
      ['p1'],
      () => true
    )
    expect(out).toEqual({ p1: B })
  })

  it('ignores a registration whose process is gone', () => {
    const out = pickSessionIds([{ pane_id: 'p1', session_id: A, pid: 1 }], ['p1'], () => false)
    expect(out).toEqual({})
  })
})
