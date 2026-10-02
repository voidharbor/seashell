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
// Pane limits
// ---------------------------------------------------------------------------

/**
 * Most terminal panes that can run at once, across every tab.
 *
 * Main enforces it at spawn; the renderer and the projects handlers size their
 * session-id batches to it, so a save or restore never silently drops a pane
 * past the end of a batch. One number, read by both sides, for that reason.
 */
export const MAX_TERM_PANES = 64

/**
 * The shell drawer's pty ids share the PtyManager map with every pane's, so
 * they carry a prefix no pane id has. Drawers do not count against
 * MAX_TERM_PANES: there is at most one per pane, so they get a budget of
 * their own of the same size.
 */
export const DRAWER_PTY_PREFIX = 'drawer:'

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const CH = {
  clipboardWindowsFiles: 'clipboard:windows-files',
  clipboardImage: 'clipboard:image',
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',

  fsReadDir: 'fs:readDir',
  fsStatBatch: 'fs:statBatch',
  fsFindBySuffix: 'fs:findBySuffix',
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
  /** Main to renderer: show this line in the toast. */
  appToast: 'app:toast',

  /** Main to renderer: where the update check has got to. */
  updateState: 'update:state',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  watchSubscribe: 'watch:subscribe',
  watchUnsubscribe: 'watch:unsubscribe',
  watchTouch: 'watch:touch',
  /** Main to renderer: this watched directory's contents changed. */
  watchChanged: 'watch:changed',
  /** Main to renderer: the watch on this directory was dropped (missing, evicted, or errored). */
  watchLost: 'watch:lost',

  linksEnsure: 'links:ensure',
  projectsList: 'projects:list',
  projectsSessionIds: 'projects:sessionIds',
  projectsResumeModes: 'projects:resumeModes',
  projectsSave: 'projects:save',
  projectsDelete: 'projects:delete',
  sessionSave: 'session:save',
  sessionLoad: 'session:load',
  sessionClear: 'session:clear',
  /** Main to renderer: write a snapshot now. Sent once, at quit. */
  sessionRequestSnapshot: 'session:requestSnapshot',
  uiCommand: 'ui:command',

  /** Renderer to main: the window buttons the app draws itself off macOS. */
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',
  /** Main to renderer: the window became, or stopped being, maximized. */
  windowMaximized: 'window:maximized',
  /** Renderer to main: pop the application menu, which has no bar to live in there. */
  windowMenu: 'window:menu',
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
 * Find the files under `root` whose path ends in `suffix`.
 *
 * The other half of a double-clicked path: an agent that shortened a path to
 * `…/renderer/app.tsx` has thrown away everything `statBatch` needs, so the
 * only way back to the file is to search for the tail that survived.
 */
export interface FindBySuffixRequest {
  root: string
  /** Segment-anchored: starts with '/', so `/app.tsx` never matches `myapp.tsx`. */
  suffix: string
  /** Hard-capped at 50 by the main-side validator. */
  limit: number
}

export interface FindBySuffixResponse {
  paths: string[]
  /** The walk stopped early (limit or budget), so `paths` is not the whole answer. */
  truncated: boolean
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
// Live file watching. Keeps the explorer's expanded directories current
// without waiting on a manual refresh.
// ---------------------------------------------------------------------------

export interface WatchDirRequest {
  dir: string
}

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
  /** Null when the platform could not sample system memory this tick; the
   *  status bar keeps its last reading. Pane metrics are sent regardless. */
  system: SystemMetrics | null
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

/** Main telling the renderer the maximized state flipped, so the middle button redraws. */
export interface WindowMaximizedEvent {
  maximized: boolean
}

/** Something main has to say, shown in the renderer's ordinary toast. */
export interface AppToastEvent {
  message: string
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * Where the update check has got to, as one value the banner renders directly.
 *
 * `canInstall` is false when this copy of SeaShell is not the one in
 * /Applications: the swap script only knows how to replace that bundle, so
 * anywhere else the banner offers the release page instead of a download.
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string; pageUrl: string; canInstall: boolean }
  | { phase: 'downloading'; version: string; received: number; total: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; version: string; message: string }

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
  /** Set by builds that resolve session ids from the live claude process and
   *  never guess between panes. Absent on anything older, whose ids may have
   *  been handed out by recency and are checked against each pane's title
   *  before they are resumed. */
  sessionIdsVerified?: boolean
}

export interface Project {
  id: string
  name: string
  /** ISO timestamp of the last save. */
  savedAt: string
  tabs: SavedTab[]
}

/** Where the shared notes for a link group live, or null if it could not be
 *  created. The renderer never composes this path itself. */
export interface LinksEnsureRequest {
  linkId: string
}
export interface LinksEnsureResponse {
  path: string | null
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
  /** Panes to resolve; capped to the pane limit. See
   *  src/main/state/session-lookup.ts for what each field feeds. */
  panes: {
    paneId: string
    cwd: string
    /** The id the pane already has, kept when nothing better answers. */
    knownSid?: string
    /** False for an id from a snapshot an older build wrote (ids guessed). */
    knownVerified?: boolean
    /** The pane's own title, for matching a session by its title. */
    label?: string
    /** Whether the pane is running claude, as far as the renderer knows. */
    claude?: boolean
  }[]
  /** Live panes about to be killed (a project opening over the window); the
   *  sessions in them count as free rather than as live elsewhere. */
  releasing?: string[]
}

/** How an id was resolved; 'process' means a live claude is in the pane now. */
export type SessionIdSource = 'process' | 'registry' | 'carried' | 'title' | 'cwd'

export interface ProjectsSessionIdsResponse {
  /** paneId -> claude session id. */
  ids: Record<string, string>
  sources: Record<string, SessionIdSource>
}

export interface ProjectsResumeModesRequest {
  /** Panes about to resume a session: the transcript for (cwd, sid) is what
   *  records the mode the session was last running in. */
  panes: { paneId: string; cwd: string; sid: string }[]
}

export interface ProjectsResumeModesResponse {
  /** paneId -> the session's last recorded permission mode. A pane with no
   *  recoverable mode is simply absent, and restore types a bare resume. */
  modes: Record<string, string>
  /** The user accepted claude's bypass warning (settings
   *  skipDangerousModePermissionPrompt), so restored panes default to
   *  bypassPermissions; see claudeLaunchMode in renderer/projects/serialize.ts. */
  bypassConsented: boolean
}

export type ProjectsDeleteResponse = { ok: boolean }

// ---------------------------------------------------------------------------
// Last session, the unnamed project the app keeps for you
// ---------------------------------------------------------------------------

/**
 * The window as it last stood. Same tab shape as a project, and for the same
 * reason: what survives a quit is a layout, never a session. It is written on a
 * timer and once more at quit, and offered back on the next launch.
 */
export interface LastSession {
  schemaVersion: 1
  savedAt: string
  tabs: SavedTab[]
}

export interface SessionSaveRequest {
  tabs: SavedTab[]
}

// ---------------------------------------------------------------------------
// The preload surface, as seen by the renderer on `window.seashell`
// ---------------------------------------------------------------------------

export interface SeashellApi {
  /** process.platform of the host, so the renderer spells its chords the way the menu does. */
  platform: string
  /** Paths for files dropped onto the window (empty string when unavailable). */
  files: {
    pathFor(file: File): string
    /** Files copied in Windows Explorer (WSL only), as Windows paths; [] elsewhere. */
    windowsClipboard(): Promise<string[]>
    /** An image on the clipboard saved as a PNG, its path; '' when there is none.
     *  Linux and WSL only, so the Mac's paste is unchanged. */
    clipboardImage(): Promise<string>
  }
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
    findBySuffix(req: FindBySuffixRequest): Promise<FindBySuffixResponse>
    probe(req: FsProbeRequest): Promise<FsProbeResponse>
    readTextFile(req: FsReadTextFileRequest): Promise<FsReadTextFileResponse>
    writeTextFile(req: FsWriteTextFileRequest): Promise<FsWriteTextFileResponse>
    readImageFile(req: FsReadImageFileRequest): Promise<FsReadImageFileResponse>
  }
  watch: {
    /** Fire and forget: start reporting changes to this directory. */
    subscribe(req: WatchDirRequest): void
    /** Fire and forget: stop reporting changes to this directory. */
    unsubscribe(req: WatchDirRequest): void
    /** Fire and forget: mark this directory as recently used, so it survives
     *  eviction ahead of directories nobody has looked at in a while. */
    touch(req: WatchDirRequest): void
    onChanged(cb: (e: WatchDirRequest) => void): () => void
    onLost(cb: (e: WatchDirRequest) => void): () => void
  }
  open: {
    withDefaultApp(req: OpenPathRequest): Promise<OpenPathResponse>
    revealInFinder(req: OpenPathRequest): Promise<OpenPathResponse>
    externalHttp(req: OpenExternalHttpRequest): Promise<OpenPathResponse>
  }
  metrics: {
    onTick(cb: (e: MetricsTickEvent) => void): () => void
  }
  links: {
    /** Create (or find) the shared notes file for a link group. */
    ensure(req: LinksEnsureRequest): Promise<LinksEnsureResponse>
  }
  projects: {
    list(): Promise<ProjectsListResponse>
    sessionIds(req: ProjectsSessionIdsRequest): Promise<ProjectsSessionIdsResponse>
    /** Last recorded permission mode per session about to be resumed. */
    resumeModes(req: ProjectsResumeModesRequest): Promise<ProjectsResumeModesResponse>
    save(req: ProjectsSaveRequest): Promise<ProjectsSaveResponse>
    remove(req: ProjectsDeleteRequest): Promise<ProjectsDeleteResponse>
  }
  session: {
    save(req: SessionSaveRequest): Promise<void>
    load(): Promise<LastSession | null>
    clear(): Promise<void>
    /** Main asking for a snapshot now, because the app is about to quit. */
    onRequestSnapshot(cb: () => void): () => void
  }
  app: {
    getPaths(): Promise<AppPaths>
    /** Terminal.app's private SF Mono Terminal face, or null if unreadable. */
    getTerminalFont(): Promise<ArrayBuffer | null>
    onCommand(cb: (e: UiCommandEvent) => void): () => void
    onToast(cb: (e: AppToastEvent) => void): () => void
  }
  update: {
    onState(cb: (s: UpdateState) => void): () => void
    /** Both are fire and forget: the answer arrives as the next state event. */
    download(): void
    install(): void
  }
  /**
   * The window frame, off macOS only. There the window is frameless (see
   * shared/window-chrome.ts) and these are what the three buttons and the
   * ≡ button do. On macOS the OS owns all of this and nothing calls them.
   */
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximized(cb: (e: WindowMaximizedEvent) => void): () => void
    /** Pops the application menu under the ≡ button. */
    menu(): void
  }
}

declare global {
  interface Window {
    seashell: SeashellApi
  }
}
