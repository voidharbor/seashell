import { describe, expect, it } from 'vitest'
import { extractQuestion } from '../../src/renderer/lookout/extract.js'

const BOX = ['╭──────────────────────╮', '│ >                    │', '╰──────────────────────╯']

// Captured from a real claude 2.1.220 trust-folder screen via pseudo-tty
// (respaced by hand after ANSI stripping): no input box, ❯-cursor options,
// Enter-to-confirm footer.
const SELECTOR = [
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
  '',
  'Enter to confirm · Esc to cancel',
]

describe('extractQuestion', () => {
  it('finds the question above an idle input box', () => {
    const lines = [
      '⏺ I compared both options.',
      'Want me to lock in option 2 and keep going?',
      '',
      ...BOX,
      '  ? for shortcuts',
    ]
    const r = extractQuestion(lines)
    expect(r?.kind).toBe('input')
    expect(r?.question).toContain('lock in option 2')
  })
  it('returns null when there is neither box nor selector', () => {
    expect(extractQuestion(['just some output', 'no box here?'])).toBeNull()
  })
  it('returns null for a statement-only tail', () => {
    const lines = ['⏺ All done. Committed as abc123.', '', ...BOX]
    expect(extractQuestion(lines)).toBeNull()
  })
  it('accepts numbered options without a question mark above the box', () => {
    const lines = ['Pick one:', '  1. keep both', '  2. delete the old one', '', ...BOX]
    const r = extractQuestion(lines)
    expect(r?.kind).toBe('input')
    expect(r?.question).toMatch(/delete the old one/)
  })
  it('classifies a selector screen and carries its options', () => {
    const r = extractQuestion(SELECTOR)
    expect(r?.kind).toBe('selector')
    expect(r?.question).toContain('trust this folder')
    expect(r?.question).toContain('options:')
    expect(r?.question).toContain('No, exit')
  })
  it('input box wins when both signatures are present', () => {
    const r = extractQuestion([...SELECTOR, '', ...BOX])
    expect(r?.kind).toBe('input')
  })
  it('caps the result at 500 chars on one line', () => {
    const long = 'why? '.repeat(300)
    const lines = [long, '', ...BOX]
    const r = extractQuestion(lines)
    expect(r).not.toBeNull()
    expect(r!.question.length).toBeLessThanOrEqual(500)
    expect(r!.question).not.toContain('\n')
  })
})
