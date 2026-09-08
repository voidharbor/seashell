import { describe, expect, it } from 'vitest'
import {
  resolvePathClick,
  type PathHit,
  type ResolveDeps,
  type RowContext,
} from '../../src/renderer/links/resolve.js'

/**
 * The one resolver both a pane and the drawer call.
 *
 * Everything it does apart from the two injected round trips is pure, so the
 * whole decision table (which candidates are tried, which outcome wins, what a
 * miss says) is testable in bare node with two fakes.
 */

const NOWHERE = { results: [] as Array<{ i: number; resolved: string; kind: 'file' | 'dir' | 'other' }> }

function hitOf(path: string): PathHit {
  return { path, start: 0, end: path.length, absY: 1 }
}

/** A span that touches neither edge, so nothing is joined unless a test says so. */
const alone: RowContext = { prevRow: null, nextRow: null, startCol: 5, endCol: 13, cols: 80 }

interface Recorder {
  statCalls: Array<{ cwd: string; candidates: string[] }>
  findCalls: Array<{ root: string; suffix: string; limit: number }>
}

/** Recording wraps whatever the test supplied, rather than being one more
 *  default an override silently replaces. */
function deps(over: Partial<ResolveDeps> = {}): ResolveDeps & Recorder {
  const rec: Recorder = { statCalls: [], findCalls: [] }
  const stat: ResolveDeps['statBatch'] = over.statBatch ?? (async () => NOWHERE)
  const find: ResolveDeps['findBySuffix'] = over.findBySuffix ?? (async () => ({ paths: [], truncated: false }))
  return {
    ...rec,
    statBatch: (req) => {
      rec.statCalls.push(req)
      return stat(req)
    },
    findBySuffix: (req) => {
      rec.findCalls.push(req)
      return find(req)
    },
  }
}

