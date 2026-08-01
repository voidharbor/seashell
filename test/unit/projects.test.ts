import { describe, expect, it } from 'vitest'
import {
  remapTree,
  savedCommandFor,
  tabToSaved,
  tabsFromSaved,
} from '../../src/renderer/projects/serialize.js'
import { isValidProject, upsertProject } from '../../src/main/state/store.js'
import type { PaneState, TabState } from '../../src/renderer/store.js'
import type { Project } from '../../src/shared/ipc.js'

function pane(id: string, extra: Partial<PaneState> = {}): PaneState {
  return {
    id,
    kind: 'term',
    cwd: '/Users/j/work',
    label: 'work',
    labelIsCustom: false,
    command: 'zsh',
    pid: 4242,
    status: 'live',
    ...extra,
  }
}

function tab(panes: PaneState[]): TabState {
  return {
    id: 'tab-1',
    name: 'work',
    cwd: '/Users/j/work',
    pristine: true,
    zoomedPaneId: null,
    focusedPaneId: panes[0]!.id,
    panes: Object.fromEntries(panes.map((p) => [p.id, p])),
    tree: {
      type: 'row',
      ratios: [1],
      children: [
        { type: 'col', ratios: panes.map(() => 1 / panes.length), children: panes.map((p) => ({ type: 'pane', paneId: p.id })) },
      ],
    },
  }
}

let n = 0
const mint = (prefix: string): string => `${prefix}-new-${++n}`

describe('saving a project', () => {
  /**
   * A terminal buffer routinely holds API keys, tokens and customer data.
   * Persisting it to a plain JSON file in the user's Library would be a real
   * exposure bought for a nicety, so the omission is asserted, not assumed.
   */
  it('keeps no runtime state — no pid, status, metrics or attention', () => {
    const saved = tabToSaved(
      tab([pane('p1', { pid: 999, attention: 'waiting', attentionAt: 123, generation: 3 })])
    )
    const json = JSON.stringify(saved)
    for (const leaked of ['pid', 'status', 'metrics', 'attention', 'generation']) {
      expect(json, leaked).not.toContain(`"${leaked}"`)
    }
  })

  it('keeps the shape worth restoring', () => {
    const saved = tabToSaved(tab([pane('p1', { color: 'blue', labelIsCustom: true })]))
    const only = Object.values(saved.panes)[0]!
    expect(only.cwd).toBe('/Users/j/work')
    expect(only.color).toBe('blue')
    expect(only.labelIsCustom).toBe(true)
    expect(saved.name).toBe('work')
  })
})

/**
 * Reopening a project used to hand back a row of bare shells.
 *
 * Nothing in the app had set `command: 'claude'` since the `✻` button left the
 * tab bar, so every pane was born `'zsh'`, saved as `'zsh'`, and restored as a
 * plain terminal — while the app knew perfectly well what was running in it,
 * because that is what the pane's own title-bar badge reads from.
 */
describe('recording what a pane is actually running', () => {
  const running = (foregroundProcess: string, extra: Partial<PaneState> = {}): PaneState =>
    pane('p1', {
      metrics: {
        paneId: 'p1',
        footprintBytes: 0,
        cpuFrac: 0,
        state: 'WAITING',
        foregroundProcess,
        procCount: 2,
        cwd: '',
      },
      ...extra,
    })

  it('saves an agent pane as the agent, not as the shell it was launched from', () => {
    expect(savedCommandFor(running('claude'))).toBe('claude')
  })

  it('tolerates a process that has rewritten its own title', () => {
    // Real observed `ps` values — a program may append to argv[0].
    expect(savedCommandFor(running('claude bg-pty-host'))).toBe('claude')
  })

  it('takes the program name out of a resolved path', () => {
    expect(savedCommandFor(running('/Users/j/.local/bin/claude'))).toBe('claude')
  })

  /**
   * Restoring is literally typing into a shell, so this must be an allowlist.
   * Anything unrecognised comes back as a plain shell — disappointing, never
   * dangerous.
   */
  it('refuses to reproduce anything it does not explicitly know', () => {
    expect(savedCommandFor(running('rm'))).toBe('zsh')
    expect(savedCommandFor(running('bash'))).toBe('zsh')
    // A pane running an editor: the filename was never observable, so restoring
    // `vim` alone would open an empty buffer rather than the file.
    expect(savedCommandFor(running('vim'))).toBe('zsh')
    // A pipeline restores as whatever the leaf process happened to be — which
    // is exactly the kind of guess not worth making.
    expect(savedCommandFor(running('grep'))).toBe('zsh')
    expect(savedCommandFor(running(''))).toBe('zsh')
  })

  it('never lets an inferred command override one the user chose', () => {
    const explicit = running('claude', { command: 'cmd', commandText: 'npm run dev' })
    expect(savedCommandFor(explicit)).toBe('cmd')
    expect(Object.values(tabToSaved(tab([explicit])).panes)[0]!.commandText).toBe('npm run dev')
  })

  it('leaves a pane with nothing running as a plain shell', () => {
    expect(savedCommandFor(pane('p1'))).toBe('zsh')
  })

  it('carries the inferred command all the way through a save and reopen', () => {
    const saved = [tabToSaved(tab([running('claude')]))]
    const [restored] = tabsFromSaved(saved, mint)
    const only = Object.values(restored!.panes)[0]!
    expect(only.command).toBe('claude')
    // And it still comes back as a fresh, unspawned shell — the retype only
    // ever happens against a brand-new PTY, never into a live conversation.
    expect(only.status).toBe('starting')
    expect(only.pid).toBeNull()
  })
})

