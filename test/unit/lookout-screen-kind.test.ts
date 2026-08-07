import { describe, expect, it } from 'vitest'
import { screenKindOf } from '../../src/main/lookout/screen-kind.js'

/**
 * Raw pty streams, not xterm-rendered buffers: these fixtures carry the ANSI
 * chrome ink actually emits (cursor hide, erase-line, SGR runs) around the
 * plain-text shapes verified in lookout-extract.test.ts. The parser under
 * test reads main's per-pane output tail, which never passes through a
 * terminal emulator, so the fixtures must not either.
 */

const SELECTOR_PAINT =
  '\x1b[?25l\x1b[2K\x1b[G' +
  'Quick safety check: Is this a project you created or one you trust?\r\n' +
  '\x1b[2K\x1b[36m❯ 1. Yes, I trust this folder\x1b[39m\r\n' +
  '\x1b[2K  2. No, exit\r\n' +
  '\x1b[2K\r\n' +
  '\x1b[2K\x1b[2mEnter to confirm · Esc to cancel\x1b[22m'

const INPUT_BOX_PAINT =
  '\x1b[2K\x1b[G⏺ I compared both options.\r\n\r\n' +
  'Want me to lock in option 2 and keep going?\r\n\r\n' +
  '╭──────────────────────────────────────╮\r\n' +
  '│ > \x1b[7m \x1b[27m                                  │\r\n' +
  '╰──────────────────────────────────────╯\r\n' +
  '  \x1b[2m? for shortcuts\x1b[22m'

const BORDERLESS_INPUT_PAINT =
  '\x1b[2K\x1b[G⏺ Done with the refactor.\r\n\r\n' +
  'Should I run the tests now?\r\n\r\n' +
  '\x1b[2K❯ \r\n' +
  '\x1b[2m? for shortcuts\x1b[22m'

