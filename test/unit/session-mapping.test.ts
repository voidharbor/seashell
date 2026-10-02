import { describe, expect, it } from 'vitest'
import {
  claudeTitleFromLabel,
  liveSessionsFromPidFiles,
  pickFallbackSessionIds,
  pickProcessSessionIds,
  parsePsLstart,
  procStartFromStat,
  resolveSessionIds,
  type LookupPane,
  transcriptDirFor,
  type SessionFile,
} from '../../src/main/state/session-lookup.js'
import os from 'node:os'
import path from 'node:path'

/**
 * Built from a real layout seen on 9/28: ~20 claude panes, every one of them in
 * /Users/joshwald, a session registry that resolved almost nothing. The old
 * fallback handed "newest transcript for this cwd" out in pane order, which put
 * "Session alpha" in the pane labelled "Phone web app"
 * and "Session gamma" in the trading-bot pane.
 */

const HOME = '/Users/joshwald'
const sid = (n: number): string => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`

describe('the cwd fallback never plays a recency lottery', () => {
  it('assigns nothing when several unresolved panes share one cwd', () => {
    const panes = Array.from({ length: 20 }, (_, i) => ({ paneId: `pane-${i}`, cwd: HOME }))
    const transcripts: SessionFile[] = Array.from({ length: 40 }, (_, i) => ({
      sid: sid(i + 1),
      mtimeMs: 1000 + i,
    }))
    const out = pickFallbackSessionIds(panes, {}, () => transcripts)
    expect(out).toEqual({})
  })

  it('still resolves the one pane that is alone in its cwd', () => {
    const out = pickFallbackSessionIds(
      [
        { paneId: 'a', cwd: HOME },
        { paneId: 'b', cwd: HOME },
        { paneId: 'c', cwd: '/work' },
      ],
      {},
      (cwd) => (cwd === '/work' ? [{ sid: sid(7), mtimeMs: 5 }] : [{ sid: sid(1), mtimeMs: 9 }])
    )
    expect(out).toEqual({ c: sid(7) })
  })

  it('counts panes the registry already resolved as settled, not as rivals', () => {
    const out = pickFallbackSessionIds(
      [
        { paneId: 'a', cwd: HOME },
        { paneId: 'b', cwd: HOME },
      ],
      { a: sid(1) },
      () => [
        { sid: sid(1), mtimeMs: 9 },
        { sid: sid(2), mtimeMs: 5 },
      ]
    )
    expect(out).toEqual({ b: sid(2) })
  })
})

describe('procStartFromStat', () => {
  it('reads field 22 of /proc/<pid>/stat, the way claude records procStart on Linux', () => {
    const stat =
      '685 (claude) S 620 685 620 34821 685 4194304 12 0 0 0 5 3 0 0 20 0 18 0 2954 1234 567 18446744073709551615'
    expect(procStartFromStat(stat)).toBe('2954')
  })

  it('survives a process name with spaces and parentheses in it', () => {
    const stat = '9 (npm exec (x) y) S 1 9 9 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 1 1'
    expect(procStartFromStat(stat)).toBe('777')
  })

  it('returns undefined for garbage', () => {
    expect(procStartFromStat('nonsense')).toBeUndefined()
  })
})

describe('parsePsLstart', () => {
  it('reads `ps -o pid=,lstart=` the way claude records procStart on macOS', () => {
    const out = parsePsLstart('  685 Mon Sep  1 01:02:03 2026\n32880 Tue Sep 29 02:03:04 2026\n')
    expect(out.get(685)).toBe('Mon Sep  1 01:02:03 2026')
    expect(out.get(32880)).toBe('Tue Sep 29 02:03:04 2026')
  })
})

describe('transcriptDirFor', () => {
  it('turns every non-alphanumeric character into a dash, as claude does', () => {
    expect(transcriptDirFor('/Users/j/Desktop/Acme Widgets LLC/.claude')).toBe(
      path.join(os.homedir(), '.claude', 'projects', '-Users-j-Desktop-Acme-Widgets-LLC--claude')
    )
  })
})

describe('liveSessionsFromPidFiles', () => {
  const file = (over: Record<string, unknown>) => ({
    pid: 685,
    sessionId: sid(1),
    procStart: '2954',
    kind: 'interactive',
    startedAt: 10,
    updatedAt: 20,
    ...over,
  })

  it('keeps a pid file whose process start still matches', () => {
    const out = liveSessionsFromPidFiles([file({})], new Map([[685, '2954']]))
    expect(out.get(685)).toMatchObject({ sid: sid(1), at: 10 })
  })

  it('dates a holder by when its process started, not by its last busy/idle flip', () => {
    // updatedAt moves with every status change, so it says who was active
    // last, not who took the session last.
    const out = liveSessionsFromPidFiles([file({ startedAt: 10, updatedAt: 999 })], new Map([[685, '2954']]))
    expect(out.get(685)!.at).toBe(10)
  })

  it('drops a stale pid file whose pid was reused by another process', () => {
    const out = liveSessionsFromPidFiles([file({})], new Map([[685, '99999']]))
    expect(out.size).toBe(0)
  })

  it('drops a pid file for a process that is gone', () => {
    const out = liveSessionsFromPidFiles([file({})], new Map())
    expect(out.size).toBe(0)
  })

  it('drops a pid file with no procStart, since nothing proves it is current', () => {
    const out = liveSessionsFromPidFiles([file({ procStart: undefined })], new Map([[685, '2954']]))
    expect(out.size).toBe(0)
  })

  it('refuses a session id that is not UUID-shaped', () => {
    const out = liveSessionsFromPidFiles(
      [file({ sessionId: 'x; rm -rf /' })],
      new Map([[685, '2954']])
    )
    expect(out.size).toBe(0)
  })
})

describe('pickProcessSessionIds', () => {
  // shell 620 -> claude 685 -> mcp helper 700 (which is itself a claude -p)
  const children = new Map<number, number[]>([
    [620, [685]],
    [685, [700]],
    [622, [691]],
  ])

  it('maps a pane to the claude session running under its shell', () => {
    const live = new Map([
      [685, { sid: sid(1), at: 1 }],
      [691, { sid: sid(2), at: 1 }],
    ])
    const out = pickProcessSessionIds(
      [
        { paneId: 'p1', shellPid: 620 },
        { paneId: 'p2', shellPid: 622 },
      ],
      children,
      live
    )
    expect(out).toEqual({ p1: sid(1), p2: sid(2) })
  })

  it('takes the shallowest claude, not a nested one it spawned', () => {
    const live = new Map([
      [685, { sid: sid(1), at: 1 }],
      [700, { sid: sid(9), at: 5 }],
    ])
    expect(pickProcessSessionIds([{ paneId: 'p1', shellPid: 620 }], children, live)).toEqual({
      p1: sid(1),
    })
  })

  it('gives nothing when two claudes sit at the same depth with different sessions', () => {
    const kids = new Map<number, number[]>([[620, [685, 686]]])
    const live = new Map([
      [685, { sid: sid(1), at: 1 }],
      [686, { sid: sid(2), at: 1 }],
    ])
    expect(pickProcessSessionIds([{ paneId: 'p1', shellPid: 620 }], kids, live)).toEqual({})
  })

  it('when one session is live in two panes, only the pane that switched to it last keeps it', () => {
    // pids 686 and 32880 were both on 25e15195 on the PC on 9/29.
    const kids = new Map<number, number[]>([
      [616, [686]],
      [638, [32880]],
    ])
    const live = new Map([
      [686, { sid: sid(5), at: 100 }],
      [32880, { sid: sid(5), at: 900 }],
    ])
    const out = pickProcessSessionIds(
      [
        { paneId: 'solar', shellPid: 616 },
        { paneId: 'build', shellPid: 638 },
      ],
      kids,
      live
    )
    expect(out).toEqual({ build: sid(5) })
  })

  it('ignores a pane with no shell pid yet', () => {
    expect(pickProcessSessionIds([{ paneId: 'p1', shellPid: null }], children, new Map())).toEqual({})
  })
})

describe('claudeTitleFromLabel', () => {
  it('reads the session title claude puts in the terminal title', () => {
    expect(claudeTitleFromLabel('✳ Session alpha')).toBe('Session alpha')
    expect(claudeTitleFromLabel('◐ Session alpha')).toBe('Session alpha')
    expect(claudeTitleFromLabel('⠂ Session delta')).toBe('Session delta')
  })

  it('is null for a label that is not a claude title', () => {
    expect(claudeTitleFromLabel('~')).toBeNull()
    expect(claudeTitleFromLabel('work')).toBeNull()
    expect(claudeTitleFromLabel('✳ ')).toBeNull()
    expect(claudeTitleFromLabel('✳ Claude Code')).toBeNull()
  })
})

describe('resolveSessionIds', () => {
  const base = {
    processIds: {} as Record<string, string>,
    registryIds: {} as Record<string, string>,
    liveSids: new Set<string>() as ReadonlySet<string>,
    listSessions: (): SessionFile[] => [],
    titlesOf: (): string[] => [],
    sidsTitled: (): string[] => [],
  }
  const pane = (paneId: string, over: Partial<LookupPane> = {}): LookupPane => ({
    paneId,
    cwd: HOME,
    ...over,
  })

  it('the process lane wins over everything and is reported as such', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('p1', { knownSid: sid(2) })],
      processIds: { p1: sid(1) },
      registryIds: { p1: sid(3) },
    })
    expect(out.ids).toEqual({ p1: sid(1) })
    expect(out.sources).toEqual({ p1: 'process' })
  })

  it('a registry id another pane is running is not handed out', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('p1'), pane('p2')],
      processIds: { p1: sid(1) },
      registryIds: { p2: sid(1) },
    })
    expect(out.ids).toEqual({ p1: sid(1) })
  })

  it('carries a known id forward when nothing better resolves the pane', () => {
    const out = resolveSessionIds({ ...base, panes: [pane('p1', { knownSid: sid(4) })] })
    expect(out.ids).toEqual({ p1: sid(4) })
    expect(out.sources).toEqual({ p1: 'carried' })
  })

  it('does not carry an id another pane is now running', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('p1', { knownSid: sid(4) }), pane('p2')],
      processIds: { p2: sid(4) },
      liveSids: new Set([sid(4)]),
    })
    expect(out.ids).toEqual({ p2: sid(4) })
  })

  it('does not carry an id that is live outside SeaShell (another terminal)', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('p1', { knownSid: sid(4) })],
      liveSids: new Set([sid(4)]),
    })
    expect(out.ids).toEqual({})
  })

  it('does not let two panes carry the same id', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('p1', { knownSid: sid(4) }), pane('p2', { knownSid: sid(4) })],
    })
    expect(out.ids).toEqual({})
  })

  it('never guesses by cwd for a pane that already had an id', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('p1', { knownSid: sid(4), knownVerified: false, label: '~' })],
      listSessions: () => [{ sid: sid(8), mtimeMs: 1 }],
    })
    expect(out.ids).toEqual({})
  })

  it('never guesses by cwd for a pane that is not running claude', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('p1', { claude: false })],
      listSessions: () => [{ sid: sid(8), mtimeMs: 1 }],
    })
    expect(out.ids).toEqual({})
  })

  it('a lone claude pane in its cwd still gets the newest free transcript', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('p1', { claude: true })],
      listSessions: () => [
        { sid: sid(8), mtimeMs: 9 },
        { sid: sid(7), mtimeMs: 1 },
      ],
      liveSids: new Set([sid(8)]),
    })
    expect(out.ids).toEqual({ p1: sid(7) })
    expect(out.sources).toEqual({ p1: 'cwd' })
  })

  it('a pane resolved another way is still a rival in the cwd lane', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('a', { claude: true }), pane('b', { claude: true })],
      processIds: { a: sid(1) },
      listSessions: () => [
        { sid: sid(1), mtimeMs: 9 },
        { sid: sid(2), mtimeMs: 5 },
      ],
    })
    expect(out.ids).toEqual({ a: sid(1) })
  })

  it('an id the lookup refused for one pane is never guessed into another', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('a', { knownSid: sid(3), knownVerified: false, label: '~' }), pane('b', { claude: true, cwd: '/w' })],
      listSessions: () => [{ sid: sid(3), mtimeMs: 9 }],
    })
    expect(out.ids).toEqual({})
  })

  it('a pane a verified save left without an id is not guessed at restore', () => {
    const out = resolveSessionIds({
      ...base,
      panes: [pane('a', { claude: true, knownVerified: true })],
      listSessions: () => [{ sid: sid(8), mtimeMs: 9 }],
    })
    expect(out.ids).toEqual({})
  })

  describe('repairing a snapshot written by an older build (ids unverified)', () => {
    const titles: Record<string, string> = {
      [sid(0xabda)]: 'Session alpha',
      [sid(0xad7e)]: 'Session beta',
      [sid(0xe565)]: 'Session gamma',
      [sid(0x25e1)]: 'GPU upgrade notes',
    }
    const titled = {
      titlesOf: (_cwd: string, s: string) => (titles[s] ? [titles[s]] : []),
      sidsTitled: (_cwd: string, t: string) =>
        Object.entries(titles)
          .filter(([, v]) => v === t)
          .map(([k]) => k),
    }

    it('keeps an unverified id whose transcript title matches the pane title', () => {
      const out = resolveSessionIds({
        ...base,
        ...titled,
        panes: [pane('p', { knownSid: sid(0xe565), knownVerified: false, label: '✳ Session gamma' })],
      })
      expect(out.ids).toEqual({ p: sid(0xe565) })
    })

    it('replaces a wrong id with the session the pane title names (the wrong-id case)', () => {
      const out = resolveSessionIds({
        ...base,
        ...titled,
        panes: [
          pane('p', {
            knownSid: sid(0xad7e),
            knownVerified: false,
            label: '✳ Session alpha',
          }),
        ],
      })
      expect(out.ids).toEqual({ p: sid(0xabda) })
      expect(out.sources).toEqual({ p: 'title' })
    })

    it('drops an unverified id it cannot confirm rather than resume a wrong one', () => {
      const out = resolveSessionIds({
        ...base,
        ...titled,
        panes: [pane('p', { knownSid: sid(0xad7e), knownVerified: false, label: '✳ Roof quote for 12 Elm St' })],
      })
      expect(out.ids).toEqual({})
    })

    it('refuses a title two panes share', () => {
      const out = resolveSessionIds({
        ...base,
        ...titled,
        panes: [
          pane('a', { label: '✳ Session gamma' }),
          pane('b', { label: '✳ Session gamma' }),
        ],
      })
      expect(out.ids).toEqual({})
    })

    it('refuses a title two transcripts share', () => {
      const out = resolveSessionIds({
        ...base,
        titlesOf: () => ['Same'],
        sidsTitled: () => [sid(1), sid(2)],
        panes: [pane('a', { label: '✳ Same' })],
      })
      expect(out.ids).toEqual({})
    })

    it('never resumes a titled session that is live somewhere else', () => {
      const out = resolveSessionIds({
        ...base,
        ...titled,
        panes: [pane('a', { label: '✳ GPU upgrade notes' })],
        liveSids: new Set([sid(0x25e1)]),
      })
      expect(out.ids).toEqual({})
    })
  })
})