describe('restoring a project', () => {
  /**
   * Reusing saved ids is simpler and wrong: a project can be opened while other
   * tabs are on screen, and two panes sharing an id makes the PTY router deliver
   * one pane's output into the other.
   */
  it('mints fresh ids rather than reusing the saved ones', () => {
    const saved = [tabToSaved(tab([pane('p1'), pane('p2')]))]
    const [restored] = tabsFromSaved(saved, mint)
    expect(Object.keys(restored!.panes)).not.toContain('p1')
    expect(Object.keys(restored!.panes)).not.toContain('p2')
    expect(Object.keys(restored!.panes)).toHaveLength(2)
  })

  it('remaps the layout tree through the same id table', () => {
    const saved = [tabToSaved(tab([pane('p1'), pane('p2')]))]
    const [restored] = tabsFromSaved(saved, mint)
    const ids = Object.keys(restored!.panes)
    const inTree = restored!.tree.children.flatMap((c) => c.children.map((l) => l.paneId))
    // Every leaf must point at a pane that exists, and every pane must be placed.
    expect(inTree.sort()).toEqual(ids.sort())
  })

  it('brings terminals back as starting and previews as live', () => {
    const saved = [
      tabToSaved(
        tab([pane('p1'), pane('p2', { kind: 'file', filePath: '/Users/j/a.ts' })])
      ),
    ]
    const [restored] = tabsFromSaved(saved, mint)
    const byKind = Object.values(restored!.panes)
    expect(byKind.find((p) => p.kind === 'term')!.status).toBe('starting')
    expect(byKind.find((p) => p.kind === 'file')!.status).toBe('live')
    // Nothing restored can claim to own a process.
    expect(byKind.every((p) => p.pid === null)).toBe(true)
  })

  it('drops a tab with no panes rather than restoring an empty one', () => {
    const saved = [{ ...tabToSaved(tab([pane('p1')])), panes: {} }]
    expect(tabsFromSaved(saved, mint)).toHaveLength(0)
  })

  it('survives a hand-edited or older tree instead of refusing to open', () => {
    const saved = [{ ...tabToSaved(tab([pane('p1')])), tree: { type: 'nonsense' } }]
    const [restored] = tabsFromSaved(saved, mint)
    expect(restored).toBeDefined()
    expect(Object.keys(restored!.panes)).toHaveLength(1)
  })
})

describe('remapTree', () => {
  it('normalises ratios that do not sum to 1', () => {
    const map = new Map([['a', 'A']])
    const tree = remapTree(
      { type: 'row', ratios: [7], children: [{ type: 'col', ratios: [9], children: [{ type: 'pane', paneId: 'a' }] }] },
      map
    )
    expect(tree.ratios[0]).toBeCloseTo(1)
    expect(tree.children[0]!.ratios[0]).toBeCloseTo(1)
  })

  it('drops leaves whose pane no longer exists', () => {
    const map = new Map([['a', 'A']])
    const tree = remapTree(
      {
        type: 'row',
        ratios: [0.5, 0.5],
        children: [
          { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'a' }] },
          { type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'gone' }] },
        ],
      },
      map
    )
    expect(tree.children).toHaveLength(1)
    expect(tree.ratios[0]).toBeCloseTo(1)
  })
})

describe('upsertProject', () => {
  const base: Project = { id: 'p1', name: 'Solar Bear', savedAt: 'x', tabs: [] }

  it('replaces by name, so saving twice does not fork the project', () => {
    const out = upsertProject([base], { ...base, id: '', name: 'solar bear' })
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('p1')
  })

  it('replaces by id even when the name changed, so renaming is not a fork', () => {
    const out = upsertProject([base], { ...base, name: 'Renamed' })
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('Renamed')
  })

  it('appends a genuinely new project', () => {
    const out = upsertProject([base], { id: 'p2', name: 'Other', savedAt: 'y', tabs: [] })
    expect(out).toHaveLength(2)
  })
})

describe('isValidProject', () => {
  const good = {
    id: 'p1',
    name: 'n',
    savedAt: 'x',
    tabs: [
      {
        id: 't', name: 'n', nameIsCustom: false, cwd: '/', zoomedPaneId: null,
        focusedPaneId: null, tree: {},
        panes: { a: { label: 'l', labelIsCustom: false, kind: 'term', command: 'zsh', cwd: '/' } },
      },
    ],
  }

  it('accepts a well-formed project', () => {
    expect(isValidProject(good)).toBe(true)
  })

  it('rejects anything structurally wrong rather than repairing it', () => {
    expect(isValidProject(null)).toBe(false)
    expect(isValidProject({ ...good, id: '' })).toBe(false)
    expect(isValidProject({ ...good, tabs: [] })).toBe(false)
    expect(isValidProject({ ...good, tabs: [{ ...good.tabs[0], panes: { a: { label: 'l', kind: 'nope', cwd: '/' } } }] })).toBe(false)
  })
})
