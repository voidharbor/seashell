/**
 * Question extraction from a claude pane's tail (Lookout Task 3).
 *
 * [pure] — strings in, a structured result out. No xterm import, no DOM, no
 * Electron: the renderer's detection effect (a later task) is the only
 * caller, and it hands this the last `TAIL_LINES` lines already pulled out
 * of the live xterm buffer (already ANSI-free, per the design spec).
 *
 * Two mutually exclusive screen shapes, checked in this order:
 *
 *  - **input box** — claude is idle at its ink `round`-border textarea,
 *    with a question (or an inline numbered/bulleted list) sitting in the
 *    transcript just above it. This is the common case: a normal chat turn
 *    that ended by asking something.
 *  - **selector** — an AskUserQuestion widget or the trust-folder prompt.
 *    Chrome facts verified 2026-08-01 against the claude CLI binary
 *    (2.1.220) and a live pseudo-tty capture: these screens render with
 *    **no input box at all** — just numbered options with a `❯` cursor and
 *    an `Enter to confirm` footer. That absence is exactly why `kind` is
 *    part of the result: typed text + Enter on a selector screen would
 *    blind-confirm whatever option is currently highlighted, so the card UI
 *    (Task 7) renders selector cards with no send affordance at all.
 *
 * Because the two shapes are mutually exclusive on a real screen (claude
 * never draws both at once), finding a structurally valid input box is
 * conclusive on its own: it means "not a selector screen", full stop. So
 * the selector check only ever runs when the box trio (bottom border / top
 * border / prompt row) was not found — never merely when the box's content
 * failed the question check (see `extractQuestion`). This is also what
 * "the input box wins" (spec) reduces to: there is no separate tiebreak
 * branch, because the two checks already run in a strict either/or order.
 */

export interface Extraction {
  kind: 'input' | 'selector'
  question: string
}

/** How many trailing buffer lines callers should read before calling extractQuestion. */
export const TAIL_LINES = 60

// ---------------------------------------------------------------------------
// Regex constants. Each one names the exact real-screen artifact it matches;
// see the module doc above for how/when these facts were verified.
// ---------------------------------------------------------------------------

/**
 * The input area renders in one of two shapes, and a live pane shows
 * whichever one claude picked at startup:
 *
 *  - **bordered** — ink's `round` box: `╭─` top edge, a `│ >` prompt row,
 *    `╰─` bottom edge. This is what the original pseudo-tty capture showed
 *    (claude 2.1.220, 2026-08-01).
 *  - **borderless** — a plain horizontal rule, a `❯` prompt row, another
 *    rule. This is what the same binary draws inside a real SeaShell pane
 *    (verified against live pixels 2026-08-01; SeaShell strips COLORTERM
 *    from pane env, and claude's chrome comes out reduced). The original
 *    trio could never match this, which is why the detector lane and the
 *    card send-gate read every real claude pane as "no input box".
 *
 * Each edge/row regex below therefore accepts either form.
 */

/** Bordered top edge (`╭` + rule), or a bare full-width rule line. The rule
 *  alternative demands 10+ `─` so an in-message dash run can't fake an edge. */
const BOX_TOP_RE = /^\s*(╭─|─{10,}\s*$)/

/** Bordered bottom edge (`╰` + rule), or the same bare-rule alternative —
 *  searched first, from the pane's bottom, since it is the edge closest to
 *  "now". */
const BOX_BOTTOM_RE = /^\s*(╰─|─{10,}\s*$)/

/**
 * The input row between the edges: `│ >` in the bordered form, `❯` in the
 * borderless one. The `❯` alternative must NOT match a selector option row
 * (`❯ 1. Yes…`) — typed text + Enter on a selector would blind-confirm the
 * highlighted option, which is the exact hazard the `kind` split exists to
 * prevent — so it rejects a `❯` that is immediately followed by an
 * option-number shape. Requiring this row between the two edges is what
 * keeps the trio the "claude is idle at its input" signature, and per the
 * spec amendment it doubles as the claude-pane check with no process-name
 * gate needed.
 */
const PROMPT_ROW_RE = /^\s*(│\s*>|❯(?!\s*\d+[.)]\s))/

/** claude's idle-footer hint, printed only while sitting at the input box
 *  (verified literal, 2026-08-01, claude 2.1.220). */
const SHORTCUTS_FOOTER_RE = /\? for shortcuts/

/** The auto-accept / plan-mode toggle row uses this glyph as its marker
 *  (named explicitly in the heuristic's noise-line list). Any tail line
 *  carrying it is footer chrome, never transcript text. */
