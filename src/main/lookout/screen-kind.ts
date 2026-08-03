/**
 * Main's own read of what a claude pane's screen is showing — 'input' (idle
 * at its input box), 'selector' (a picker where typed text + Enter, or even a
 * lone digit, confirms an option), or null (can't tell).
 *
 * [pure] — a raw pty output tail in, a verdict out. This is the main-process
 * counterpart of the renderer's extractQuestion (renderer/lookout/extract.ts):
 * that one reads xterm's rendered buffer, this one reads the raw stream main
 * already has, because at the moment an approve click lands the renderer's
 * buffer can lag the stream — main must not take the renderer's word for it.
 *
 * The two screen shapes never render together (see extract.ts's module doc),
 * and ink repaints the whole active widget on every render, so the signature
 * that appears LATEST in the stream names the current screen. Signatures are
 * kept in sync with extract.ts's constants by cross-reference, not by import:
 * that file matches emulator-rendered lines, this one matches ANSI-stripped
 * stream segments, and the two shapes are close but not the same.
 *
 * The verdict is used one way only: a positive 'selector' refuses a write.
 * 'input' and null both mean "no selector seen", so a misread here can only
 * block a send, never permit one the renderer would have blocked.
 */

/** How many ANSI-stripped stream segments above a confirm-footer to search
 *  for the selector's `❯ N.` cursor row. Mirrors extract.ts's
 *  SELECTOR_SEARCH_WINDOW. */
const CURSOR_OPTION_WINDOW = 15

/** How many trailing segments count as "the screen showing right now". ink
 *  repaints its whole widget, so the current frame is always at the bottom of
 *  the tail; a generous screen's worth keeps a real picker in scope while
 *  putting an answered one out of it. */
const CURRENT_SCREEN_SEGMENTS = 60

/** Input-box chrome: a border edge, the `│ >` prompt row, the idle footer, or
 *  the borderless `❯` prompt row — never a `❯ N.` option row, never a
 *  `❯ /cmd` slash echo (both also start with `❯`). */
const INPUT_ROW_RE = /^\s*(╭─|╰─|│\s*>)|\? for shortcuts|^\s*❯(?!\s*\d+[.)]\s)(?!\s*\/)/

/** A selector's confirm hint (`Enter to confirm · Esc to cancel`). */
const SELECTOR_FOOTER_RE = /Enter to confirm/

/** The selector's highlighted option row: `❯ 1. Yes, …`. */
const CURSOR_OPTION_RE = /^\s*❯\s*\d+[.)]\s/

/**
 * Strips ANSI escape sequences and stray control characters, keeping \r and
 * \n as segment breaks. Ordered so multi-byte sequences go before the
 * single-ESC fallback.
 */
function stripAnsi(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex -- stripping them is the point
      .replace(/\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g, '') // CSI
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC (BEL/ST, or cut at tail edge)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[()][0-9A-Za-z]/g, '') // charset selection
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '') // other ESC + single final
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  )
}

export function screenKindOf(rawTail: string): 'input' | 'selector' | null {
  const segments = stripAnsi(rawTail).split(/\r\n|\n|\r/)

  let lastInput = -1
  let lastSelector = -1
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === undefined) continue
    if (INPUT_ROW_RE.test(seg)) lastInput = i
    // A footer only counts with the cursor row nearby — a transcript line
    // merely quoting "Enter to confirm" has no `❯ N.` row above it.
    if (SELECTOR_FOOTER_RE.test(seg) && hasCursorOptionAbove(segments, i)) lastSelector = i
  }

  // A picker refuses a send, so the evidence for one has to be CURRENT. The
  // tail is a fixed byte budget of history (see TAIL_MAX_CHARS), which can hold
  // a picker the user answered a while ago; if the pane then goes quiet, no
  // newer input row arrives to outrank it and the stale frame refuses writes
  // into a pane that is plainly sitting at its input box. A picture of the
  // screen ends at the bottom of the tail, so selector evidence further back
  // than a screen's worth of lines is history, not what is showing.
  if (lastSelector !== -1 && segments.length - lastSelector > CURRENT_SCREEN_SEGMENTS) {
    lastSelector = -1
  }

  if (lastInput === -1 && lastSelector === -1) return null
  return lastSelector > lastInput ? 'selector' : 'input'
}

function hasCursorOptionAbove(segments: string[], footerIndex: number): boolean {
  const floor = Math.max(0, footerIndex - CURSOR_OPTION_WINDOW)
  for (let i = footerIndex - 1; i >= floor; i--) {
    const seg = segments[i]
    if (seg !== undefined && CURSOR_OPTION_RE.test(seg)) return true
  }
  return false
}
