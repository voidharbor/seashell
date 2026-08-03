import { describe, expect, it } from 'vitest'
import { changedQuestions, planDetections } from '../../src/renderer/lookout/detect.js'

describe('planDetections', () => {
  it('scans a waiting unfocused pane', () => {
    const r = planDetections([{ paneId: 'p1', attention: 'waiting', focused: false }])
    expect(r.toScan).toEqual(['p1'])
  })
  it('never scans the focused pane', () => {
    const r = planDetections([{ paneId: 'p1', attention: 'waiting', focused: true }])
    expect(r.toScan).toEqual([])
  })
  it('ignores a pane that is not waiting', () => {
    const r = planDetections([
      { paneId: 'p1', attention: null, focused: false },
      { paneId: 'p2', attention: 'done', focused: false },
    ])
    expect(r.toScan).toEqual([])
  })
  // The bug this replaced: a pane read once per waiting spell never got re-read
  // while it stayed `waiting`, so a second question in the same spell was never
  // seen and its card kept naming the first one.
  it('keeps scanning a pane that stays waiting, so a second question is seen', () => {
    const panes = [{ paneId: 'p1', attention: 'waiting' as const, focused: false }]
    expect(planDetections(panes).toScan).toEqual(['p1'])
    expect(planDetections(panes).toScan).toEqual(['p1'])
  })
})

describe('changedQuestions', () => {
  const read = (paneId: string, question: string) => ({
    paneId,
    question,
    kind: 'input' as const,
  })

  it('sends a question the first time it is seen', () => {
    const r = changedQuestions([read('p1', 'deploy?')], new Map())
    expect(r.toSend.map((x) => x.question)).toEqual(['deploy?'])
    expect(r.nextSent.get('p1')).toBe('deploy?')
  })

  it('does not re-send an unchanged question, however many times it is read', () => {
    const first = changedQuestions([read('p1', 'deploy?')], new Map())
    const second = changedQuestions([read('p1', 'deploy?')], first.nextSent)
    expect(second.toSend).toEqual([])
  })

  it('sends immediately when the pane moves on to a new question', () => {
    const first = changedQuestions([read('p1', 'deploy?')], new Map())
    const second = changedQuestions([read('p1', 'delete the branch?')], first.nextSent)
    expect(second.toSend.map((x) => x.question)).toEqual(['delete the branch?'])
  })

  it('forgets a pane that stopped being read, so the same ask later still cards', () => {
    const first = changedQuestions([read('p1', 'deploy?')], new Map())
    const gap = changedQuestions([], first.nextSent) // pane no longer waiting
    expect(gap.nextSent.has('p1')).toBe(false)
    const again = changedQuestions([read('p1', 'deploy?')], gap.nextSent)
    expect(again.toSend.map((x) => x.question)).toEqual(['deploy?'])
  })

  it('keeps panes independent', () => {
    const first = changedQuestions([read('p1', 'a?'), read('p2', 'b?')], new Map())
    const second = changedQuestions([read('p1', 'a?'), read('p2', 'c?')], first.nextSent)
    expect(second.toSend.map((x) => x.paneId)).toEqual(['p2'])
  })
})