const MODE_INDICATOR_RE = /⏵/

/**
 * A bare horizontal-rule line — the borderless input area frames its prompt
 * row with these (when they land in the text buffer as characters at all;
 * a styled-blank rule reads as an empty line and the blank-skipping in
 * `collectMessageBlock` already covers that case). 10+ `─` so a short
 * in-message dash run can't be mistaken for chrome.
 */
const RULE_LINE_RE = /^\s*─{10,}\s*$/

/**
 * A slash-command echo (`❯ /clear`) — claude prints submitted slash
 * commands with a `❯` prefix, and without this entry such an echo sitting
 * in the collected block matches `OPTIONS_MARK_RE`'s `❯` alternative and
 * turns a command echo into a phantom "question" (observed live
 * 2026-08-02: a card whose question was literally `❯ /clear`).
 */
const SLASH_ECHO_RE = /^\s*❯\s*\//

/**
 * Chrome glyphs only a claude pane draws: `⏺` transcript bullets, `✳`/`✻`
 * timing-and-spinner lines, `⏵` mode rows. The borderless prompt signature
 * below requires one of these somewhere in the tail, because a bare `❯` is
 * also what shell themes like starship use as their prompt — without this
 * fingerprint an idle shell whose scrollback contains a `?` would card.
 */
const CLAUDE_CHROME_RE = /^\s*[⏺✳✻⏵]/

/**
 * Covers the heuristic's "token/esc status" noise category: claude's
 * busy-turn animation reads "<n> tokens · esc to interrupt" (confirmed
 * elsewhere in this repo — see
 * docs/superpowers/specs/2026-07-31-seashell-design.md:1050, "Claude
 * Code's `esc to interrupt` animation"). Matched on the "esc to <word>"
 * shape rather than that exact phrase because the same category also has
 * to catch a selector screen's own footer leaking one line above a redraw
 * boundary (`Enter to confirm · Esc to cancel`, capital E) — both are hint
 * chrome naming the escape key's effect, never message prose. Anchored to
 * "esc to" specifically (not a bare "esc") so a real message that happens
 * to say e.g. "the esc-key binding" is never mistaken for this chrome.
 */
const BUSY_STATUS_RE = /\besc to \w+/i

/**
 * claude's end-of-turn timing line ("✳ Baked for 45s", verb varies) sits
 * between the transcript and the input box with blank lines on both sides.
 * Without this entry it becomes the entire collected block — the blank above
 * it stops the walk before the real message ever gets collected — so a turn
 * that ends in a question never cards (found live 2026-08-01 while staging
 * the README hero shot). Anchored to the leading glyph — and it is a glyph
 * FAMILY, not one character: the timing line keeps whatever glyph claude's
 * spinner settled on (`✻ Worked for 6s` verified in a live buffer dump
 * 2026-08-02, `✳ Baked for 45s` in the original report; ✽/✢/∗/· complete
 * the spinner set). ✳ and ✻ are pixel-identical at pane font sizes, which
 * is how the single-glyph version of this regex survived a night of
 * screenshot debugging. Message prose never begins a line with any of them.
 */
const TURN_TIMING_RE = /^\s*[✳✻✽✢∗·]/

/**
 * Numbered (`1.`/`1)`), bullet (`❯`/`◯`), or checkbox (`- [ ]`) list rows.
 * Used only as the step-4 fallback: a plain in-transcript list of choices
 * (no literal "?") still counts as a question. Deliberately broader than
 * `SELECTOR_OPTION_RE` — this is prose formatting, not one specific ink
 * widget's exact render shape.
 */
const OPTIONS_MARK_RE = /^\s*(\d+[.)]|❯|◯|- \[ \])\s/

/** A selector-widget option row: optional `❯` cursor, then `N.` / `N)`
 *  (the exact shape ink renders for AskUserQuestion / trust-folder
 *  choices — see the SELECTOR fixture in the test file). */
const SELECTOR_OPTION_RE = /^\s*❯?\s*\d+[.)]\s/

/** Selector screens' confirm hint (verified literal via the real captured
 *  trust-folder fixture: `Enter to confirm · Esc to cancel`). */
const ENTER_TO_CONFIRM_RE = /Enter to confirm/

// ---------------------------------------------------------------------------
// Tunables — every magic number the heuristic uses, named once.
// ---------------------------------------------------------------------------

