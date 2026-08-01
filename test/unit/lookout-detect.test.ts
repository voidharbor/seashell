import { describe, expect, it } from 'vitest'
import { planDetections } from '../../src/renderer/lookout/detect.js'

describe('planDetections', () => {
  it('scans a newly waiting unfocused pane once', () => {
    const one = planDetections([{ paneId: 'p1', attention: 'waiting', focused: false }], new Set())
    expect(one.toScan).toEqual(['p1'])
    const two = planDetections([{ paneId: 'p1', attention: 'waiting', focused: false }], one.nextReported)
    expect(two.toScan).toEqual([])
  })
  it('never scans the focused pane', () => {
    const r = planDetections([{ paneId: 'p1', attention: 'waiting', focused: true }], new Set())
    expect(r.toScan).toEqual([])
  })
  it('re-arms after the pane stops waiting', () => {
    const a = planDetections([{ paneId: 'p1', attention: 'waiting', focused: false }], new Set())
    const b = planDetections([{ paneId: 'p1', attention: null, focused: false }], a.nextReported)
    expect(b.nextReported.has('p1')).toBe(false)
    const c = planDetections([{ paneId: 'p1', attention: 'waiting', focused: false }], b.nextReported)
    expect(c.toScan).toEqual(['p1'])
  })
})
