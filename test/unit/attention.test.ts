import { describe, expect, it } from 'vitest'
import {
  DONE_ATTENTION_MS,
  doneExpired,
  nextAttention,
  type Attention,
} from '../../src/renderer/panes/attention.js'
import type { PaneActivity } from '../../src/shared/ipc.js'

const at = (
  previous: PaneActivity | undefined,
  next: PaneActivity,
  current: Attention = null,
  focused = false
): Attention => nextAttention({ previous, next, current, focused })

describe('nextAttention', () => {
  it('glows while a foreground program sits idle', () => {
    expect(at('BUSY', 'WAITING')).toBe('waiting')
    expect(at('WAITING', 'WAITING')).toBe('waiting')
  })

  it('glows when work finishes and the shell comes back', () => {
    expect(at('BUSY', 'PROMPT')).toBe('done')
    expect(at('WAITING', 'PROMPT')).toBe('done')
  })

  it('does not re-trigger for a pane that was already idle at a prompt', () => {
    // Otherwise every idle pane would re-arm on every metrics tick and the
    // whole grid would pulse permanently.
    expect(at('PROMPT', 'PROMPT')).toBeNull()
    expect(at('PROMPT', 'PROMPT', 'done')).toBe('done')
  })

  it('clears once a pane starts working again', () => {
    expect(at('WAITING', 'BUSY', 'waiting')).toBeNull()
    expect(at('PROMPT', 'BUSY', 'done')).toBeNull()
  })

  it('never glows the pane you are looking at', () => {
    expect(at('BUSY', 'WAITING', null, true)).toBeNull()
    expect(at('BUSY', 'PROMPT', 'done', true)).toBeNull()
  })

  it('treats a first sighting with no previous state sensibly', () => {
    expect(at(undefined, 'WAITING')).toBe('waiting')
    // No previous state means nothing is known to have finished.
    expect(at(undefined, 'PROMPT')).toBeNull()
  })
})

describe('doneExpired', () => {
  it('stops asking after the window passes', () => {
    expect(doneExpired(1000, 1000 + DONE_ATTENTION_MS)).toBe(true)
    expect(doneExpired(1000, 1000 + DONE_ATTENTION_MS - 1)).toBe(false)
  })

  it('never expires something that was never set', () => {
    expect(doneExpired(undefined, Date.now())).toBe(false)
  })
})
