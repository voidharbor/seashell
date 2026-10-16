/**
 * The last-session snapshot and its restore, ported from `app.tsx`
 * (collectSessionIds 486-511, snapshotSession 584-619, restoreProjectTabs
 * 649-692). The controller owns the timer and the restore card; this file
 * owns the capture and the rebuild, so both stay the renderer's code paths.
 */
import {
  applyLaunchModes,
  applyRestoreIds,
  lookupPaneFor,
  planRestore,
  provenAgents,
  saveLookupFrom,
  stateToTabs,
  type SaveLookup,
} from '../../renderer/projects/serialize.js'
import type { AppState, TabState } from '../../renderer/store.js'
import {
  MAX_TERM_PANES,
  type PaneAgentVerdict,
  type ProjectsResumeModesResponse,
  type ProjectsSessionIdsResponse,
  type SavedTab,
} from '../../shared/ipc.js'

/** How often the window writes itself to the last-session file (`app.tsx:79`). */
export const SNAPSHOT_INTERVAL_MS = 30_000

type Invoke = <T = unknown>(ch: string, p: unknown) => Promise<T>

/** The tabs a snapshot writes, captured the way a named project is. */
export function snapshotTabs(state: AppState, lookup: SaveLookup | undefined): SavedTab[] {
  return stateToTabs(state, lookup?.ids, lookup?.running, lookup?.agents)
}

/**
 * Asks main which claude session each terminal pane is on right now
 * (`app.tsx:486-511`). `proven` is what main proved from a live process or
 * the registry, for the caller to dispatch as `panes.sessionIds` so the next
 * save can carry it, and `provenAgents` the other agents (jarvis, ultron,
 * opencode) main found running, for `panes.agents`. A failed lookup is no
 * verdict: every pane keeps its id.
 */
export async function collectSaveLookup(
  state: AppState,
  invoke: Invoke
): Promise<{ lookup: SaveLookup | undefined; proven: Record<string, string>; provenAgents: Record<string, PaneAgentVerdict> }> {
  const termPanes = state.tabs.flatMap((t) => Object.values(t.panes).filter((p) => p.kind === 'term'))
  const asked = Math.min(termPanes.length, MAX_TERM_PANES)
  const livePanes = termPanes.slice(0, asked).map(lookupPaneFor)
  let res: ProjectsSessionIdsResponse | null = null
  try {
    res = await invoke<ProjectsSessionIdsResponse>('projects:sessionIds', { panes: livePanes })
  } catch {
    /* lookup unavailable: every pane keeps the id it already carries */
  }
  if (res && (typeof res.ids !== 'object' || res.ids === null || typeof res.sources !== 'object' || res.sources === null)) {
    res = null
  }
  const proven: Record<string, string> = {}
  if (res) {
    for (const [id, sid] of Object.entries(res.ids)) {
      if (res.sources[id] === 'process' || res.sources[id] === 'registry') proven[id] = sid
    }
  }
  return { lookup: saveLookupFrom(termPanes, asked, res), proven, provenAgents: provenAgents(res) }
}

/**
 * Saved tabs rebuilt with fresh ids and their claude sessions settled by
 * main before anything is typed (`app.tsx:649-692`). Anything unsettled
 * restores as a fresh claude, and every claude pane gets the launch mode
 * its session can work in. `releasing` is the panes about to be reaped
 * (opening a project replaces the window), whose sessions are free to resume.
 */
export async function restoreSavedTabs(
  saved: SavedTab[],
  invoke: Invoke,
  mintId: (prefix: string) => string,
  releasing: string[] = []
): Promise<TabState[]> {
  const { tabs: restored, lookup } = planRestore(saved, mintId)
  if (restored.length === 0) return []

  if (lookup.length > 0) {
    let ids: Record<string, string> | null = null
    let agents: Record<string, PaneAgentVerdict> | undefined
    try {
      const res = await invoke<ProjectsSessionIdsResponse>('projects:sessionIds', {
        panes: lookup.slice(0, MAX_TERM_PANES),
        ...(releasing.length > 0 ? { releasing: releasing.slice(0, MAX_TERM_PANES) } : {}),
      })
      ids = res && typeof res.ids === 'object' ? res.ids : null
      agents = res && typeof res.agents === 'object' && res.agents !== null ? res.agents : undefined
    } catch {
      /* applyRestoreIds keeps only verified ids when the lookup fails */
    }
    applyRestoreIds(restored, lookup, ids, agents)
  }

  const claudePanes = restored.flatMap((t) =>
    Object.values(t.panes).filter((p) => p.kind === 'term' && p.command === 'claude')
  )
  if (claudePanes.length > 0) {
    const resuming = claudePanes
      .filter((p) => p.claudeSessionId)
      .map((p) => ({ paneId: p.id, cwd: p.cwd, sid: p.claudeSessionId! }))
    try {
      const res = await invoke<ProjectsResumeModesResponse>('projects:resumeModes', { panes: resuming.slice(0, MAX_TERM_PANES) })
      applyLaunchModes(restored, res.modes, res.bypassConsented)
    } catch {
      /* a bare resume still works; it just follows the default mode */
    }
  }
  return restored
}
