import { describe, expect, it } from 'vitest'
import { isSuffixCandidate, joinCandidates, normaliseSuffix } from '../../src/renderer/links/wrap-join.js'

describe('joinCandidates', () => {
  const base = { cols: 40, prevRow: null, nextRow: null }
  it('returns the token alone when it touches neither edge', () => {
    expect(joinCandidates({ ...base, candidate: 'src/a.ts', startCol: 5, endCol: 13 })).toEqual(['src/a.ts'])
  })
  it('joins the next row when the token reaches the right edge', () => {
    expect(
      joinCandidates({ ...base, candidate: 'src/renderer/pan', startCol: 24, endCol: 40, nextRow: 'es/PaneView.tsx and more' })
    ).toEqual(['src/renderer/pan', 'src/renderer/panes/PaneView.tsx'])
  })
  it('joins the previous row when the token starts at column 0', () => {
    expect(
      joinCandidates({ ...base, candidate: 'es/PaneView.tsx', startCol: 0, endCol: 15, prevRow: 'Reading src/renderer/pan' })
    ).toEqual(['es/PaneView.tsx', 'src/renderer/panes/PaneView.tsx'])
  })
  it('tries both joins when both edges are touched', () => {
    // Built from `b` rather than written out: a row-wide token is 40 characters
    // and a literal that long is impossible to check by eye.
    const b = 'b'.repeat(40)
    const out = joinCandidates({
      ...base,
      candidate: b,
      startCol: 0,
      endCol: 40,
      prevRow: 'x aaa',
      nextRow: 'ccc y',
    })
    expect(out).toEqual([b, `${b}ccc`, `aaa${b}`, `aaa${b}ccc`])
  })
  it('ignores a neighbouring row that starts with whitespace', () => {
    expect(joinCandidates({ ...base, candidate: 'src/a', startCol: 35, endCol: 40, nextRow: '  indented' })).toEqual(['src/a'])
  })
})

describe('suffix candidates', () => {
  it('recognises the ellipsis forms', () => {
    expect(isSuffixCandidate('…/renderer/app.tsx')).toBe(true)
    expect(isSuffixCandidate('.../renderer/app.tsx')).toBe(true)
    expect(isSuffixCandidate('src/renderer/app.tsx')).toBe(false)
  })
  it('normalises to a segment-anchored suffix', () => {
    expect(normaliseSuffix('…/renderer/app.tsx')).toBe('/renderer/app.tsx')
    expect(normaliseSuffix('.../app.tsx')).toBe('/app.tsx')
  })
})
