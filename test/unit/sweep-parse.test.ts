import { describe, expect, it } from 'vitest'
import { parsePsOutput, sumSubtreeRss, type ProcessTree } from '../../src/main/monitor/sweep-parse.js'

/**
 * Realistic multi-line fixture modeled on `ps -axo pid,ppid,rss,pcpu,stat,comm`:
 *   1 (launchd)
 *   └─ 500 (login shell, the pane root)
 *      ├─ 501 (claude, the agent CLI)
 *      │  └─ 502 (a ripgrep child claude spawned)
 *      └─ 503 (an app with a spaced comm path)
 *   777 an unrelated top-level process (not part of pane 500's subtree)
 */
const FIXTURE = `  PID  PPID    RSS  %CPU STAT COMM
    1     0   3344   0.0 Ss   /sbin/launchd
  500     1  12345   0.1 Ss   /bin/zsh
  501   500 466944   4.2 S+   /Users/josh/.claude/claude
  502   501   2048   0.5 S+   rg
  503   500   8192   0.3 S+   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  777     1   1024   0.0 S    somethingelse
`

describe('parsePsOutput', () => {
  it('skips the header row and parses numeric fields', () => {
    const tree = parsePsOutput(FIXTURE)
    expect(tree.rows.size).toBe(6)
    expect(tree.rows.has(0)).toBe(false) // "PID" header never parses as a number
  })

  it('parses a comm field containing spaces (app bundle path)', () => {
    const tree = parsePsOutput(FIXTURE)
    const row = tree.rows.get(503)
    expect(row).toBeDefined()
    expect(row?.comm).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  it('parses pid/ppid/rss/pcpu/stat correctly', () => {
    const tree = parsePsOutput(FIXTURE)
    const row = tree.rows.get(501)
    expect(row).toEqual({
      pid: 501,
      ppid: 500,
      rssKb: 466944,
      pcpu: 4.2,
      stat: 'S+',
      comm: '/Users/josh/.claude/claude',
    })
  })

  it('builds a ppid -> children index', () => {
    const tree = parsePsOutput(FIXTURE)
    expect(tree.childrenOf.get(500)?.sort((a, b) => a - b)).toEqual([501, 503])
    expect(tree.childrenOf.get(501)).toEqual([502])
  })

  it('ignores blank lines and malformed rows without throwing', () => {
    const withGarbage = `${FIXTURE}\n\n   garbage line with no numbers\n500 bogus\n`
    expect(() => parsePsOutput(withGarbage)).not.toThrow()
    const tree = parsePsOutput(withGarbage)
    expect(tree.rows.size).toBe(6)
  })
})

describe('sumSubtreeRss', () => {
  it('sums RSS over a multi-generation subtree rooted at the pane shell', () => {
    const tree = parsePsOutput(FIXTURE)
    const result = sumSubtreeRss(tree, 500)
    expect(result.rootMissing).toBe(false)
    expect(result.pids.sort((a, b) => a - b)).toEqual([500, 501, 502, 503])
    expect(result.rssSumKb).toBe(12345 + 466944 + 2048 + 8192)
  })

  it('does not include unrelated top-level processes', () => {
    const tree = parsePsOutput(FIXTURE)
    const result = sumSubtreeRss(tree, 500)
    expect(result.pids).not.toContain(777)
  })

  it('reports rootMissing and an empty sum for a pid absent from the sweep', () => {
    const tree = parsePsOutput(FIXTURE)
    const result = sumSubtreeRss(tree, 999999)
    expect(result.rootMissing).toBe(true)
    expect(result.pids).toEqual([])
    expect(result.rssSumKb).toBe(0)
  })

  it('skips a child pid that vanished mid-sweep (recorded in childrenOf, no row of its own)', () => {
    const tree = parsePsOutput(FIXTURE)
    // Simulate a pid that was observed as someone's child (e.g. via an
    // earlier /proc-style read) but had already exited by the time its own
    // row would have been sampled — its row is absent from `rows`.
    tree.childrenOf.set(500, [...(tree.childrenOf.get(500) ?? []), 9999])

    const result = sumSubtreeRss(tree, 500)
    expect(result.pids).not.toContain(9999)
    // The sum is unaffected by the vanished pid — it contributes 0, not NaN.
    expect(result.rssSumKb).toBe(12345 + 466944 + 2048 + 8192)
    expect(Number.isFinite(result.rssSumKb)).toBe(true)
  })

  it('terminates and counts each pid once on a cyclic parent/child fixture', () => {
    // pid 10's ppid is 20 and pid 20's ppid is 10 — cannot happen in a real
    // kernel process tree, but the walk must defend against it anyway.
    const cyclic = `  PID  PPID    RSS  %CPU STAT COMM
   10    20   1000   0.0 S    a
   20    10   2000   0.0 S    b
`
    const tree = parsePsOutput(cyclic)
    const result = sumSubtreeRss(tree, 10)
    expect(result.pids.sort((a, b) => a - b)).toEqual([10, 20])
    expect(result.rssSumKb).toBe(3000)
  })

  it('handles a self-referential ppid (pid is its own parent) without looping', () => {
    const selfLoop = `  PID  PPID    RSS  %CPU STAT COMM
   42    42   5000   0.0 S    weird
`
    const tree: ProcessTree = parsePsOutput(selfLoop)
    const result = sumSubtreeRss(tree, 42)
    expect(result.pids).toEqual([42])
    expect(result.rssSumKb).toBe(5000)
  })

  it('excludes a reparented orphan whose ppid no longer resolves to a live row', () => {
    // pid 601 claims ppid 500 is gone (it was reparented to pid 1 already,
    // per the spec's launchd-adoption scenario) — its row is simply not part
    // of any subtree rooted below the original parent because ppid tracking
    // reflects current, not historical, parentage.
    const withOrphan = `${FIXTURE}  601     1   4096   0.0 S    (sleep 601 &)\n`
    const tree = parsePsOutput(withOrphan)
    const result = sumSubtreeRss(tree, 500)
    expect(result.pids).not.toContain(601)
  })
})
