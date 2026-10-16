/**
 * The coding agents a pane can be saved as running, and how each one resumes.
 * [pure]
 *
 * Restoring a pane is typing text into a fresh shell, so everything here is an
 * allowlist: a fixed program name per agent, a strict id shape per agent, and
 * a fixed table of the launcher flags worth carrying across a restart. A
 * session id or a flag that fails its check is never written and never typed;
 * the pane comes back as a fresh agent (or a plain shell) instead.
 *
 * What is *not* here is where each agent keeps its sessions and how a live
 * process is matched to one: that reads the filesystem and the process table,
 * and lives in src/main/state/agents.ts.
 */

export type AgentKind = 'claude' | 'jarvis' | 'ultron' | 'opencode'

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'jarvis', 'ultron', 'opencode']

/** The agents other than claude. claude keeps its own `claudeSessionId` field
 *  (old saved files carry it), every other agent uses `agentSessionId`. */
export type OtherAgentKind = Exclude<AgentKind, 'claude'>

export const OTHER_AGENT_KINDS: readonly OtherAgentKind[] = ['jarvis', 'ultron', 'opencode']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** opencode: `ses_` and its base62 tail (about 26 characters). */
const OPENCODE_ID_RE = /^ses_[A-Za-z0-9]{12,48}$/

/** Jarvis's own launcher flags that change how the session behaves, and the
 *  only ones carried across a restore. */
const JARVIS_EFFORT = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface AgentSpec {
  kind: AgentKind
  /** What the user calls it, for the panel and the toasts. */
  label: string
  /** The literal program typed into the shell. */
  program: string
  /** The allowlist every session id must pass before it is stored or typed. */
  idRe: RegExp
  /** The resume flag, in front of the id. */
  resumeFlag: string
}

export const AGENTS: Readonly<Record<AgentKind, AgentSpec>> = {
  claude: { kind: 'claude', label: 'Claude Code', program: 'claude', idRe: UUID_RE, resumeFlag: '-r' },
  jarvis: { kind: 'jarvis', label: 'Jarvis', program: 'jarvis', idRe: UUID_RE, resumeFlag: '--session' },
  ultron: { kind: 'ultron', label: 'Ultron', program: 'ultron', idRe: UUID_RE, resumeFlag: '--session' },
  opencode: { kind: 'opencode', label: 'opencode', program: 'opencode', idRe: OPENCODE_ID_RE, resumeFlag: '-s' },
}

export function isAgentKind(x: unknown): x is AgentKind {
  return typeof x === 'string' && Object.hasOwn(AGENTS, x)
}

export function isOtherAgentKind(x: unknown): x is OtherAgentKind {
  return x !== 'claude' && isAgentKind(x)
}

/** Whether `sid` is shaped like a session id of `kind`. */
export function isValidAgentSessionId(kind: AgentKind, sid: unknown): sid is string {
  return typeof sid === 'string' && AGENTS[kind].idRe.test(sid)
}

/**
 * The launcher flags of `kind` worth keeping, rebuilt from a fixed table: for
 * Jarvis `--effort <level>` (or `--effort=<level>`) and `--business`, each at
 * most once and in a fixed order; nothing for anyone else. Anything not in the
 * table (pi's own flags, `--about <topic>`, a typo) is dropped. [pure]
 */
export function cleanAgentFlags(kind: AgentKind, argv: unknown): string[] {
  if (kind !== 'jarvis' || !Array.isArray(argv)) return []
  let effort: string | undefined
  let business = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (typeof a !== 'string') continue
    if (a === '--') break
    if (a === '--business') business = true
    else if (a === '--effort') {
      const v = argv[i + 1]
      if (typeof v === 'string' && JARVIS_EFFORT.has(v)) effort = v
      i += 1
    } else if (a.startsWith('--effort=')) {
      const v = a.slice('--effort='.length)
      if (JARVIS_EFFORT.has(v)) effort = v
    }
  }
  return [...(effort ? ['--effort', effort] : []), ...(business ? ['--business'] : [])]
}

/**
 * The text a pane restored as `kind` types into its shell: the program, the
 * cleaned flags, and the resume flag with the id when the id passes the
 * allowlist; a fresh launch otherwise. Never anything else. [pure]
 */
export function agentLaunchText(kind: AgentKind, sid?: string, flags?: readonly string[]): string {
  const spec = AGENTS[kind]
  const parts = [spec.program, ...cleanAgentFlags(kind, flags ?? [])]
  if (sid !== undefined && isValidAgentSessionId(kind, sid)) parts.push(spec.resumeFlag, sid)
  return parts.join(' ')
}
