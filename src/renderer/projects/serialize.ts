import type { SavedPane, SavedTab } from '../../shared/ipc.js'
import type { AppState, PaneCommand, PaneState, TabState } from '../store.js'
import { createInitialTree } from '../layout/tree.js'
import type { RowNode } from '../layout/types.js'
import { isPaneColorKey } from '../panes/colors.js'

/**
 * Turning a live window into a saved project, and back.
 *
 * A project is a *shape*, never a session: which tabs existed, how they were
 * split, what each pane's directory was and what it had been launched as.
 * Nothing that only makes sense while running is kept — no pid, no exit status,
 * no metrics, no attention state, no generation counter. Those describe
 * processes, and processes die with the app.
 *
 * Scrollback is excluded deliberately rather than merely unimplemented. A
 * terminal buffer routinely holds API keys, tokens and customer data, and
 * writing that to a plain JSON file in the user's Library is a real exposure to
 * buy a nicety.
 */

/** Runtime-only fields, listed once so the omission is deliberate and visible. */
export type SerializablePane = Omit<
  PaneState,
  | 'id'
  | 'pid'
  | 'status'
  | 'exit'
  | 'metrics'
  | 'attention'
  | 'attentionAt'
  | 'waitingSince'
  | 'generation'
>

/**
 * Foreground process names a pane may be restored as.
 *
 * An **allowlist**, and it has to stay one. Restoring is literally typing text
 * into a fresh shell, so anything reachable from here is something a project
 * file can make happen on open. A blocklist would mean every process name
 * nobody thought of is executable by default; this way the unknown case is a
 * plain shell, which is merely disappointing rather than dangerous.
 *
 * `vim somefile` is the shape of the problem: the foreground process is `vim`,
 * but retyping just `vim` opens an empty buffer, not the file — the argument
 * was never observable. So this is kept to programs that mean something useful
 * with no arguments at all, which today is one.
 */
const RESTORABLE_FOREGROUND: Readonly<Record<string, PaneCommand>> = {
  claude: 'claude',
}

/**
 * What a pane should be recorded as having been running.
 *
 * The bug this fixes: since the `✻` button left the tab bar, nothing in the app
 * ever set `command: 'claude'`. Every pane was created as `'zsh'`, so a saved
 * project recorded `'zsh'` and reopening it gave back a row of bare shells
 * instead of the agents that had been running in them.
 *
 * The app already knew — the monitor reports `foregroundProcess` on every tick,
 * which is what lets a pane badge itself `claude` in its own title bar. Nothing
 * ever wrote that back down. So a pane is saved as what it is *actually*
 * running rather than as whatever it was launched as.
 *
 * A command the user chose explicitly always wins over an inferred one. They
 * asked for that; this is only guessing.
 */
export function savedCommandFor(pane: PaneState): PaneCommand {
  if (pane.command !== 'zsh') return pane.command
  if (pane.kind !== 'term') return pane.command

  // `ps` reports a resolved path, and a program that rewrites its own process
  // title can append to it — "claude bg-pty-host" is a real observed value. The
  // leading token after the last slash is the program itself.
  const raw = pane.metrics?.foregroundProcess ?? ''
  const name = (raw.split(/\s+/)[0] ?? '').split('/').pop() ?? ''
  return RESTORABLE_FOREGROUND[name] ?? 'zsh'
}

export function paneToSaved(pane: PaneState): SavedPane {
  return {
    label: pane.label,
    labelIsCustom: pane.labelIsCustom,
    kind: pane.kind,
    command: savedCommandFor(pane),
    cwd: pane.cwd,
    ...(pane.commandText === undefined ? {} : { commandText: pane.commandText }),
    ...(pane.color === undefined ? {} : { color: pane.color }),
    ...(pane.filePath === undefined ? {} : { filePath: pane.filePath }),
    ...(pane.url === undefined ? {} : { url: pane.url }),
  }
}

export function tabToSaved(tab: TabState): SavedTab {
  return {
    id: tab.id,
    name: tab.name,
    nameIsCustom: tab.nameIsCustom ?? false,
    cwd: tab.cwd,
    zoomedPaneId: tab.zoomedPaneId,
    focusedPaneId: tab.focusedPaneId,
    tree: tab.tree,
    panes: Object.fromEntries(Object.entries(tab.panes).map(([id, p]) => [id, paneToSaved(p)])),
  }
}