/** Step 1: how many non-empty lines from the pane's bottom to search for the box's bottom border. */
const BOX_BOTTOM_SEARCH_WINDOW = 8
/** Step 2: how far above the bottom border to look for its matching top border. */
const BOX_TOP_WALK_WINDOW = 8
/** Step 3: hard cap on the collected message block (a huge pasted blob can't make this unbounded). */
const MESSAGE_BLOCK_MAX_LINES = 40
/** Step 5: only the lines closest to the box/footer end up in the question text. */
const QUESTION_TAIL_MAX_LINES = 6
/** Step 5: final question string cap, kept to one collapsed line. */
const QUESTION_MAX_CHARS = 500
/** Selector: how many non-empty lines from the bottom to search for the footer + its options. */
const SELECTOR_SEARCH_WINDOW = 15
/** Selector: only the first N option lines are quoted in the question. */
const SELECTOR_OPTION_MAX_LINES = 4

/**
 * Looks for claude's input-box or selector chrome in a pane's tail lines
 * and, if found, extracts the question it is implicitly or explicitly
 * asking. Returns null when the tail is neither (including: a box exists
 * but nothing above it reads as a question — see `blockLooksLikeQuestion`).
 */
export function extractQuestion(lines: string[]): Extraction | null {
  const boxTopIndex = findInputBoxTop(lines) ?? findBarePromptRow(lines)
  if (boxTopIndex !== null) {
    const block = collectMessageBlock(lines, boxTopIndex)
    return blockLooksLikeQuestion(block) ? { kind: 'input', question: buildQuestion(block) } : null
  }
  return trySelector(lines)
}

// ---------------------------------------------------------------------------
// Shared string helpers
// ---------------------------------------------------------------------------

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

/** Collapses any run of whitespace — including the single spaces `join(' ')` inserts between lines
 *  below — down to one space, and trims the ends. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function capChars(text: string): string {
  const collapsed = collapseWhitespace(text)
  return collapsed.length > QUESTION_MAX_CHARS ? collapsed.slice(0, QUESTION_MAX_CHARS) : collapsed
}

function tailLines(block: string[], max: number): string[] {
  return block.slice(Math.max(0, block.length - max))
}

/** Step 5 (and the selector equivalent): last ≤N lines, joined, collapsed, capped. */
function buildQuestion(block: string[]): string {
  return capChars(tailLines(block, QUESTION_TAIL_MAX_LINES).join(' '))
}

// ---------------------------------------------------------------------------
// Input-box signature
// ---------------------------------------------------------------------------

/** Step 1: the bottommost box-bottom-border line within the last
 *  `BOX_BOTTOM_SEARCH_WINDOW` non-empty lines, or null if none matches. */
function findBoxBottom(lines: string[]): number | null {
  let nonEmptySeen = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || isBlank(line)) continue
    if (nonEmptySeen >= BOX_BOTTOM_SEARCH_WINDOW) return null // window exhausted, no match
    nonEmptySeen++
    if (BOX_BOTTOM_RE.test(line)) return i
  }
  return null
}

/**
 * Steps 1+2: the input box's top-border index, only once the full trio
 * (bottom border, a `│ >` prompt row, top border — in that walking-up
 * order) is confirmed. Returns null if there is no box, or a bordered
 * block that isn't the input box (no prompt row seen before its top edge).
 */
function findInputBoxTop(lines: string[]): number | null {
  const bottomIndex = findBoxBottom(lines)
  if (bottomIndex === null) return null

  let sawPromptRow = false
  const walkFloor = Math.max(0, bottomIndex - BOX_TOP_WALK_WINDOW)
  for (let j = bottomIndex - 1; j >= walkFloor; j--) {
    const line = lines[j]
    if (line === undefined) continue
    if (PROMPT_ROW_RE.test(line)) sawPromptRow = true
    if (BOX_TOP_RE.test(line)) return sawPromptRow ? j : null
  }
  return null
}

/**
 * Borderless fallback, tried only when the edge trio found nothing: the
 * bottommost `❯` input row (never a `❯ N.` selector option, never a slash
 * echo) within the last `BOX_BOTTOM_SEARCH_WINDOW` non-empty lines. The
 * rules that frame this row may not exist in the text buffer at all — a
 * styled-blank rule translates to an empty string — so nothing about them
 * is required. What IS required is a claude chrome glyph somewhere above,
 * because `❯` alone is also a common shell-theme prompt (see
 * `CLAUDE_CHROME_RE`). Returns the row's index so the block walk starts
 * just above it, exactly as it would from a real box top.
 */
