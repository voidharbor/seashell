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
  it('classifies a tall selector whose cursor row sits far above the footer', () => {
    // AskUserQuestion with per-option descriptions wrapped in a narrow pane:
    // the ❯ cursor row is 17 lines above the confirm footer. A search window
    // smaller than a real widget reads this as "no selector" — and a card's
    // send gate treats an unreadable screen as sendable, so the miss PERMITS
    // typing into a live picker rather than blocking it.
    const tall = [
      'Which database migration strategy should I use?',
      '❯ 1. Expand and contract',
      '     Add the new column, dual-write from the app, backfill',
      '     the rows in batches overnight, then drop the old',
      '     column in a follow-up release next week',
      '  2. Blue-green schema swap',
      '     Clone the table with the new schema, keep it in sync',
      '     with triggers, and cut reads over atomically behind',
      '     the connection pooler once the copies converge',
      '  3. In-place ALTER with downtime',
      '     Take the maintenance window tonight and run the ALTER',
      '     directly; simplest possible plan, but the table lock',
      '     blocks writes for the whole duration',
      '  4. Defer the migration',
      '     Keep writing to the current schema for now and come',
      '     back to this after the read-path refactor lands and',
      '     the traffic picture is calmer',
      '',
      'Enter to confirm · Esc to cancel',
    ]
    const r = extractQuestion(tall)
    expect(r?.kind).toBe('selector')
    expect(r?.question).toContain('migration strategy')
    expect(r?.question).toContain('Expand and contract')
  })
  /**
   * The options belong to the WIDGET, not to the transcript above it.
   *
   * Option rows were collected as "every `N.` line between the top of the
   * search window and the footer", and claude renders an ordinary numbered
   * list in a message exactly that way. So a plan the agent had just printed
   * — "1. Add the tenant id to the cache key / 2. Backfill..." — was scooped
   * up as the picker's choices, and because the preamble walks up from the
   * FIRST option found, the picker's real question (which sits below that
   * list) could never be reached. The card then named a question the user was
   * not being asked and offered options that were not the choices.
   *
   * This also guards the interaction with the search window: the window has to
   * stay a full screen tall so a tall picker is never missed (missing one lets
   * a send through, which is the direction that must never fail), and widening
   * it is precisely what lets a list further up the transcript into range.
   * Anchoring on the cursor row is what makes the wide window safe.
   */
  it('quotes the picker’s own question, not a numbered list further up the transcript', () => {
    const tail = [
      '⏺ Here is the plan:',
      '',
      '  1. Add the tenant id to the cache key',
      '  2. Backfill the existing rows',
      '  3. Drop the legacy column',
      '',
      ...Array.from({ length: 14 }, (_, i) => `⏺ Read(src/cache/key${i}.ts)`),
      '',
      'Ready to start. Which step first?',
      '❯ 1. Cache key',
      '  2. Backfill',
      '  3. Drop column',
      '',
      'Enter to confirm · Esc to cancel',
    ]
    const r = extractQuestion(tail)
    expect(r?.kind).toBe('selector')
    expect(r?.question).toContain('Which step first')
    expect(r?.question).not.toContain('Backfill the existing rows')
    expect(r?.question).not.toContain('tenant id')
  })

  /**
   * NOT EVERY PICKER IS NUMBERED, and the unnumbered ones were being read as
   * the input box.
   *
   * The borderless-input fallback accepts any `❯` row that is not `❯ N.` —
   * the numbered lookahead was the ONLY thing separating "selection cursor"
   * from "input prompt". claude draws plenty of pickers whose rows are just
   * pointer + label (its dialogs render `isSelected ? pointer : " "` with no
   * index; the spend-limit dialog "What do you want to do?" is one), and those
   * dialogs have no border either, so nothing else distinguished them.
   *
   * The consequence was the worst one available: kind 'input' means the card
   * gets live send buttons, and a send is text followed by a lone Enter —
   * which on a picker confirms whatever option is highlighted. The confirm
   * footer sitting BELOW the row is what gives it away: claude's input box is
   * the bottom-most chrome on its screen and never has one under it.
   */
  it('an unnumbered picker is not read as the input box', () => {
    const lines = [
      '⏺ Checking your usage limits.',
      '',
      'You have hit the weekly limit. How do you want to continue?',
      '❯ Switch to a smaller model for the rest of the week',
      '  Buy extra usage credits now',
      '  Stop here and wait for the reset',
      '',
      'Enter to confirm · Esc to cancel',
    ]
    const r = extractQuestion(lines)
    expect(r?.kind).toBe('selector')
    expect(r?.question).toContain('How do you want to continue')
    expect(r?.question).toContain('Switch to a smaller model')
  })

  it('an ordinary borderless prompt is still an input box', () => {
    // The guard keys off a confirm footer BELOW the row, so the borderless
    // prompt — the shape the unnumbered picker was being confused with — must
    // be entirely unaffected when no footer follows it.
    const r = extractQuestion(['⏺ Two paths here. Which one do you want?', '', ...RULE_BOX])
    expect(r?.kind).toBe('input')
    expect(r?.question).toContain('Which one do you want')
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
