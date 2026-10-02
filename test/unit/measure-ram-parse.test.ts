import { describe, expect, it } from 'vitest'
import { medianOf, parseResults } from '../../scripts/win/measure-ram-parse.mjs'

describe('measure-ram results', () => {
  it('takes the median of an odd and an even list', () => {
    expect(medianOf([5, 1, 3])).toBe(3)
    expect(medianOf([4, 1, 3, 2])).toBe(2.5)
  })
  it('parses one JSON object per line and skips blanks', () => {
    const rows = parseResults('{"label":"A","wsMB":410}\n\n{"label":"B","wsMB":120}\n')
    expect(rows.map((r) => r.label)).toEqual(['A', 'B'])
  })
  it('refuses a row without a label or a number', () => {
    expect(() => parseResults('{"wsMB":1}')).toThrow(/label/)
    expect(() => parseResults('{"label":"A","wsMB":"x"}')).toThrow(/wsMB/)
  })
})
