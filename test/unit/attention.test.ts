import { describe, expect, it } from 'vitest'
import { DONE_ATTENTION_MS, doneExpired, nextAttention, type Attention } from '../../src/renderer/panes/attention.js'
import type { PaneActivity } from '../../src/shared/ipc.js'

const tick = (
  previous: PaneActivity | undefined,
  next: PaneActivity,
  current: Attention = null,
  focused = false
): Attention => nextAttention({ previous, next, current, focused })

describe('nextAttention (bell-driven)', () => {
  it('never invents waiting from stillness', () => {
    expect(tick('BUSY', 'WAITING')).toBeNull()
    expect(tick('WAITING', 'WAITING')).toBeNull()
    expect(tick(undefined, 'WAITING')).toBeNull()
  })
  it('keeps a waiting set by a bell while the pane stays still and unfocused', () => {
    expect(tick('WAITING', 'WAITING', 'waiting')).toBe('waiting')
  })
  it('clears waiting when the program goes back to work', () => {
    expect(tick('WAITING', 'BUSY', 'waiting')).toBeNull()
  })
  it('clears everything on focus', () => {
    expect(tick('WAITING', 'WAITING', 'waiting', true)).toBeNull()
    expect(tick('BUSY', 'PROMPT', 'done', true)).toBeNull()
  })
  it('pulses done when the process tree returns to the prompt', () => {
    expect(tick('BUSY', 'PROMPT')).toBe('done')
    expect(tick('WAITING', 'PROMPT', 'waiting')).toBe('done')
    expect(tick('PROMPT', 'PROMPT', 'done')).toBe('done')
    expect(tick('PROMPT', 'PROMPT')).toBeNull()
  })
})

describe('doneExpired', () => {
  it('expires after the pulse length', () => {
    expect(doneExpired(1000, 1000 + DONE_ATTENTION_MS - 1)).toBe(false)
    expect(doneExpired(1000, 1000 + DONE_ATTENTION_MS)).toBe(true)
    expect(doneExpired(undefined, 5000)).toBe(false)
  })
})
