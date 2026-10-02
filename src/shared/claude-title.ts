/**
 * Reading the session title out of a pane label. [pure]
 *
 * claude sets the terminal title to its session's title, prefixed with ✳ when
 * idle and a spinner frame while working, and a pane takes that as its label.
 * So a label like "✳ Session gamma" is an observation of which session
 * was on screen in that pane. Shared by main (matching it to a transcript) and
 * the renderer (deciding which panes to ask about at restore).
 */

const TITLE_GLYPHS = /^[\u2800-\u28ff✳✻✶✢✽✺·*◐◑◒◓]+\s+(.+)$/u

/** The session title a pane label carries, or null when the label is not a
 *  claude title at all. "Claude Code" is claude's placeholder before a
 *  session has a title of its own, and names nothing. */
export function claudeTitleFromLabel(label: string): string | null {
  const m = TITLE_GLYPHS.exec(label.trim())
  const title = m?.[1]?.trim()
  if (!title || title === 'Claude Code') return null
  return title
}
