/**
 * Turns a terminal's OSC 0/2 title into a pane label.
 *
 * Programs announce what they are doing by setting the window title, and that
 * is far more useful on a pane than the process name. Claude Code publishes its
 * session summary this way, so a wall of six panes all badged `claude` becomes
 * six panes that say which piece of work each one is. `npm run dev`, `ssh`,
 * `vim` and `git` do the same thing for free.
 *
 * The badge still shows the process name, so nothing is lost: the badge says
 * *what* is running, the label says *what it is doing*.
 */

/** Long enough for a real summary, bounded so a hostile title cannot bloat state. */
const MAX_TITLE = 80

/**
 * Shells commonly set `user@host: ~/dir`, which is noise next to a label that
 * already defaults to the directory name.
 */
const USER_HOST_PREFIX = /^[^\s@]+@[^\s:]+:\s*/

export function cleanPaneTitle(raw: string): string | null {
  if (typeof raw !== 'string') return null

  // Escape sequences first, then any control characters left over. Order
  // matters: stripping the lone ESC out of a colour sequence would leave its
  // parameters behind as literal text, so ESC[31m becomes "[31m" rather than
  // nothing. A title is attacker-influenced — any program, including one
  // running over ssh in someone else's repo, sets it to whatever it likes.
  // eslint-disable-next-line no-control-regex
  let title = raw.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
  // eslint-disable-next-line no-control-regex
  title = title.replace(/\u001b[@-_][0-9;?]*[ -\/]*[@-~]?/g, '')
  // eslint-disable-next-line no-control-regex
  title = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  title = title.replace(USER_HOST_PREFIX, '')
  title = title.replace(/\s+/g, ' ').trim()

  if (title === '') return null

  // A title that is just the working directory duplicates what the label
  // already derives from cwd, so show it the same way the default does.
  if (title.startsWith('/') || title.startsWith('~')) {
    const base = title.split('/').filter(Boolean).pop()
    title = title === '~' ? '~' : (base ?? title)
  }

  return title.slice(0, MAX_TITLE)
}