describe('screenKindOf', () => {
  it('reads a selector paint as selector', () => {
    expect(screenKindOf(SELECTOR_PAINT)).toBe('selector')
  })

  it('reads an idle input-box paint as input', () => {
    expect(screenKindOf(INPUT_BOX_PAINT)).toBe('input')
  })

  it('reads the borderless input paint as input', () => {
    expect(screenKindOf(BORDERLESS_INPUT_PAINT)).toBe('input')
  })

  it('the most recent paint wins: selector answered, box repainted', () => {
    expect(screenKindOf(SELECTOR_PAINT + '\r\n' + INPUT_BOX_PAINT)).toBe('input')
  })

  it('the most recent paint wins: box replaced by a selector', () => {
    expect(screenKindOf(INPUT_BOX_PAINT + '\r\n' + SELECTOR_PAINT)).toBe('selector')
  })

  it('plain shell output is neither', () => {
    expect(screenKindOf('josh@mac ~ % ls\r\nfile.txt  notes.md\r\n')).toBeNull()
  })

  it('an empty tail is neither', () => {
    expect(screenKindOf('')).toBeNull()
  })

  /**
   * The tail is a fixed byte budget of history, so a picker the user answered a
   * while ago can still be sitting in it. If the pane then goes quiet, no newer
   * input row arrives to outrank that frame and every send into a pane plainly
   * showing its input box gets refused with ESELECTOR. Selector evidence older
   * than the current screen is history.
   */
  it('a picker answered long ago does not refuse writes to a live input box', () => {
    const answeredPicker =
      'Do you trust this folder?\r\n❯ 1. Yes, I trust it\r\n  2. No, exit\r\nEnter to confirm · Esc to cancel\r\n'
    // A screen's worth of ordinary output since, ending at the input box.
    const since = Array.from({ length: 70 }, (_, i) => `⏺ line ${i} of the answer`).join('\r\n')
    expect(screenKindOf(answeredPicker + since + '\r\n' + INPUT_BOX_PAINT)).toBe('input')
  })

  it('a picker showing right now still refuses', () => {
    const live =
      '⏺ Working on it.\r\n\r\nDo you trust this folder?\r\n❯ 1. Yes, I trust it\r\n  2. No, exit\r\nEnter to confirm · Esc to cancel\r\n'
    expect(screenKindOf(live)).toBe('selector')
  })

  it('a transcript line merely quoting the footer is not a selector', () => {
    // No option rows anywhere near the quoted footer text — a real selector
    // always paints its numbered options directly above the confirm hint.
    const quoted =
      '⏺ The pane shows a hint that says Enter to confirm at the bottom.\r\n\r\n' + INPUT_BOX_PAINT
    expect(screenKindOf(quoted)).toBe('input')
  })

  /**
   * A TALL picker: AskUserQuestion's real shape when each option carries a
   * wrapped description in a narrow pane — ink wraps to pane width itself, so
   * every visual row is a real newline in the stream. Cursor on option 1 puts
   * the `Enter to confirm` footer 17 segments below the `❯ 1.` row. The footer
   * is what anchors selector evidence; if its pairing window is smaller than a
   * widget can be, the picker showing RIGHT NOW goes unseen and an older input
   * box further up the tail outranks it — the misread PERMITS a send instead
   * of blocking one, which is the one direction screen-kind promises never to
   * fail in.
   */
  const TALL_SELECTOR_PAINT =
    '\x1b[?25l' +
    [
      'Which database migration strategy should I use?',
      '\x1b[36m❯ 1. Expand and contract\x1b[39m',
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
      '\x1b[2mEnter to confirm · Esc to cancel\x1b[22m',
    ]
      .map((l) => '\x1b[2K' + l)
      .join('\r\n')

  it('a tall picker showing right now refuses, even with an old input box above', () => {
    expect(screenKindOf(INPUT_BOX_PAINT + '\r\n' + TALL_SELECTOR_PAINT)).toBe('selector')
  })

  it('a tall picker with no other history still reads as selector', () => {
    expect(screenKindOf(TALL_SELECTOR_PAINT)).toBe('selector')
  })

  /**
   * An UNNUMBERED picker — pointer + label, no `1.` — which claude draws for
   * its own dialogs (theme choice, the spend-limit "What do you want to do?"
   * prompt, any list rendered with indexes hidden).
   *
   * This is the shape that got past both gates. INPUT_ROW_RE accepts any `❯`
   * row that is not `❯ N.`, so the picker's own cursor row registered as the
   * input prompt; CURSOR_OPTION_RE required the number, so the confirm footer
   * below it was thrown away as unpaired. Verdict: 'input' — which is the one
   * verdict that PERMITS a write, and the write ends in a lone Enter that
   * confirms whatever option is highlighted.
   *
   * This file's contract is that a misread can only ever block a send, never
   * permit one. This was the counterexample.
   */
  const UNNUMBERED_SELECTOR_PAINT =
    '\x1b[?25l\x1b[2K\x1b[G' +
    'Select a theme\r\n' +
    '\x1b[2K\x1b[36m❯ Dark mode\x1b[39m\r\n' +
    '\x1b[2K  Light mode\r\n' +
    '\x1b[2K\x1b[2mEnter to confirm · Esc to cancel\x1b[22m'

  it('reads an unnumbered picker as selector, not as the input prompt', () => {
    expect(screenKindOf(UNNUMBERED_SELECTOR_PAINT)).toBe('selector')
  })

  it('an unnumbered picker still wins over an input box painted earlier', () => {
    expect(screenKindOf(INPUT_BOX_PAINT + '\r\n' + UNNUMBERED_SELECTOR_PAINT)).toBe('selector')
  })

  /**
   * The other direction has to keep working: an idle prompt with the user's
   * half-typed text in it is a `❯ <text>` row too, and it is NOT a picker.
   * What separates them is the confirm footer below — this screen has none.
   */
  it('a prompt row with typed text is still input', () => {
    const typed =
      '\x1b[2K\x1b[G⏺ Ready when you are.\r\n\r\n' +
      '\x1b[2K❯ deploy the staging branch\r\n' +
      '\x1b[2m? for shortcuts\x1b[22m'
    expect(screenKindOf(typed)).toBe('input')
  })
})
