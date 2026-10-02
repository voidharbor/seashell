import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionIdsForPanes } from '../../src/main/state/session-lookup.js'

/** sessionIdsForPanes end to end over a fake ~/.claude: pid files on disk, a
 *  process table and start tokens injected, nothing real touched. */

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
let home: string
let savedHome: string | undefined

beforeEach(() => {
  savedHome = process.env.HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-home-'))
  process.env.HOME = home
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true })
})
afterEach(() => {
  process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})

function pidFile(pid: number, sid: string, procStart: string): void {
  fs.writeFileSync(
    path.join(home, '.claude', 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId: sid, procStart, kind: 'interactive', startedAt: 1 })
  )
}

const deps = (shells: Record<string, number>, children: Record<number, number[]>, tokens: Record<number, string>) => ({
  shellPidOf: (paneId: string) => shells[paneId] ?? null,
  processChildren: async () => new Map(Object.entries(children).map(([k, v]) => [Number(k), v])),
  startTokens: async (pids: number[]) =>
    new Map(pids.filter((p) => tokens[p] !== undefined).map((p) => [p, tokens[p]!])),
})

describe('sessionIdsForPanes', () => {
  it('resolves a live pane from the claude pid file under its shell', async () => {
    pidFile(685, S1, '2954')
    const out = await sessionIdsForPanes(
      [{ paneId: 'p1', cwd: '/nowhere' }],
      deps({ p1: 620 }, { 620: [685] }, { 685: '2954' })
    )
    expect(out).toEqual({ ids: { p1: S1 }, sources: { p1: 'process' } })
  })

  it('treats a session held by a pane being replaced as free, so reopening a project resumes it', async () => {
    pidFile(685, S1, '2954')
    pidFile(700, S2, '3000')
    const out = await sessionIdsForPanes(
      [
        { paneId: 'new1', cwd: '/nowhere', knownSid: S1, knownVerified: true },
        { paneId: 'new2', cwd: '/nowhere', knownSid: S2, knownVerified: true },
      ],
      deps({ old1: 620 }, { 620: [685] }, { 685: '2954', 700: '3000' }),
      ['old1']
    )
    // S1 is only live in the pane about to be killed; S2 is live elsewhere.
    expect(out.ids).toEqual({ new1: S1 })
  })

  it('does not free a session that is also live outside the panes being replaced', async () => {
    pidFile(685, S1, '2954')
    pidFile(900, S1, '4000') // the same session open in another terminal
    const out = await sessionIdsForPanes(
      [{ paneId: 'new1', cwd: '/nowhere', knownSid: S1, knownVerified: true }],
      deps({ old1: 620 }, { 620: [685] }, { 685: '2954', 900: '4000' }),
      ['old1']
    )
    expect(out.ids).toEqual({})
  })
})
