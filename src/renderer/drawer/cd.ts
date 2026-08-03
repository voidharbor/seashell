/**
 * The one command the drawer ever composes on the user's behalf: `cd` to the
 * focused pane's directory, typed visibly into the drawer's shell with a
 * trailing Enter — the same show-the-command discipline as a restored pane's
 * `claude -r <id>`.
 *
 * The path comes from the pane's own shell via OSC 7 (or its spawn cwd), which
 * is program-influenced text, not trusted input. Single quotes make every
 * shell metacharacter inert; embedded single quotes are closed-escaped-reopened
 * (`'\''`); and any control character refuses the whole command, because a \r
 * or \n inside a "directory name" would submit early and execute whatever
 * followed it. Refusal returns null — the button silently does nothing rather
 * than typing something almost right.
 *
 * [pure] — exported for tests.
 */

// eslint-disable-next-line no-control-regex -- refusing them is the point
const CONTROL_RE = /[\x00-\x1f\x7f]/

const MAX_PATH = 4096

export function cdCommandFor(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH) return null
  if (CONTROL_RE.test(path)) return null
  return `cd '${path.replace(/'/g, "'\\''")}'`
}
