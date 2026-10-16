import type { PaneAgentVerdict, PaneMetrics, ProjectsSessionIdsResponse, SavedPane, SavedTab } from '../../shared/ipc.js'
import { claudeTitleFromLabel } from '../../shared/claude-title.js'
import {
  agentLaunchText,
  cleanAgentFlags,
  isOtherAgentKind,
  isValidAgentSessionId,
  OTHER_AGENT_KINDS,
  type OtherAgentKind,
} from '../../shared/agents.js'
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
  | 'generation'
  // A link is a live working relationship between two running sessions. A
  // project restored next week would point two fresh agents at notes neither
  // of them wrote.
  | 'linkId'
  // Recovered from the session's own transcript at open, never stored: a
  // saved mode would go stale the moment the user cycled it, and a project
  // file is user data no flag should be composed from.
  | 'claudeResumeMode'
  // An observation about this run of the pane, not about what it is.
  | 'claudeSeen'
  | 'agentSeen'
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
 * with no arguments at all: claude and opencode. (jarvis and ultron run as
 * `node`, which names nothing; main's process lane proves those.)
 */
const RESTORABLE_FOREGROUND: Readonly<Record<string, PaneCommand>> = {
  claude: 'claude',
  opencode: 'opencode',
}

/**
 * The program a metrics tick says is in the foreground, or null when the tick
 * says nothing (no tick yet, a platform that sends none, or a sweep that did
 * not find the pane's own shell, which the monitor reports as a bare 'zsh'
 * with no processes counted).
 *
 * `ps` reports a resolved path, and a program that rewrites its own process
 * title can append to it: "claude bg-pty-host" is a real observed value. The
 * leading token after the last slash is the program itself.
 */
export function foregroundProgram(metrics: PaneMetrics | undefined): string | null {
  if (!metrics || !(metrics.procCount >= 1)) return null
  const name = ((metrics.foregroundProcess ?? '').split(/\s+/)[0] ?? '').split('/').pop() ?? ''
  return name === '' ? null : name
}

/**
 * What a pane should be recorded as having been running.
 *
 * The bug this fixes: since the `✻` button left the tab bar, nothing in the app
 * ever set `command: 'claude'`. Every pane was created as `'zsh'`, so a saved
 * project recorded `'zsh'` and reopening it gave back a row of bare shells
 * instead of the agents that had been running in them.
 *
 * Evidence, strongest first:
 * - `claudeRunning`: main found a live claude in this pane's process tree.
 * - the last metrics tick names claude as the foreground.
 * - the pane is a claude pane (restored as one, or carrying a session id only
 *   a proof could have given it). It stays claude, id and all, until a tick
 *   positively shows something else in the foreground after claude was seen
 *   there. A missing tick, a failed sweep or an unknown foreground is not
 *   evidence of anything: treating it as such is how one bad sweep once
 *   re-saved a whole project as bare shells and lost every session id.
 *
 * A 'cmd' pane keeps its command: retyping it is what the user asked for.
 */
export function savedCommandFor(pane: PaneState, claudeRunning = false): PaneCommand {
  if (pane.kind !== 'term' || pane.command === 'cmd') return pane.command
  if (claudeRunning) return 'claude'
  // Another agent's pane is settled by `savedAgentFor` before this runs; what
  // reaches here is a pane that is not (or no longer) running one.

  const fg = foregroundProgram(pane.metrics)
  if (fg !== null && Object.hasOwn(RESTORABLE_FOREGROUND, fg)) return RESTORABLE_FOREGROUND[fg]!

  // A shell pane only ever gets an id from a proof that claude ran in it; a
  // restored claude pane has to be seen running before a tick can retire it,
  // or the first tick after restore (the shell, before claude has started)
  // would save every pane as a shell.
  const claudePane = pane.command === 'claude' || pane.claudeSessionId !== undefined
  if (!claudePane) return 'zsh'
  const seen = pane.command === 'zsh' || pane.claudeSeen === true
  return seen && fg !== null ? 'zsh' : 'claude'
}

/**
 * claude session ids are UUIDs; the id is later composed into `claude -r <id>`
 * and typed into a real shell, so anything shaped differently is dropped at
 * every boundary it crosses. Mirrors SESSION_ID_RE in
 * src/main/state/session-lookup.ts.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `claudeRunning` is main's proof, from the process table, that a live claude
 * is in this pane right now. It outranks the renderer's own inference, which
 * rests on metrics ticks that a platform may never send (the Linux monitor
 * sent none, so every pane where claude was typed by hand saved as a shell).
 * A 'cmd' pane keeps its command: retyping it is what the user asked for.
 */
/**
 * What a jarvis, ultron or opencode pane saves as, or null when it is not
 * one. `verdict` is main's answer for the pane: undefined when no lookup was
 * made (the pane keeps what it carries), else its verdict or null for none.
 * `checked` says main read the process table this time, so a pane once seen
 * running its agent and now running none has really left it. A claude proven
 * in the pane outranks everything here.
 */
export function savedAgentFor(
  pane: PaneState,
  verdict: PaneAgentVerdict | null | undefined,
  claudeRunning = false,
  checked = false
): { kind: OtherAgentKind; sid?: string; flags: string[] } | null {
  if (pane.kind !== 'term' || pane.command === 'cmd' || claudeRunning) return null
  const own = (): { kind: OtherAgentKind; sid?: string; flags: string[] } | null =>
    isOtherAgentKind(pane.command)
      ? {
          kind: pane.command,
          ...(isValidAgentSessionId(pane.command, pane.agentSessionId) ? { sid: pane.agentSessionId } : {}),
          flags: cleanAgentFlags(pane.command, pane.agentFlags ?? []),
        }
      : null
  if (verdict === undefined) return own()
  if (verdict === null || !isOtherAgentKind(verdict.kind)) return null
  if (verdict.source === 'carried' && checked && pane.agentSeen === true) return null
  return {
    kind: verdict.kind,
    ...(isValidAgentSessionId(verdict.kind, verdict.sid) ? { sid: verdict.sid } : {}),
    flags: cleanAgentFlags(verdict.kind, verdict.flags ?? []),
  }
}

/** What a save knows about the other agents; see `saveLookupFrom`. */
export interface AgentLookup {
  verdicts: ReadonlyMap<string, PaneAgentVerdict>
  /** main read the process table, so a missing live agent means none. */
  checked: boolean
}

export function paneToSaved(
  pane: PaneState,
  sessionId?: string,
  claudeRunning = false,
  agents?: AgentLookup
): SavedPane {
  const agent = savedAgentFor(pane, agents ? (agents.verdicts.get(pane.id) ?? null) : undefined, claudeRunning, agents?.checked)
  if (agent) {
    return {
      label: pane.label,
      labelIsCustom: pane.labelIsCustom,
      kind: pane.kind,
      command: agent.kind,
      cwd: pane.cwd,
      ...(agent.sid === undefined ? {} : { agentSessionId: agent.sid }),
      ...(agent.flags.length === 0 ? {} : { agentFlags: agent.flags }),
      ...(pane.color === undefined ? {} : { color: pane.color }),
    }
  }
  const command = savedCommandFor(isOtherAgentKind(pane.command) ? { ...pane, command: 'zsh' } : pane, claudeRunning)
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

export function tabToSaved(
  tab: TabState,
  sessionIds?: ReadonlyMap<string, string>,
  claudeRunning?: ReadonlySet<string>,
  agents?: AgentLookup
): SavedTab {
  return {
    id: tab.id,
    name: tab.name,
    nameIsCustom: tab.nameIsCustom ?? false,
    cwd: tab.cwd,
    zoomedPaneId: tab.zoomedPaneId,
    focusedPaneId: tab.focusedPaneId,
    tree: tab.tree,
    panes: Object.fromEntries(
      Object.entries(tab.panes).map(([id, p]) => [
        id,
        // No lookup at all (it failed or was never made) is not a verdict:
        // the pane keeps the id it was last proven on. A lookup that ran and
        // left the pane out did decide, and is followed.
        paneToSaved(p, sessionIds ? sessionIds.get(id) : p.claudeSessionId, claudeRunning?.has(id) ?? false, agents),
      ])
    ),
    sessionIdsVerified: true,
  }
}

export function stateToTabs(
  state: AppState,
  sessionIds?: ReadonlyMap<string, string>,
  claudeRunning?: ReadonlySet<string>,
  agents?: AgentLookup
): SavedTab[] {
  return state.tabs.map((t) => tabToSaved(t, sessionIds, claudeRunning, agents))
}

/** What a save knows from main's session lookup; see `saveLookupFrom`. */
export interface SaveLookup {
  ids: ReadonlyMap<string, string>
  running: ReadonlySet<string>
  /** Undefined from a main that predates the other agents: every pane then
   *  keeps the agent it carries. */
  agents?: AgentLookup
}

/** One terminal pane as the session lookup is asked about it: claude's id
 *  for a claude pane, the agent and its session for another agent's. */
export function lookupPaneFor(p: PaneState): {
  paneId: string
  cwd: string
  knownSid?: string
  knownVerified?: boolean
  claude: boolean
  agent?: OtherAgentKind
  agentSid?: string
  agentFlags?: string[]
} {
  if (isOtherAgentKind(p.command)) {
    const flags = cleanAgentFlags(p.command, p.agentFlags ?? [])
    return {
      paneId: p.id,
      cwd: p.cwd,
      claude: false,
      agent: p.command,
      ...(isValidAgentSessionId(p.command, p.agentSessionId) ? { agentSid: p.agentSessionId } : {}),
      ...(flags.length > 0 ? { agentFlags: flags } : {}),
    }
  }
  return {
    paneId: p.id,
    cwd: p.cwd,
    ...(p.claudeSessionId ? { knownSid: p.claudeSessionId, knownVerified: true } : {}),
    claude: savedCommandFor(p) === 'claude',
  }
}

/** The verdicts a lookup proved from a live process, for `panes.agents`. */
export function provenAgents(res: ProjectsSessionIdsResponse | null): Record<string, PaneAgentVerdict> {
  const out: Record<string, PaneAgentVerdict> = {}
  if (!res || typeof res.agents !== 'object' || res.agents === null) return out
  for (const [id, v] of Object.entries(res.agents)) {
    if (v && v.source === 'process' && isOtherAgentKind(v.kind)) out[id] = v
  }
  return out
}

/**
 * Turns main's answer to a save's session lookup into what `stateToTabs`
 * takes. `panes` is every terminal pane in the window, in the order they were
 * sent; only the first `asked` were (the request is capped).
 *
 * Undefined means "no verdict", and every pane then saves the id it already
 * carries: the lookup threw (`res` null), or it came back answering nothing at
 * all while panes had ids to carry, which is what main sends for a request it
 * could not parse, never a real answer (a carried id is only refused when
 * another holder has it, and restore checks that again anyway). A pane past
 * the cap was never asked, so it keeps its own id too.
 */
export function saveLookupFrom(
  panes: readonly PaneState[],
  asked: number,
  res: ProjectsSessionIdsResponse | null
): SaveLookup | undefined {
  if (res === null) return undefined
  const sent = panes.slice(0, asked)
  if (Object.keys(res.sources).length === 0 && sent.some((p) => p.claudeSessionId !== undefined)) {
    return undefined
  }
  const ids = new Map(Object.entries(res.ids))
  for (const p of panes.slice(asked)) {
    if (p.claudeSessionId !== undefined) ids.set(p.id, p.claudeSessionId)
  }
  let agents: AgentLookup | undefined
  if (typeof res.agents === 'object' && res.agents !== null) {
    const verdicts = new Map<string, PaneAgentVerdict>()
    for (const [id, v] of Object.entries(res.agents)) if (v && isOtherAgentKind(v.kind)) verdicts.set(id, v)
    // A pane past the cap was never asked: it keeps its own agent.
    for (const p of panes.slice(asked)) {
      if (!isOtherAgentKind(p.command)) continue
      verdicts.set(p.id, {
        kind: p.command,
        ...(isValidAgentSessionId(p.command, p.agentSessionId) ? { sid: p.agentSessionId } : {}),
        ...(p.agentFlags ? { flags: cleanAgentFlags(p.command, p.agentFlags) } : {}),
        source: 'carried',
      })
    }
    agents = { verdicts, checked: res.agentsChecked === true }
  }
  return {
    ids,
    running: new Set(Object.keys(res.sources).filter((id) => res.sources[id] === 'process')),
    ...(agents ? { agents } : {}),
  }
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
 * The mode a claude pane is launched in at restore.
 *
 * With `bypassConsented` (the user has accepted claude's own bypass warning,
 * `skipDangerousModePermissionPrompt` in ~/.claude/settings.json), every pane
 * comes back in bypassPermissions unless its session was last in plan or
 * acceptEdits, which only a person picks. A recorded dontAsk or default is
 * never a choice: it is what a bare `claude -r` falls back to from the
 * settings defaultMode, and once recorded it used to come back forever, with
 * every tool call denied and no prompt shown.
 *
 * Without consent the recorded mode is followed as before and bypass is never
 * invented.
 */
export function claudeLaunchMode(recorded: string | undefined, bypassConsented: boolean): string | undefined {
  if (!bypassConsented) return recorded
  if (recorded === 'plan' || recorded === 'acceptEdits') return recorded
  return 'bypassPermissions'
}

/** Sets the launch mode on every claude terminal pane about to be restored,
 *  whether it resumes a session or starts cold. */
export function applyLaunchModes(
  tabs: TabState[],
  recorded: Readonly<Record<string, string>>,
  bypassConsented: boolean
): void {
  for (const tab of tabs) {
    for (const pane of Object.values(tab.panes)) {
      if (pane.kind !== 'term' || pane.command !== 'claude') continue
      const mode = claudeLaunchMode(pane.claudeSessionId ? recorded[pane.id] : undefined, bypassConsented)
      if (mode) pane.claudeResumeMode = mode
      else delete pane.claudeResumeMode
    }
  }
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
  agentSessionId?: string
  agentFlags?: string[]
}): string | null {
  // jarvis, ultron, opencode: a fixed program, a fixed flag table and an id
  // that passed the agent's own allowlist (src/shared/agents.ts).
  if (isOtherAgentKind(pane.command)) return agentLaunchText(pane.command, pane.agentSessionId, pane.agentFlags)
  if (pane.command === 'claude') {
    const flag = pane.claudeResumeMode ? RESUME_MODE_FLAGS[pane.claudeResumeMode] : undefined
    if (!pane.claudeSessionId || !SESSION_ID_RE.test(pane.claudeSessionId)) {
      return flag ? `claude ${flag}` : 'claude'
    }
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

/** One pane for main's session lookup at restore; mirrors
 *  ProjectsSessionIdsRequest['panes'][number]. */
export interface RestoreLookupPane {
  paneId: string
  cwd: string
  knownSid?: string
  knownVerified: boolean
  label?: string
  claude: boolean
  agent?: OtherAgentKind
  agentSid?: string
  agentFlags?: string[]
}

export interface RestorePlan {
  tabs: TabState[]
  /** The panes whose session main has to settle before anything is typed. */
  lookup: RestoreLookupPane[]
}

/**
 * Rebuilds a project's tabs and lists the panes whose session has to be
 * settled first: every claude pane, carrying its saved id and whether that id
 * can be trusted, and, in a tab an older build wrote, any shell pane whose
 * title says claude was on screen in it (those builds could save a claude pane
 * as a shell). Nothing here decides; main answers, and `applyRestoreIds`
 * writes the answer back.
 */
export function planRestore(saved: SavedTab[], mintId: (prefix: string) => string): RestorePlan {
  const tabs: TabState[] = []
  const lookup: RestoreLookupPane[] = []

  for (const savedTab of saved) {
    const verified = savedTab.sessionIdsVerified === true
    for (const tab of tabsFromSaved([savedTab], mintId)) {
      tabs.push(tab)
      for (const pane of Object.values(tab.panes)) {
        if (pane.kind !== 'term') continue
        if (isOtherAgentKind(pane.command)) {
          lookup.push({
            paneId: pane.id,
            cwd: pane.cwd,
            knownVerified: verified,
            claude: false,
            agent: pane.command,
            ...(pane.agentSessionId ? { agentSid: pane.agentSessionId } : {}),
            ...(pane.agentFlags ? { agentFlags: pane.agentFlags } : {}),
          })
          continue
        }
        const label = pane.labelIsCustom ? undefined : pane.label
        const titled = label !== undefined && claudeTitleFromLabel(label) !== null
        if (pane.command === 'claude' || (pane.command === 'zsh' && !verified && titled)) {
          lookup.push({
            paneId: pane.id,
            cwd: pane.cwd,
            ...(pane.claudeSessionId ? { knownSid: pane.claudeSessionId } : {}),
            knownVerified: verified,
            ...(label !== undefined ? { label } : {}),
            claude: true,
          })
        }
      }
    }
  }
  return { tabs, lookup }
}

/**
 * Writes main's answer into the planned tabs. A pane main resolved takes that
 * id (and a shell pane becomes claude); a pane it did not resolve loses its
 * saved id and restores as a fresh claude, because the lookup already kept
 * every id it could stand behind. `ids === null` means the lookup itself
 * failed: verified ids stand, unverified ones are dropped rather than trusted.
 */
export function applyRestoreIds(
  tabs: TabState[],
  lookup: readonly RestoreLookupPane[],
  ids: Readonly<Record<string, string>> | null,
  agents?: Readonly<Record<string, PaneAgentVerdict>>
): void {
  const asked = new Map(lookup.map((l) => [l.paneId, l]))
  for (const tab of tabs) {
    for (const pane of Object.values(tab.panes)) {
      const req = asked.get(pane.id)
      if (!req) continue
      if (req.agent && pane.command === req.agent) {
        // The same rule as claude's: a failed lookup keeps only a verified
        // id; an answer keeps only what main still stands behind.
        const v = ids === null ? undefined : agents?.[pane.id]
        const sid =
          ids === null ? (req.knownVerified ? req.agentSid : undefined) : v && v.kind === req.agent ? v.sid : undefined
        if (isValidAgentSessionId(req.agent, sid)) pane.agentSessionId = sid
        else delete pane.agentSessionId
        continue
      }
      const sid = ids === null ? (req.knownVerified ? req.knownSid : undefined) : ids[pane.id]
      if (sid && SESSION_ID_RE.test(sid)) {
        pane.claudeSessionId = sid
        pane.command = 'claude'
      } else {
        delete pane.claudeSessionId
      }
    }
  }
}

/** The commands a saved pane may come back as; anything else is a shell. */
const SAVED_COMMANDS: ReadonlySet<string> = new Set(['zsh', 'claude', 'cmd', ...OTHER_AGENT_KINDS])

export function savedToPane(id: string, sp: SavedPane): PaneState {
  const command: PaneCommand = SAVED_COMMANDS.has(sp.command) ? sp.command : 'zsh'
  return {
    id,
    kind: sp.kind,
    cwd: sp.cwd,
    label: sp.label,
    labelIsCustom: sp.labelIsCustom ?? false,
    command,
    // A project file is user data: an id that is not UUID-shaped is dropped
    // here, and the pane restores as a fresh claude instead.
    ...(typeof sp.claudeSessionId === 'string' && SESSION_ID_RE.test(sp.claudeSessionId)
      ? { claudeSessionId: sp.claudeSessionId }
      : {}),
    // The same for the other agents, each against its own allowlist.
    ...(isOtherAgentKind(command) && isValidAgentSessionId(command, sp.agentSessionId)
      ? { agentSessionId: sp.agentSessionId }
      : {}),
    ...(isOtherAgentKind(command) && cleanAgentFlags(command, sp.agentFlags).length > 0
      ? { agentFlags: cleanAgentFlags(command, sp.agentFlags) }
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