describe('resolvePathClick, a plain candidate', () => {
  it('reveals what statBatch resolved', async () => {
    const d = deps({
      statBatch: async () => ({ results: [{ i: 0, resolved: '/w/src/a.ts', kind: 'file' as const }] }),
    })
    const out = await resolvePathClick({ hit: hitOf('src/a.ts'), rows: alone, cwd: '/w', searchRoot: '/w' }, d)
    expect(out).toEqual({ kind: 'hit', hit: { resolved: '/w/src/a.ts', isDir: false } })
  })

  it('marks a directory as one, so the caller can refuse to open it', async () => {
    const d = deps({
      statBatch: async () => ({ results: [{ i: 0, resolved: '/w/src', kind: 'dir' as const }] }),
    })
    const out = await resolvePathClick({ hit: hitOf('src'), rows: alone, cwd: '/w', searchRoot: '/w' }, d)
    expect(out).toEqual({ kind: 'hit', hit: { resolved: '/w/src', isDir: true } })
  })

  it('takes the joined-next form when the token alone is a miss', async () => {
    const wrapped: RowContext = {
      prevRow: null,
      nextRow: 'es/PaneView.tsx and more',
      startCol: 64,
      endCol: 80,
      cols: 80,
    }
    const d = deps({
      // statBatch omits misses, so only the second candidate comes back.
      statBatch: async () => ({
        results: [{ i: 1, resolved: '/w/src/renderer/panes/PaneView.tsx', kind: 'file' as const }],
      }),
    })
    const out = await resolvePathClick(
      { hit: hitOf('src/renderer/pan'), rows: wrapped, cwd: '/w', searchRoot: '/w' },
      d
    )
    expect(d.statCalls).toEqual([
      { cwd: '/w', candidates: ['src/renderer/pan', 'src/renderer/panes/PaneView.tsx'] },
    ])
    expect(out).toEqual({
      kind: 'hit',
      hit: { resolved: '/w/src/renderer/panes/PaneView.tsx', isDir: false },
    })
  })

  it('prefers the lowest-index hit however the results arrive', async () => {
    const wrapped: RowContext = { prevRow: null, nextRow: 'x.ts here', startCol: 70, endCol: 80, cols: 80 }
    const d = deps({
      statBatch: async () => ({
        results: [
          { i: 1, resolved: '/w/joined', kind: 'file' as const },
          { i: 0, resolved: '/w/alone', kind: 'file' as const },
        ],
      }),
    })
    const out = await resolvePathClick({ hit: hitOf('src/a'), rows: wrapped, cwd: '/w', searchRoot: '/w' }, d)
    expect(out).toEqual({ kind: 'hit', hit: { resolved: '/w/alone', isDir: false } })
  })

  it('takes the joined file over the unjoined directory a wrap left behind', async () => {
    const wrapped: RowContext = {
      prevRow: null,
      nextRow: 'wrap-join.ts tail',
      startCol: 88,
      endCol: 144,
      cols: 145,
    }
    const d = deps({
      // The wrap fell on a separator, so the token alone is a real directory.
      statBatch: async () => ({
        results: [
          { i: 0, resolved: '/w/src/renderer/links', kind: 'dir' as const },
          { i: 1, resolved: '/w/src/renderer/links/wrap-join.ts', kind: 'file' as const },
        ],
      }),
    })
    const out = await resolvePathClick(
      { hit: hitOf('/w/src/renderer/links/'), rows: wrapped, cwd: '/w', searchRoot: '/w' },
      d
    )
    expect(out).toEqual({
      kind: 'hit',
      hit: { resolved: '/w/src/renderer/links/wrap-join.ts', isDir: false },
    })
  })

  it('still reveals a directory when that is all there is', async () => {
    const d = deps({
      statBatch: async () => ({
        results: [{ i: 0, resolved: '/w/src/renderer/links', kind: 'dir' as const }],
      }),
    })
    const out = await resolvePathClick(
      { hit: hitOf('src/renderer/links'), rows: alone, cwd: '/w', searchRoot: '/w' },
      d
    )
    expect(out).toEqual({ kind: 'hit', hit: { resolved: '/w/src/renderer/links', isDir: true } })
  })

  it('names the candidate and the directory when nothing resolves', async () => {
    const d = deps()
    const out = await resolvePathClick(
      { hit: hitOf('notafile/x.ts'), rows: alone, cwd: '/w', searchRoot: '/w' },
      d
    )
    expect(out).toEqual({ kind: 'miss', message: 'No file at notafile/x.ts from /w' })
  })

  it('says the directory is unknown rather than printing an empty one', async () => {
    const d = deps()
    const out = await resolvePathClick(
      { hit: hitOf('notafile/x.ts'), rows: alone, cwd: '', searchRoot: '/w' },
      d
    )
    expect(out).toEqual({
      kind: 'miss',
      message: 'No file at notafile/x.ts from an unknown directory',
    })
  })
})

