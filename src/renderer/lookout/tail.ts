import { terminals } from '../panes/PaneView.js'
import { TAIL_LINES } from './extract.js'

/**
 * Reads the last `TAIL_LINES` lines of a pane's live xterm buffer, already
 * ANSI-free (same as `Terminal#buffer.active` gives everywhere else in this
 * codebase). Shared by the Task 6 detection effect and Task 7's `screenMode`
 * callback in app.tsx — both need the identical read before handing lines to
 * `extractQuestion`; only what each caller does with the result differs.
 *
 * Returns null when the pane has no mounted terminal — a preview pane, or a
 * paneId that no longer exists. Callers treat that the same as "no signal".
 */
export function readPaneTail(paneId: string): string[] | null {
  const term = terminals.get(paneId)?.term
  if (!term) return null
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = Math.max(0, buf.length - TAIL_LINES); i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  }
  return lines
}
