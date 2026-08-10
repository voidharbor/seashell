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
  // A link is a live working relationship between two running sessions. A
  // project restored next week would point two fresh agents at notes neither
  // of them wrote.
  | 'linkId'
  // Recovered from the session's own transcript at open, never stored: a
  // saved mode would go stale the moment the user cycled it, and a project
  // file is user data no flag should be composed from.
  | 'claudeResumeMode'
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

/**
 * claude session ids are UUIDs; the id is later composed into `claude -r <id>`
 * and typed into a real shell, so anything shaped differently is dropped at
 * every boundary it crosses. Mirrors SESSION_ID_RE in
 * src/main/state/session-lookup.ts.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function paneToSaved(pane: PaneState, sessionId?: string): SavedPane {
  const command = savedCommandFor(pane)
  // Only a claude terminal pane records a session to resume; the id itself
  // must be UUID-shaped or it does not get written at all.
  const sid =
    pane.kind === 'term' && command === 'claude' && sessionId && SESSION_ID_RE.test(sessionId)
      ? sessionId
      : undefined
  return {
    label: pane.label,
    labelIsCustom: pane.labelIsCustom,
    kind: pane.kind,
    command,
    cwd: pane.cwd,
    ...(sid === undefined ? {} : { claudeSessionId: sid }),
    ...(pane.commandText === undefined ? {} : { commandText: pane.commandText }),
    ...(pane.color === undefined ? {} : { color: pane.color }),
    ...(pane.filePath === undefined ? {} : { filePath: pane.filePath }),
    ...(pane.url === undefined ? {} : { url: pane.url }),
  }
}

export function tabToSaved(tab: TabState, sessionIds?: ReadonlyMap<string, string>): SavedTab {
  return {
    id: tab.id,
    name: tab.name,
    nameIsCustom: tab.nameIsCustom ?? false,
    cwd: tab.cwd,
    zoomedPaneId: tab.zoomedPaneId,
    focusedPaneId: tab.focusedPaneId,
    tree: tab.tree,
    panes: Object.fromEntries(
      Object.entries(tab.panes).map(([id, p]) => [id, paneToSaved(p, sessionIds?.get(id))])
    ),
  }
}

export function stateToTabs(state: AppState, sessionIds?: ReadonlyMap<string, string>): SavedTab[] {
  return state.tabs.map((t) => tabToSaved(t, sessionIds))
}

/**
 * The flag a resumed session's recovered permission mode maps to. A fixed
 * table, not string interpolation: the mode came out of a transcript file on
 * disk and the result is typed into a shell, so an unknown value maps to
 * nothing at all. bypassPermissions travels as its own flag because that is
 * the only spelling `claude` accepts for it without extra ceremony.
 */
const RESUME_MODE_FLAGS: Readonly<Record<string, string>> = {
  bypassPermissions: '--dangerously-skip-permissions',
  acceptEdits: '--permission-mode acceptEdits',
  auto: '--permission-mode auto',
  manual: '--permission-mode manual',
  dontAsk: '--permission-mode dontAsk',
  plan: '--permission-mode plan',
}

/**
 * The text a freshly spawned pane types into its shell, or null for a plain
 * shell. Restore is deliberately visible — the user watches `claude -r <id>`
 * run, and when the session no longer resumes the failed command sits in a
 * normal shell at the saved cwd instead of a spooky blank pane. The resume
 * form is composed only from the literal program name, a fixed flag table
 * and a UUID-validated id, never from free text in a project file.
 *
 * The mode flag rides along because a bare resume falls back to the settings
 * defaultMode — a session that ran in bypassPermissions all week would come
 * back with Bash denied and no prompt ever shown.
 */
export function launchCommandText(pane: {
  command: PaneCommand
  commandText?: string
  claudeSessionId?: string
  claudeResumeMode?: string
}): string | null {
  if (pane.command === 'claude') {
    if (!pane.claudeSessionId || !SESSION_ID_RE.test(pane.claudeSessionId)) return 'claude'
    const flag = pane.claudeResumeMode ? RESUME_MODE_FLAGS[pane.claudeResumeMode] : undefined
    return flag
      ? `claude ${flag} -r ${pane.claudeSessionId}`
      : `claude -r ${pane.claudeSessionId}`
  }
  if (pane.command === 'cmd') return pane.commandText ?? null
  return null
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

export function savedToPane(id: string, sp: SavedPane): PaneState {
  return {
    id,
    kind: sp.kind,
    cwd: sp.cwd,
    label: sp.label,
    labelIsCustom: sp.labelIsCustom ?? false,
    command: sp.command,
    // A project file is user data: an id that is not UUID-shaped is dropped
    // here, and the pane restores as a fresh claude instead.
    ...(typeof sp.claudeSessionId === 'string' && SESSION_ID_RE.test(sp.claudeSessionId)
      ? { claudeSessionId: sp.claudeSessionId }
      : {}),
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
