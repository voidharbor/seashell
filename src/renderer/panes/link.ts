/**
 * [pure] — what SeaShell types into a pane when it joins a link.
 *
 * Linking cannot merge two agents' contexts. Claude Code owns its own
 * conversation and SeaShell only has the pty underneath it, so the honest
 * version is a file both sessions can read and write, and one briefing each
 * telling them it exists. The sharing is then done by the agents, in writing.
 *
 * Kept pure and separate so the exact wording is testable, and because it is
 * text that gets typed into a live agent session: it has to be impossible for
 * a path or an id to smuggle a control character or a newline into that write.
 */

/** Mirrors the control socket's rule: nothing that could be a key press. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export interface LinkBriefing {
  /** The text to type. Never contains a newline; the caller sends the Enter. */
  text: string
}

/**
 * The one-time briefing for a pane joining a link.
 *
 * Returns null when the path is not something safe to type — an empty path, or
 * one carrying a control character. Refusing is right: a briefing that half
 * typed itself into an agent's prompt would be worse than no link at all.
 */
export function linkBriefing(notesPath: string): LinkBriefing | null {
  const path = notesPath.trim()
  if (path === '' || CONTROL_CHARS.test(path)) return null

  const text =
    `You are now sharing notes with another SeaShell pane working alongside you. ` +
    `The shared file is ${path} — read it now, read it again before each task, ` +
    `and append a short dated entry whenever you make a decision, change a file, ` +
    `or break something the other session would need to know about. ` +
    `Do not rewrite entries you did not write.`

  return { text }
}

/**
 * Whether a pane is one this is safe to type a briefing into.
 *
 * The briefing is an English sentence. Typed into a shell it is not a comment,
 * it is a command line — `You` is not a program, and the pane fills with
 * errors. So it only ever goes to a pane whose foreground is actually an agent,
 * which the metrics sweep already reports for the title-bar badge.
 */
export function canBrief(foregroundProcess: string | undefined): boolean {
  return (foregroundProcess ?? '').toLowerCase().includes('claude')
}

/** A link id. Plain enough for main's filename check to accept it. */
export function newLinkId(mint: () => string): string {
  return mint().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'link'
}
