/**
 * The shared notes file two linked panes write to.
 *
 * Linking panes cannot merge two agents' contexts — Claude Code owns its own
 * conversation and SeaShell only has the pty underneath it. What it can do is
 * give both sessions one file and tell each about it, so the sharing is done by
 * the agents, in writing, rather than faked by relaying text between them. Two
 * sessions on the same project keep each other current by reading it before a
 * task and appending after one.
 *
 * The file lives in userData rather than in the user's project. A link is a
 * property of this window, not of a repository, and dropping a stray markdown
 * file into someone's working tree — where it would be picked up by git status,
 * by a build, or by the agents themselves as source — is not a thing to do
 * behind their back.
 */

import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** Ids come from the renderer, so they never reach the filesystem unchecked. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function linksDir(): string {
  return path.join(app.getPath('userData'), 'links')
}

export function notesPathFor(linkId: string): string | null {
  if (!ID_RE.test(linkId)) return null
  return path.join(linksDir(), `${linkId}.md`)
}

const HEADER = (linkId: string): string =>
  `# Shared notes

Two or more SeaShell panes are linked to this file. Each is a separate agent
session with its own context; this file is the only thing they share.

Read it before starting a task, and append what another session working on the
same code would need to know: decisions made, files touched, anything now
broken. Keep entries short and dated. Do not rewrite another session's entry.

Link: ${linkId}

---
`

/**
 * Creates the notes file if it is not already there and returns its path.
 *
 * Never truncates an existing file: a second pane joining a link, or the same
 * pane being re-linked after a restart, must land on the notes that are already
 * there rather than wiping the other session's work.
 */
export async function ensureNotes(linkId: string): Promise<string | null> {
  const file = notesPathFor(linkId)
  if (!file) return null
  await fsp.mkdir(linksDir(), { recursive: true })
  try {
    // Exclusive create: succeeds only when the file did not exist, so two panes
    // linking at once cannot race into one truncating the other.
    const fh = await fsp.open(file, 'wx')
    try {
      await fh.writeFile(HEADER(linkId), 'utf8')
    } finally {
      await fh.close()
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
  }
  return file
}
