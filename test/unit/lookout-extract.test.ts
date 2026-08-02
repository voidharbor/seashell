import { describe, expect, it } from 'vitest'
import { extractQuestion } from '../../src/renderer/lookout/extract.js'

const BOX = ['╭──────────────────────╮', '│ >                    │', '╰──────────────────────╯']

// The borderless input area claude draws inside a real SeaShell pane
// (verified against live pixels 2026-08-01): rule, ❯ prompt row, rule,
// then the user's statusline instead of the shortcuts footer.
const RULE_BOX = [
  '──────────────────────────────────────',
  '❯',
  '──────────────────────────────────────',
  '  🍔 Haiku 4.5  |  ctx 17%  |  xhigh',
  '  ⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent',
  '',
  '/rc',
]

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
  it('finds the question above a borderless rule-framed input row', () => {
    const lines = [
      "⏺ If the NOAA data returns fewer than 3 lines, should the script print an",
      '  error message, silently exit, or retry?',
      '',
      '✳ Baked for 3s',
      '',
      ...RULE_BOX,
    ]
    const r = extractQuestion(lines)
    expect(r?.kind).toBe('input')
    expect(r?.question).toContain('silently exit')
  })
  it('returns null for a statement above the borderless input row', () => {
    const lines = ['⏺ All done. Committed as abc123.', '', ...RULE_BOX]
    expect(extractQuestion(lines)).toBeNull()
  })
  it('a ❯ selector option row is not mistaken for the borderless input row', () => {
    const lines = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      '',
      'Enter to confirm · Esc to cancel',
    ]
    const r = extractQuestion(lines)
    expect(r?.kind).toBe('selector')
  })
  it('finds the question when the input rules are styled blanks (no rule chars in buffer)', () => {
    const lines = [
      '⏺ When the station returns no data, should the script raise an exception',
      '  with an error message, or exit gracefully with a default output?',
      '',
      '✳ Baked for 4s',
      '',
      '',
      '❯',
      '',
      '  🍔 Haiku 4.5  |  ctx 17%  |  xhigh',
      '  ⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent',
      '',
      '/rc',
    ]
    const r = extractQuestion(lines)
    expect(r?.kind).toBe('input')
    expect(r?.question).toContain('exit gracefully')
  })
  it('a bare ❯ shell prompt without claude chrome never cards', () => {
    const lines = ['what is this? some scrollback text', '', '❯']
    expect(extractQuestion(lines)).toBeNull()
  })
  it('a slash-command echo is chrome, not a question', () => {
    const lines = ['⏺ Done with that.', '', '❯ /clear', '', '❯', '', '  ⏵⏵ accept edits on']
    expect(extractQuestion(lines)).toBeNull()
  })
  it('skips the end-of-turn timing line so the question above it still cards', () => {
    const lines = [
      '⏺ Ready to rename the flaky test. Should I go ahead?',
      '',
      '✳ Baked for 45s',
      '',
      ...BOX,
      '  ? for shortcuts',
    ]
    const r = extractQuestion(lines)
    expect(r?.kind).toBe('input')
    expect(r?.question).toContain('go ahead')
  })
  it('skips timing lines regardless of which glyph the spinner settled on', () => {
    for (const timing of ['✻ Worked for 6s', '✽ Brewed for 3s', '· Flambéing… (29s)']) {
      const lines = ['⏺ Two paths here. Which one do you want?', '', timing, '', ...BOX]
      const r = extractQuestion(lines)
      expect(r?.kind).toBe('input')
      expect(r?.question).toContain('Which one')
    }
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
