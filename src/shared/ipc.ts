/**
 * The IPC contract between main and renderer.
 *
 * This file is the single source of truth for channel names and payload shapes.
 * It imports nothing — both processes and the preload bridge depend on it, and
 * the preload runs in a sandbox where `electron` is the only available import.
 *
 * Rule: no function in the preload surface ever takes a channel name. The
 * renderer cannot reach a channel that is not explicitly wrapped.
 */

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const CH = {
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',

  fsReadDir: 'fs:readDir',
  fsStatBatch: 'fs:statBatch',
  fsProbe: 'fs:probe',
  fsReadTextFile: 'fs:readTextFile',
  fsWriteTextFile: 'fs:writeTextFile',
  fsReadImageFile: 'fs:readImageFile',

  openWithDefaultApp: 'open:withDefaultApp',
  openRevealInFinder: 'open:revealInFinder',
  openExternalHttp: 'open:externalHttp',

  metricsTick: 'metrics:tick',

  appGetPaths: 'app:getPaths',
  appGetTerminalFont: 'app:getTerminalFont',

  projectsList: 'projects:list',
  projectsSessionIds: 'projects:sessionIds',
  projectsSave: 'projects:save',
  projectsDelete: 'projects:delete',
  uiCommand: 'ui:command',

  lookoutCards: 'lookout:cards',
  lookoutDetected: 'lookout:detected',
  lookoutAction: 'lookout:action',
  lookoutGetState: 'lookout:getState',
  lookoutSetEnabled: 'lookout:setEnabled',
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export type Ok<T> = { ok: true } & T
export type Err<C extends string = string> = { ok: false; code: C; message: string }
export type Result<T, C extends string = string> = Ok<T> | Err<C>

// ---------------------------------------------------------------------------
// PTY
// ---------------------------------------------------------------------------

export interface PtySpawnRequest {
  paneId: string
  /** Absolute path to the binary. Never a shell string. */
  file: string
  /** Always an argv array — never concatenated into a command line. */
  args: string[]
  cwd: string
  cols: number
  rows: number
}

export type PtySpawnResponse = Result<{ pid: number }, 'ENOENT' | 'EACCES' | 'ECWD' | 'ELIMIT'>

export interface PtyWriteRequest {
  paneId: string
  data: string
}

export interface PtyResizeRequest {
  paneId: string
  cols: number
  rows: number
}

export interface PtyKillRequest {
  paneId: string
}

/** Result of running the escalating kill ladder. `survivors` should be 0. */
export interface PtyKillResponse {
  ok: boolean
  survivors: number
}

/**
 * PTY output, coalesced across panes into one frame-batched message.
 * Batching matters: a build log can emit thousands of tiny writes per second,
 * and one IPC message per write starves the renderer.
 */
export interface PtyDataEvent {
  batches: Array<{ paneId: string; data: string }>
}

export interface PtyExitEvent {
  paneId: string
  exitCode: number
  signal: number | null
  ranMs: number
}

// ---------------------------------------------------------------------------
// Filesystem (read-only — there is deliberately no write/delete/rename/mkdir)
// ---------------------------------------------------------------------------

export interface FsDirEntry {
  name: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtimeMs: number
  /** Matched by .gitignore. Kept in the payload so the UI can dim rather than hide. */
  ignored: boolean
}

export interface FsReadDirRequest {
  path: string
  respectGitignore: boolean
}

export type FsReadDirResponse = Result<
  { entries: FsDirEntry[]; truncated: boolean },
  'ENOENT' | 'EACCES' | 'ENOTDIR' | 'ELOOP'
>

/**
 * Bulk-verify path candidates found in terminal output. Misses are omitted
 * rather than returned as nulls, so a screen full of prose costs almost nothing.
 */
export interface FsStatBatchRequest {
  cwd: string
  /** Hard-capped at 512 by the main-side validator. */
  candidates: string[]
}

export interface FsStatBatchResult {
  /** Index into the request's `candidates` array. */
  i: number
  resolved: string
  kind: 'file' | 'dir' | 'other'
  size: number
  exec: boolean
}

export interface FsStatBatchResponse {
  results: FsStatBatchResult[]
}

/**
 * How a path should be opened.
 * - `viewer`    text/code — opens in the in-app read-only viewer
 * - `os`        hand to the macOS default app via shell.openPath
 * - `reveal`    refuse to open; reveal in Finder instead (executables, bundles)
 * - `too-large` exceeds the viewer size guard
 * - `binary`    no extension and non-text content sniffed
 */
export type OpenRoute = 'viewer' | 'os' | 'reveal' | 'too-large' | 'binary'

export interface FsProbeRequest {
  path: string
}

export interface FsProbeResponse {
  exists: boolean
  isDir: boolean
  size: number
  ext: string
  route: OpenRoute
}

export interface FsReadTextFileRequest {
  path: string
  maxBytes: number
}

export type FsReadTextFileResponse = Result<
  /** mtimeMs feeds the editor's expectedMtimeMs on save — the no-clobber check. */
  { text: string; lines: number; size: number; truncated: boolean; mtimeMs: number },
  'EBINARY' | 'ETOOBIG' | 'ENOENT' | 'EACCES'
>

export interface FsWriteTextFileRequest {
  path: string
  text: string
  /** The mtime the caller loaded the file at. The write is refused when the
   *  file on disk no longer carries it — no clobbering outside edits. */
  expectedMtimeMs: number
}

export type FsWriteTextFileResponse = Result<
  { mtimeMs: number },
  'ECONFLICT' | 'EBINARY' | 'ESCOPE' | 'ETOOBIG' | 'ENOENT' | 'EACCES'
>

export interface FsReadImageFileRequest {
  path: string
}

/**
 * An image for the preview pane, as a base64 data payload.
 *
 * A data: URL rather than a file:// src or a blob: URL, because the renderer's
 * CSP is `img-src 'self' data:` — file:// would be blocked outright, and
 * widening the CSP to load pictures would undo the reason the renderer is
 * served from its own privileged origin in the first place.
 *
 * `mime` is chosen from a fixed allowlist keyed on extension, never sniffed
 * from or echoed out of the file, so the value interpolated into the data: URL
 * is always one of a handful of known-good constants.
 */
export type FsReadImageFileResponse = Result<
  { base64: string; mime: string; size: number },
  'ETOOBIG' | 'ENOENT' | 'EACCES' | 'EUNSUPPORTED'
>

// ---------------------------------------------------------------------------
// Opening things
// ---------------------------------------------------------------------------

export interface OpenPathRequest {
  path: string
}

export type OpenPathResponse = { ok: boolean; error?: string }

export interface OpenExternalHttpRequest {
  /** Rejected unless the scheme is exactly http: or https:. */
  url: string
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * What a pane's foreground process is doing.
 * - `PROMPT`  shell is foreground — sitting at a prompt, nothing running
 * - `BUSY`    a child is foreground and either burning CPU or still painting
 * - `WAITING` a child is foreground and has gone completely still
 *
 * Idle detection cannot key on output alone — an animated spinner emits bytes
 * continuously while doing nothing — nor on CPU alone, because an agent waiting
 * on a network round trip is as cheap as an agent waiting on you. `WAITING`
 * means both signals are quiet at once. See `main/monitor/activity.ts`.
 *
 * Note this is one sample, not a verdict: a single quiet sample is not a
 * request for attention. The renderer requires it to persist before anything
 * glows — see `renderer/panes/attention.ts`.
 */
export type PaneActivity = 'PROMPT' | 'BUSY' | 'WAITING'

export interface PaneMetrics {
  paneId: string
  /** Summed RSS of the whole process subtree. See the caveats in the spec. */
  footprintBytes: number
  cpuFrac: number
  state: PaneActivity
  foregroundProcess: string
  procCount: number
  cwd: string
}

export interface SystemMetrics {
  usedBytes: number
  totalBytes: number
  compressorBytes: number
  swapUsedBytes: number
  swapTotalBytes: number
  pressureLevel: 'normal' | 'warn' | 'critical'
}

export interface MetricsTickEvent {
  panes: PaneMetrics[]
  system: SystemMetrics
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export interface AppPaths {
  home: string
  /** The machine's own hostname, for deciding whether an OSC 7 working
   *  directory describes this filesystem or a remote one over SSH. */
  hostname: string
  userData: string
  defaultShell: string
  cwdOfLaunch: string
}

/** Menu accelerators are delivered here — they fire regardless of DOM focus. */
export interface UiCommandEvent {
  command: string
}

// ---------------------------------------------------------------------------
// Projects — named, reopenable sets of tabs and panes
// ---------------------------------------------------------------------------

/**
 * A project stores a *shape*, never a session. No pid, no scrollback, no
 * environment: those describe processes, and processes die with the app. What
 * comes back is which tabs existed, how they were split, each pane's directory
 * and what it had been launched as.
 */
export interface SavedPane {
  label: string
  labelIsCustom: boolean
  kind: 'term' | 'file' | 'web'
  command: 'zsh' | 'claude' | 'cmd'
  commandText?: string
  cwd: string
  color?: string
  filePath?: string
  url?: string
  /** For a 'claude' pane: the session id to resume on open, captured from the
   *  session registry at save time. Restore types `claude -r <id>` visibly
   *  into the pane's shell; a dead id fails soft into that same shell. */
  claudeSessionId?: string
}

export interface SavedTab {
  id: string
  name: string
  nameIsCustom: boolean
  cwd: string
  zoomedPaneId: string | null
  focusedPaneId: string | null
  tree: unknown
  panes: Record<string, SavedPane>
}

export interface Project {
  id: string
  name: string
  /** ISO timestamp of the last save. */
  savedAt: string
  tabs: SavedTab[]
}

export interface ProjectsListResponse {
  projects: Project[]
}

export interface ProjectsSaveRequest {
  /** Existing id to overwrite, or omitted to create a new project. */
  id?: string
  name: string
  tabs: SavedTab[]
}

export type ProjectsSaveResponse = Result<{ project: Project }, 'EINVALID' | 'EWRITE' | 'ELIMIT'>

export interface ProjectsDeleteRequest {
  id: string
}

export interface ProjectsSessionIdsRequest {
  /** Live panes to resolve; capped to the pane limit. The cwd is what lets a
   *  pane the session registry missed still be matched to a claude transcript. */
  panes: { paneId: string; cwd: string }[]
}

export interface ProjectsSessionIdsResponse {
  /** paneId -> claude session id, for panes with a live registered session. */
  ids: Record<string, string>
}

export type ProjectsDeleteResponse = { ok: boolean }

// ---------------------------------------------------------------------------
// Lookout — card-based decision system
// ---------------------------------------------------------------------------

export interface LookoutCard {
  id: string
  paneId: string
  source: 'detector' | 'push'
  /** The screen shape the card was born from. A 'selector' card is look-only
   *  for its whole life: typed text + Enter on a picker blind-confirms the
   *  highlighted option, so approve refuses it in main regardless of what the
   *  renderer currently reads. */
  kind: 'input' | 'selector'
  question: string
  draft: string | null
  state: 'active' | 'stale'
  createdAt: number
}

export interface LookoutCardsEvent {
  cards: LookoutCard[]
}

export interface LookoutDetectedRequest {
  paneId: string
  question: string
  /** What extractQuestion read the screen as at detection time. */
  kind: 'input' | 'selector'
}

export interface LookoutActionRequest {
  cardId: string
  action: 'approve' | 'dismiss'
  /** approve only: the exact text to send — canned word, draft, or edited draft. */
  text?: string
}

export type LookoutActionResponse = Result<
  { delivered: boolean },
  'ENOTFOUND' | 'ESTALE' | 'EGONE' | 'EFOREGROUND' | 'EINVALID' | 'ESELECTOR'
>

export interface LookoutState {
  pluginInstalled: boolean
  enabled: boolean
}

// ---------------------------------------------------------------------------
// The preload surface, as seen by the renderer on `window.seashell`
// ---------------------------------------------------------------------------

export interface SeashellApi {
  pty: {
    spawn(req: PtySpawnRequest): Promise<PtySpawnResponse>
    kill(req: PtyKillRequest): Promise<PtyKillResponse>
    write(req: PtyWriteRequest): void
    resize(req: PtyResizeRequest): void
    onData(cb: (e: PtyDataEvent) => void): () => void
    onExit(cb: (e: PtyExitEvent) => void): () => void
  }
  fs: {
    readDir(req: FsReadDirRequest): Promise<FsReadDirResponse>
    statBatch(req: FsStatBatchRequest): Promise<FsStatBatchResponse>
    probe(req: FsProbeRequest): Promise<FsProbeResponse>
    readTextFile(req: FsReadTextFileRequest): Promise<FsReadTextFileResponse>
    writeTextFile(req: FsWriteTextFileRequest): Promise<FsWriteTextFileResponse>
    readImageFile(req: FsReadImageFileRequest): Promise<FsReadImageFileResponse>
  }
  open: {
    withDefaultApp(req: OpenPathRequest): Promise<OpenPathResponse>
    revealInFinder(req: OpenPathRequest): Promise<OpenPathResponse>
    externalHttp(req: OpenExternalHttpRequest): Promise<OpenPathResponse>
  }
  metrics: {
    onTick(cb: (e: MetricsTickEvent) => void): () => void
  }
  projects: {
    list(): Promise<ProjectsListResponse>
    sessionIds(req: ProjectsSessionIdsRequest): Promise<ProjectsSessionIdsResponse>
    save(req: ProjectsSaveRequest): Promise<ProjectsSaveResponse>
    remove(req: ProjectsDeleteRequest): Promise<ProjectsDeleteResponse>
  }
  app: {
    getPaths(): Promise<AppPaths>
    /** Terminal.app's private SF Mono Terminal face, or null if unreadable. */
    getTerminalFont(): Promise<ArrayBuffer | null>
    onCommand(cb: (e: UiCommandEvent) => void): () => void
  }
  lookout: {
    onCards(cb: (e: LookoutCardsEvent) => void): () => void
    detected(req: LookoutDetectedRequest): void
    action(req: LookoutActionRequest): Promise<LookoutActionResponse>
    getState(): Promise<LookoutState>
    setEnabled(enabled: boolean): void
  }
}

declare global {
  interface Window {
    seashell: SeashellApi
  }
}