describe('resolvePathClick, a truncated candidate', () => {
  it('searches the root for the suffix and reveals a unique match', async () => {
    const d = deps({
      findBySuffix: async () => ({ paths: ['/h/p/src/renderer/app.tsx'], truncated: false }),
    })
    const out = await resolvePathClick(
      { hit: hitOf('…/renderer/app.tsx'), rows: alone, cwd: '/w', searchRoot: '/h' },
      d
    )
    expect(out).toEqual({ kind: 'hit', hit: { resolved: '/h/p/src/renderer/app.tsx', isDir: false } })
    expect(d.statCalls).toEqual([])
  })

  it('passes the segment-anchored suffix through, narrowest root first', async () => {
    const d = deps()
    await resolvePathClick(
      { hit: hitOf('.../app.tsx'), rows: alone, cwd: '/w', searchRoot: '/h' },
      d
    )
    expect(d.findCalls).toEqual([
      { root: '/w', suffix: '/app.tsx', limit: 10 },
      { root: '/h', suffix: '/app.tsx', limit: 10 },
    ])
  })

  it('stops at the pane directory when it answers, and never walks the wider root', async () => {
    const d = deps({
      findBySuffix: async (req) =>
        req.root === '/w' ? { paths: ['/w/src/app.tsx'], truncated: false } : { paths: [], truncated: false },
    })
    const out = await resolvePathClick(
      { hit: hitOf('…/app.tsx'), rows: alone, cwd: '/w', searchRoot: '/h' },
      d
    )
    expect(out).toEqual({ kind: 'hit', hit: { resolved: '/w/src/app.tsx', isDir: false } })
    expect(d.findCalls.map((c) => c.root)).toEqual(['/w'])
  })

  it('falls back to the explorer root when the pane directory has nothing', async () => {
    const d = deps({
      findBySuffix: async (req) =>
        req.root === '/h' ? { paths: ['/h/x/app.tsx'], truncated: false } : { paths: [], truncated: false },
    })
    const out = await resolvePathClick(
      { hit: hitOf('…/app.tsx'), rows: alone, cwd: '/w', searchRoot: '/h' },
      d
    )
    expect(out).toEqual({ kind: 'hit', hit: { resolved: '/h/x/app.tsx', isDir: false } })
    expect(d.findCalls.map((c) => c.root)).toEqual(['/w', '/h'])
  })

  it('searches once when the pane is already sitting in the explorer root', async () => {
    const d = deps()
    await resolvePathClick({ hit: hitOf('…/app.tsx'), rows: alone, cwd: '/h', searchRoot: '/h' }, d)
    expect(d.findCalls.map((c) => c.root)).toEqual(['/h'])
  })

  it('says where it looked when nothing under the root ends in the suffix', async () => {
    const d = deps()
    const out = await resolvePathClick(
      { hit: hitOf('…/renderer/app.tsx'), rows: alone, cwd: '/w', searchRoot: '/h' },
      d
    )
    // The widest root that was actually walked, not the one it started from.
    expect(out).toEqual({ kind: 'miss', message: 'Nothing under /h ends in /renderer/app.tsx' })
  })

  it('lists the first three matches and how many there were', async () => {
    const d = deps({
      findBySuffix: async () => ({ paths: ['/h/a.tsx', '/h/b/a.tsx', '/h/c/a.tsx', '/h/d/a.tsx'], truncated: false }),
    })
    const out = await resolvePathClick(
      { hit: hitOf('…/a.tsx'), rows: alone, cwd: '/w', searchRoot: '/h' },
      d
    )
    expect(out).toEqual({
      kind: 'miss',
      message: '4 files end in /a.tsx: /h/a.tsx, /h/b/a.tsx, /h/c/a.tsx',
    })
  })

  it('says how far it got when the budget stopped the walk, not how far it looked', async () => {
    const d = deps({
      // Two found, then MAX_VISITED. `truncated` here means the budget, not the
      // limit, so claiming ten would be inventing eight files.
      findBySuffix: async () => ({ paths: ['/h/a/x.tsx', '/h/b/x.tsx'], truncated: true }),
    })
    const out = await resolvePathClick(
      { hit: hitOf('…/x.tsx'), rows: alone, cwd: '/w', searchRoot: '/h' },
      d
    )
    expect(out).toEqual({
      kind: 'miss',
      message: '2+ files end in /x.tsx: /h/a/x.tsx, /h/b/x.tsx',
    })
  })

  it('does not claim there is nothing when it only ran out of budget', async () => {
    const d = deps({ findBySuffix: async () => ({ paths: [], truncated: true }) })
    const out = await resolvePathClick(
      { hit: hitOf('…/x.tsx'), rows: alone, cwd: '/w', searchRoot: '/h' },
      d
    )
    expect(out).toEqual({
      kind: 'miss',
      message: 'Gave up searching /h for something ending in /x.tsx',
    })
  })

  it('says 10+ rather than a count the search never finished counting', async () => {
    const d = deps({
      findBySuffix: async () => ({
        paths: Array.from({ length: 10 }, (_, i) => `/h/${i}/a.tsx`),
        truncated: true,
      }),
    })
    const out = await resolvePathClick(
      { hit: hitOf('…/a.tsx'), rows: alone, cwd: '/w', searchRoot: '/h' },
      d
    )
    expect(out).toEqual({
      kind: 'miss',
      message: '10+ files end in /a.tsx: /h/0/a.tsx, /h/1/a.tsx, /h/2/a.tsx',
    })
  })
})