export function stateToTabs(state: AppState): SavedTab[] {
  return state.tabs.map(tabToSaved)
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Rebuilds tabs from a project, minting fresh ids.
 *
 * Reusing the saved ids would be simpler and is wrong: a project can be opened
 * while other tabs are already on screen, and two panes sharing an id means the
 * PTY router delivers one pane's output to the other. The layout tree stores
 * pane ids, so it has to be remapped through the same table — a tree still
 * pointing at the old ids would lay out panes that no longer exist and drop the
 * ones that do.
 *
 * `mintId` is injected so the mapping is testable without the module-level id
 * counter.
 */
export function tabsFromSaved(
  saved: SavedTab[],
  mintId: (prefix: string) => string
): TabState[] {
  const out: TabState[] = []

  for (const tab of saved) {
    const idMap = new Map<string, string>()
    const panes: Record<string, PaneState> = {}

    for (const [oldId, sp] of Object.entries(tab.panes ?? {})) {
      const newId = mintId('pane')
      idMap.set(oldId, newId)
      panes[newId] = savedToPane(newId, sp)
    }

    if (Object.keys(panes).length === 0) continue // a tab with no panes is not a tab

    const tree = remapTree(tab.tree, idMap)
    out.push({
      id: mintId('tab'),
      name: tab.name,
      nameIsCustom: tab.nameIsCustom,
      cwd: tab.cwd,
      // A restored tab is pristine: the user has not dragged anything in *this*
      // session, and the saved ratios are reproduced by the tree itself.
      pristine: true,
      tree,
      zoomedPaneId: tab.zoomedPaneId ? (idMap.get(tab.zoomedPaneId) ?? null) : null,
      focusedPaneId: tab.focusedPaneId
        ? (idMap.get(tab.focusedPaneId) ?? Object.keys(panes)[0]!)
        : Object.keys(panes)[0]!,
      panes,
    })
  }

  return out
}

function savedToPane(id: string, sp: SavedPane): PaneState {
  return {
    id,
    kind: sp.kind,
    cwd: sp.cwd,
    label: sp.label,
    labelIsCustom: sp.labelIsCustom ?? false,
    command: sp.command,
    ...(sp.commandText === undefined ? {} : { commandText: sp.commandText }),
    ...(isPaneColorKey(sp.color) ? { color: sp.color } : {}),
    ...(sp.filePath === undefined ? {} : { filePath: sp.filePath }),
    ...(sp.url === undefined ? {} : { url: sp.url }),
    pid: null,
    // A terminal has to start its shell; a preview has nothing to wait for.
    status: sp.kind === 'term' ? 'starting' : 'live',
  }
}

/**
 * Rewrites pane ids inside a saved layout tree.
 *
 * Anything unrecognised falls back to a single-pane tree over whatever panes
 * did map, rather than throwing. A project file is user data that may have been
 * written by an older build or edited by hand; failing to open it entirely
 * because one node is unexpected is a worse outcome than a tidy default layout.
 */
export function remapTree(tree: unknown, idMap: Map<string, string>): RowNode {
  const fallback = (): RowNode => createInitialTree([...idMap.values()][0] ?? 'pane-missing')

  const walk = (node: unknown): RowNode | null => {
    if (typeof node !== 'object' || node === null) return null
    const n = node as { type?: string; ratios?: unknown; children?: unknown }
    if (n.type !== 'row' || !Array.isArray(n.children) || !Array.isArray(n.ratios)) return null

    const cols: RowNode['children'] = []
    const ratios: number[] = []

    const rowKids: unknown[] = n.children
    const rowRatios: unknown[] = n.ratios

    rowKids.forEach((col, i) => {
      if (typeof col !== 'object' || col === null) return
      const c = col as { type?: string; ratios?: unknown; children?: unknown }
      if (c.type !== 'col' || !Array.isArray(c.children) || !Array.isArray(c.ratios)) return

      const colKids: unknown[] = c.children
      const colRatiosRaw: unknown[] = c.ratios

      const leaves: Array<{ readonly type: 'pane'; readonly paneId: string }> = []
      const colRatios: number[] = []
      colKids.forEach((leaf, j) => {
        const l = leaf as { type?: string; paneId?: unknown }
        if (l?.type !== 'pane' || typeof l.paneId !== 'string') return
        const mapped = idMap.get(l.paneId)
        if (!mapped) return
        leaves.push({ type: 'pane', paneId: mapped })
        const r = colRatiosRaw[j]
        colRatios.push(typeof r === 'number' && r > 0 ? r : 1 / colKids.length)
      })

      if (leaves.length === 0) return
      cols.push({ type: 'col', ratios: normalize(colRatios), children: leaves })
      const r = rowRatios[i]
      ratios.push(typeof r === 'number' && r > 0 ? r : 1 / rowKids.length)
    })

    if (cols.length === 0) return null
    return { type: 'row', ratios: normalize(ratios), children: cols }
  }

  return walk(tree) ?? fallback()
}

/** Ratios must sum to 1; a saved file could hold anything. */
function normalize(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0)
  if (!Number.isFinite(total) || total <= 0) {
    return values.map(() => 1 / Math.max(1, values.length))
  }
  return values.map((v) => v / total)
}
