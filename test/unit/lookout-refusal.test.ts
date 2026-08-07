import { describe, expect, it } from 'vitest'
import { refusalMessage, type LookoutRefusalCode } from '../../src/renderer/lookout/refusal.js'

/** Every code main's approve path can return. Kept as a literal list so adding
 *  a code to the union without a message here fails the typecheck AND this
 *  test, rather than shipping a card that refuses in silence again. */
const CODES: LookoutRefusalCode[] = [
  'ENOTFOUND',
  'ESTALE',
  'EGONE',
  'EFOREGROUND',
  'EINVALID',
  'ESELECTOR',
]

describe('refusalMessage', () => {
  it('has a distinct, non-empty message for every refusal code', () => {
    const messages = CODES.map(refusalMessage)
    for (const m of messages) expect(m.length).toBeGreaterThan(10)
    expect(new Set(messages).size).toBe(CODES.length)
  })

  /**
   * The one a user actually hits. The draft box is multi-line, so typing a
   * line break into a reply is natural — and main refuses it, correctly,
   * because a newline in the text would submit the reply halfway through,
   * ahead of the deliberate single Enter that follows. Before this the button
   * simply did nothing, which reads as a broken card rather than a protected
   * conversation.
   */
  it('names line breaks as the cause of an invalid reply', () => {
    expect(refusalMessage('EINVALID')).toMatch(/line break/i)
  })

  it('sends the user to the pane when a picker is showing', () => {
    expect(refusalMessage('ESELECTOR')).toMatch(/pane/i)
  })

  // No message may be raw jargon: these are read mid-task, in a toast.
  it('never shows the user an error code', () => {
    for (const code of CODES) expect(refusalMessage(code)).not.toContain(code)
  })
})