function findBarePromptRow(lines: string[]): number | null {
  let nonEmptySeen = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || isBlank(line)) continue
    if (nonEmptySeen >= BOX_BOTTOM_SEARCH_WINDOW) return null
    nonEmptySeen++
    if (SLASH_ECHO_RE.test(line)) continue
    if (/^\s*❯(?!\s*\d+[.)]\s)/.test(line)) {
      return lines.slice(0, i).some((l) => l !== undefined && CLAUDE_CHROME_RE.test(l)) ? i : null
    }
  }
  return null
}

/**
 * Step 3: walks up from just above the box's top border, skipping noise
 * lines and leading blanks, collecting real content until the first blank
 * after real content, the `MESSAGE_BLOCK_MAX_LINES` cap, or the start of
 * `lines` — whichever comes first. Returned in top-to-bottom order.
 */
function collectMessageBlock(lines: string[], boxTopIndex: number): string[] {
  const block: string[] = []
  for (let i = boxTopIndex - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined) continue

    if (isBlank(line)) {
      if (block.length > 0) break // first blank after real content: stop
      continue // leading blank before any real content: not a stop
    }
    if (
      SHORTCUTS_FOOTER_RE.test(line) ||
      MODE_INDICATOR_RE.test(line) ||
      BUSY_STATUS_RE.test(line) ||
      TURN_TIMING_RE.test(line) ||
      RULE_LINE_RE.test(line) ||
      SLASH_ECHO_RE.test(line)
    ) {
      continue // noise: excluded from the block, walk keeps going
    }

    block.unshift(line)
    if (block.length >= MESSAGE_BLOCK_MAX_LINES) break
  }
  return block
}

/** Step 4: the block only counts as a question if some line has a literal
 *  '?', or looks like an inline options list. */
function blockLooksLikeQuestion(block: string[]): boolean {
  return block.some((line) => line.includes('?') || OPTIONS_MARK_RE.test(line))
}

// ---------------------------------------------------------------------------
// Selector signature (checked only when findInputBoxTop found nothing)
// ---------------------------------------------------------------------------

interface SelectorOption {
  index: number
  text: string
}

/** Index of the earliest line that falls within the last `maxNonEmpty`
 *  non-empty lines of `lines` (0 if the buffer has fewer than that many). */
function tailNonEmptyWindowStart(lines: string[], maxNonEmpty: number): number {
  let nonEmptySeen = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || isBlank(line)) continue
    nonEmptySeen++
    if (nonEmptySeen >= maxNonEmpty) return i
  }
  return 0
}

/** The bottommost line containing `Enter to confirm`, searched no further
 *  back than `windowStart`. */
function findSelectorFooter(lines: string[], windowStart: number): number | null {
  for (let i = lines.length - 1; i >= windowStart; i--) {
    const line = lines[i]
    if (line !== undefined && ENTER_TO_CONFIRM_RE.test(line)) return i
  }
  return null
}

/** Every option-shaped line between `windowStart` and `footerIndex`, in
 *  top-to-bottom order. */
function collectSelectorOptions(lines: string[], windowStart: number, footerIndex: number): SelectorOption[] {
  const options: SelectorOption[] = []
  for (let i = windowStart; i < footerIndex; i++) {
    const line = lines[i]
    if (line !== undefined && SELECTOR_OPTION_RE.test(line)) options.push({ index: i, text: line })
  }
  return options
}

/** The contiguous non-option block directly above the first option line:
 *  walks up until a blank, another option-shaped line, the start of
 *  `lines`, or the shared block cap. Returned in top-to-bottom order. */
function collectSelectorPreamble(lines: string[], firstOptionIndex: number): string[] {
  const block: string[] = []
  for (let i = firstOptionIndex - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined) continue
    if (isBlank(line) || SELECTOR_OPTION_RE.test(line)) break // contiguity ends here
    block.unshift(line)
    if (block.length >= MESSAGE_BLOCK_MAX_LINES) break
  }
  return block
}

function trySelector(lines: string[]): Extraction | null {
  const windowStart = tailNonEmptyWindowStart(lines, SELECTOR_SEARCH_WINDOW)

  const footerIndex = findSelectorFooter(lines, windowStart)
  if (footerIndex === null) return null

  const options = collectSelectorOptions(lines, windowStart, footerIndex)
  const [firstOption] = options
  if (!firstOption) return null
  if (!options.some((o) => o.text.includes('❯'))) return null

  const preamble = tailLines(collectSelectorPreamble(lines, firstOption.index), QUESTION_TAIL_MAX_LINES)
  const optionText = options
    .slice(0, SELECTOR_OPTION_MAX_LINES)
    .map((o) => o.text.replaceAll('❯', '').trim())
    .join(' / ')

  return { kind: 'selector', question: capChars(`${preamble.join(' ')} — options: ${optionText}`) }
}
