/**
 * The changes column beside a zoomed agent pane, Cursor's agent view: what
 * the agent session in the pane created, edited and deleted (main's
 * `changes:*` handlers, src/main/changes/), and a preview of one file at a
 * time in a WebView2 the shell hosts only while it shows.
 *
 * The controller owns the zoom and the layout; this file owns which session
 * the zoomed pane runs, the list, the selection and what the preview page is
 * told. File contents go to the page on `view:cmd`, never in `ui:model`.
 */
import { AGENTS, isAgentKind, isOtherAgentKind, type AgentKind } from '../../shared/agents.js'
import type {
  ChangeEntry,
  ChangesFileResponse,
  ChangesListResponse,
  PaneAgentVerdict,
  ProjectsSessionIdsResponse,
} from '../../shared/ipc.js'
import { lookupPaneFor } from '../../renderer/projects/serialize.js'
import { paneById, type AppState, type PaneState } from '../../renderer/store.js'
import type { ChangeGroupModel, ChangesModel, Rect, ViewCmd, ViewEvent } from './model.js'
import { CHANGES_WIDTH_DEFAULT, clampChangesWidth } from './ui-state.js'

type Invoke = <T = unknown>(ch: string, p: unknown) => Promise<T>

export interface ChangesHost {
  invoke: Invoke
  invokeShell: Invoke
  state(): AppState
  now(): number
  setTimer(fn: () => void, ms: number): () => void
  /** Something the column shows changed. */
  changed(): void
  /** The column appeared, went or was resized: the zoomed pane's grid changes size. */
  relayout(): void
  toast(message: string): void
  viewCmd(cmd: ViewCmd): void
  reveal(path: string, isDir: boolean): Promise<void>
  openWithDefaultApp(path: string): void
  /** The theme's tokens, for the page. */
  tokens(): Record<string, string>
  /** The stored width, and storing a new one (`save` on release). */
  width(): number
  setWidth(w: number, save: boolean): void
}

/** How often a zoomed pane with no agent found yet is looked at again. */
export const DETECT_MS = 5_000
/** How often the list refreshes while a zoomed agent pane shows. */
export const LIST_MS = 2_000
/** How often a found session is checked again (a /clear, a resume, the agent quitting). */
export const REDETECT_MS = 15_000
/** The fewest milliseconds between two links opened from the preview. */
const LINK_GAP_MS = 2_000

/** The column's metrics at uiScale 1, which the shell draws with too. */
export const CHANGES_GRIP_DIP = 6
export const CHANGES_HEADER_DIP = 44
export const CHANGES_NOTE_DIP = 40
export const CHANGES_ROW_DIP = 22
export const CHANGES_GROUP_DIP = 24
/** Above the first group and below the last row (the shell's kPadDip, the renderer's padding). */
export const CHANGES_LIST_PAD_DIP = 4
/** The list keeps at least this much above an open preview. */
const LIST_MIN_DIP = 96

export interface TrackedSession {
  kind: AgentKind
  sid?: string
  cwd: string
}

/** The agent session main proved running in `pane`, from one lookup answer. [pure] */
export function sessionFromLookup(res: ProjectsSessionIdsResponse | null, pane: PaneState): TrackedSession | null {
  if (!res) return null
  const v: PaneAgentVerdict | undefined = res.agents?.[pane.id]
  // The agent's own directory when main could read it: the pane's shell
  // reports its cwd only where shell integration runs, and an agent may have
  // been started somewhere else.
  if (v && v.source === 'process' && isOtherAgentKind(v.kind)) {
    return { kind: v.kind, ...(v.sid ? { sid: v.sid } : {}), cwd: absolute(v.cwd) ?? pane.cwd }
  }
  const src = res.sources?.[pane.id]
  const sid = res.ids?.[pane.id]
  if ((src === 'process' || src === 'registry') && typeof sid === 'string') {
    return { kind: 'claude', sid, cwd: absolute(res.cwds?.[pane.id]) ?? pane.cwd }
  }
  return null
}

function absolute(p: unknown): string | undefined {
  return typeof p === 'string' && p.startsWith('/') ? p : undefined
}

function sameSession(a: TrackedSession | null, b: TrackedSession | null): boolean {
  return a?.kind === b?.kind && a?.sid === b?.sid && a?.cwd === b?.cwd
}

const GROUPS: ReadonlyArray<{ id: ChangeEntry['change']; label: string }> = [
  { id: 'created', label: 'Created' },
  { id: 'edited', label: 'Edited' },
  { id: 'deleted', label: 'Deleted' },
]

const SOURCE_TEXT: Readonly<Record<ChangeEntry['source'], string>> = {
  agent: 'written by the agent',
  fs: 'seen in the folder',
  both: 'written by the agent, seen in the folder',
}

/** The groups the column draws, newest first inside each. [pure] */
export function changeGroups(entries: readonly ChangeEntry[], selected: string | null, folded: ReadonlySet<string>): ChangeGroupModel[] {
  return GROUPS.flatMap(({ id, label }) => {
    const mine = entries.filter((e) => e.change === id)
    if (mine.length === 0) return []
    return [
      {
        id,
        label,
        count: mine.length,
        folded: folded.has(id),
        rows: mine.map((e) => {
          const cut = e.rel.lastIndexOf('/')
          const binary = e.added === 0 && e.removed === 0 && e.change === 'edited'
          return {
            id: `row:${e.path}`,
            path: e.path,
            name: cut >= 0 ? e.rel.slice(cut + 1) : e.rel,
            dir: cut >= 0 ? e.rel.slice(0, cut) : '',
            change: e.change,
            stat: binary ? '' : `+${e.added} -${e.removed}`,
            added: e.added,
            removed: e.removed,
            tooltip: `${e.path}\n${SOURCE_TEXT[e.source]}`,
            selected: e.path === selected,
          }
        }),
      },
    ]
  })
}

/** Whether a text color is dark enough that the theme is a light one. [pure] */
function isLight(hex: string | undefined): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return false
  const n = parseInt(m[1]!, 16)
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  return lum > 0.5
}

/** The theme as the preview page takes it. [pure] */
export function pageTheme(t: Record<string, string>): Record<string, string | number | boolean> {
  const bg = t.panel ?? '#18191B'
  return {
    bg,
    fg: t.titleText ?? '#E4E5E7',
    dim: t.badgeText ?? '#A8ABB2',
    header: t.titleBar ?? bg,
    border: t.panelBorder ?? '#34353A',
    accent: t.accent ?? '#2563EB',
    accentText: t.accentText ?? '#FFFFFF',
    danger: t.danger ?? '#FF5F56',
    selection: t.selection ?? '#3399FF',
    button: t.badge ?? '#2E2F33',
    buttonText: t.badgeText ?? '#E4E5E7',
    radius: Number(t.radius ?? '6') || 6,
    light: isLight(bg),
  }
}

export class ChangesPanel {
  private readonly host: ChangesHost
  /** The zoomed terminal pane of the active tab, or null. */
  private paneId: string | null = null
  private session: TrackedSession | null = null
  private detecting = false
  private list: ChangesListResponse | null = null
  /** The user's own choice per pane, which outranks showing on the first change. */
  private readonly choice = new Map<string, boolean>()
  /** Panes whose column should open as soon as an agent is found there (the chord on a pane not yet zoomed). */
  private readonly wantOpen = new Set<string>()
  private readonly folded = new Set<string>()
  private selected: string | null = null
  private file: Extract<ChangesFileResponse, { ok: true }> | null = null
  private fileLoading = false
  private fileSeq = 0
  private previewSeq = 0
  private rowsSeq = 0
  private rowsKey = ''
  private gripDrag: { area: Rect } | null = null
  private lastLinkAt = Number.NEGATIVE_INFINITY
  private cancelDetect: (() => void) | null = null
  private cancelList: (() => void) | null = null
  /** Bumped whenever the pane changes, so answers for the last one are dropped. */
  private gen = 0

  constructor(host: ChangesHost) {
    this.host = host
  }

  /** Whether the column shows now. */
  visible(): boolean {
    if (!this.paneId || !this.session) return false
    const chosen = this.choice.get(this.paneId)
    return chosen ?? (this.list?.entries.length ?? 0) > 0
  }

  /** The zoomed pane this column belongs to, while it has an agent session. */
  agentPane(): string | null {
    return this.session ? this.paneId : null
  }

  /**
   * Follows the active tab's zoomed pane; the controller calls it after every
   * state change. A new pane starts over: no session, no list, no preview.
   */
  follow(): void {
    const s = this.host.state()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    const z = tab?.zoomedPaneId ? tab.panes[tab.zoomedPaneId] : undefined
    const id = z && z.kind === 'term' ? z.id : null
    if (id === this.paneId) return
    const wasVisible = this.visible()
    this.stop()
    this.gen += 1
    this.paneId = id
    this.session = null
    this.list = null
    this.selected = null
    this.file = null
    this.fileLoading = false
    this.rowsSeq += 1
    if (id) void this.detect()
    if (wasVisible) this.host.relayout()
  }

  /** Stops every timer (the pane left, or the controller is going). */
  stop(): void {
    this.cancelDetect?.()
    this.cancelDetect = null
    this.cancelList?.()
    this.cancelList = null
  }

  /** The chord, or the title bar button: show or hide the column of `paneId` (zoomed already, or about to be). */
  toggle(paneId: string): void {
    if (paneId !== this.paneId) {
      this.wantOpen.add(paneId)
      return
    }
    if (!this.session) {
      if (this.detecting) this.wantOpen.add(paneId)
      else this.host.toast('No agent session is running in this pane')
      return
    }
    const next = !this.visible()
    this.choice.set(paneId, next)
    if (!next) this.closePreview(false)
    this.rowsSeq += 1
    this.host.relayout()
  }

  private hide(): void {
    if (!this.paneId) return
    this.choice.set(this.paneId, false)
    this.closePreview(false)
    this.host.relayout()
  }

  private async detect(): Promise<void> {
    const gen = this.gen
    const id = this.paneId
    const pane = id ? paneById(this.host.state(), id) : undefined
    if (!id || !pane) return
    this.detecting = true
    let res: ProjectsSessionIdsResponse | null = null
    try {
      res = await this.host.invoke<ProjectsSessionIdsResponse>('projects:sessionIds', { panes: [lookupPaneFor(pane)] })
    } catch {
      res = null
    }
    if (gen !== this.gen) return
    this.detecting = false
    const found = sessionFromLookup(res && typeof res === 'object' ? res : null, pane)
    const wasVisible = this.visible()
    if (!sameSession(found, this.session)) {
      this.session = found
      this.list = null
      this.closePreview(false)
      this.rowsSeq += 1
      if (found) {
        try {
          await this.host.invoke('changes:watch', { paneId: id, ...found })
        } catch {
          /* the list says nothing until main answers */
        }
        if (gen !== this.gen) return
        if (this.wantOpen.delete(id)) this.choice.set(id, true)
        await this.refresh()
        if (gen !== this.gen) return
      } else if (this.wantOpen.delete(id)) {
        this.host.toast('No agent session is running in this pane')
      }
    } else if (!found && this.wantOpen.delete(id)) {
      this.host.toast('No agent session is running in this pane')
    }
    if (this.visible() !== wasVisible) this.host.relayout()
    else this.host.changed()
    this.cancelDetect?.()
    this.cancelDetect = this.host.setTimer(() => void this.detect(), found ? REDETECT_MS : DETECT_MS)
    if (found && !this.cancelList) this.armList()
    if (!found) {
      this.cancelList?.()
      this.cancelList = null
    }
  }

  private armList(): void {
    this.cancelList = this.host.setTimer(() => {
      this.cancelList = null
      void this.refresh().then(() => {
        if (this.session && !this.cancelList) this.armList()
      })
    }, LIST_MS)
  }

  private async refresh(): Promise<void> {
    const gen = this.gen
    const id = this.paneId
    if (!id || !this.session) return
    let res: ChangesListResponse | null = null
    try {
      res = await this.host.invoke<ChangesListResponse | null>('changes:list', { paneId: id })
    } catch {
      return
    }
    if (gen !== this.gen) return
    if (res === null) {
      // main lost the session (a restarted core): watch it again.
      try {
        await this.host.invoke('changes:watch', { paneId: id, ...this.session })
      } catch {
        /* next round */
      }
      return
    }
    if (!Array.isArray(res.entries)) return
    const wasVisible = this.visible()
    const key = JSON.stringify([res.entries, res.note])
    const before = this.list?.entries.find((e) => e.path === this.selected)
    this.list = res
    if (key !== this.rowsKey) {
      this.rowsKey = key
      this.rowsSeq += 1
    }
    if (this.selected) {
      const now = res.entries.find((e) => e.path === this.selected)
      if (!now) this.closePreview(false)
      else if (!before || before.at !== now.at || before.change !== now.change || before.added !== now.added || before.removed !== now.removed) {
        void this.loadFile(this.selected)
      }
    }
    if (this.visible() !== wasVisible) this.host.relayout()
    else this.host.changed()
  }

  /** The zoomed pane's rect and the column's, when the column shows; null otherwise. */
  split(area: Rect, uiScale: number): { pane: Rect; column: Rect; grip: Rect } | null {
    if (!this.visible()) return null
    const w = Math.round(area.w * clampChangesWidth(this.host.width()))
    const grip = CHANGES_GRIP_DIP
    const colX = area.x + area.w - w
    void uiScale
    return {
      pane: { x: area.x, y: area.y, w: Math.max(0, colX - grip - area.x), h: area.h },
      grip: { x: colX - grip, y: area.y, w: grip, h: area.h },
      column: { x: colX, y: area.y, w, h: area.h },
    }
  }

  model(area: Rect | null, uiScale: number): ChangesModel | null {
    if (!area || !this.paneId) return null
    const sp = this.split(area, uiScale)
    if (!sp) return null
    const col = sp.column
    const entries = this.list?.entries ?? []
    const note = this.list?.note ?? null
    const headerH = CHANGES_HEADER_DIP * uiScale
    const noteH = note ? CHANGES_NOTE_DIP * uiScale : 0
    const top = col.y + headerH + noteH
    const avail = Math.max(0, col.y + col.h - top)
    const groups = changeGroups(entries, this.selected, this.folded)
    const showing = this.selected !== null
    let listH = avail
    if (showing) {
      const want =
        groups.reduce((n, g) => n + CHANGES_GROUP_DIP * uiScale + (g.folded ? 0 : g.rows.length * CHANGES_ROW_DIP * uiScale), 0) +
        2 * CHANGES_LIST_PAD_DIP * uiScale
      listH = Math.min(Math.max(LIST_MIN_DIP * uiScale, Math.min(want, avail * 0.4)), avail)
    }
    const listRect = { x: col.x, y: top, w: col.w, h: listH }
    const added = entries.reduce((n, e) => n + e.added, 0)
    const removed = entries.reduce((n, e) => n + e.removed, 0)
    const label = this.session ? AGENTS[this.session.kind].label : ''
    return {
      paneId: this.paneId,
      rect: col,
      gripRect: sp.grip,
      width: clampChangesWidth(this.host.width()),
      title: 'Changes',
      subtitle: `${label} · ${entries.length} file${entries.length === 1 ? '' : 's'}`,
      totals: entries.length > 0 ? `+${added} -${removed}` : '',
      note,
      empty: entries.length === 0 ? 'No changes yet' : null,
      listRect,
      groups,
      rowsSeq: this.rowsSeq,
      headerH,
      rowH: CHANGES_ROW_DIP * uiScale,
      groupH: CHANGES_GROUP_DIP * uiScale,
      preview:
        showing && this.selected
          ? { rect: { x: col.x, y: top + listH + 1, w: col.w, h: Math.max(0, avail - listH - 1) }, path: this.selected, seq: this.previewSeq }
          : null,
    }
  }

  /** `changes:<rest>` and `pane:<id>:changes`. `area` is the grid area, for the grip. */
  event(rest: string, e: { type: string; x?: number; button?: number }, area: Rect | null): void {
    if (rest === 'grip') {
      if (e.type === 'dblclick') {
        this.host.setWidth(CHANGES_WIDTH_DEFAULT, true)
        return
      }
      if (e.type === 'down' && e.button === 0 && area) this.gripDrag = { area }
      else if ((e.type === 'move' || e.type === 'up') && this.gripDrag && typeof e.x === 'number') {
        const a = this.gripDrag.area
        const w = (a.x + a.w - e.x) / Math.max(1, a.w)
        this.host.setWidth(clampChangesWidth(w), e.type === 'up')
        if (e.type === 'up') this.gripDrag = null
      }
      return
    }
    if (e.type !== 'click' && e.type !== 'dblclick') return
    if (e.button !== undefined && e.button !== 0) return
    if (rest === 'hide') {
      if (e.type === 'click') this.hide()
      return
    }
    if (rest.startsWith('group:')) {
      if (e.type !== 'click') return
      const g = rest.slice('group:'.length)
      if (this.folded.has(g)) this.folded.delete(g)
      else this.folded.add(g)
      this.rowsSeq += 1
      this.host.changed()
      return
    }
    if (rest.startsWith('row:')) {
      const p = rest.slice('row:'.length)
      const entry = this.list?.entries.find((x) => x.path === p)
      if (!entry) return
      if (e.type === 'dblclick') {
        if (entry.change !== 'deleted') this.host.openWithDefaultApp(p)
        return
      }
      if (this.selected === p) return
      this.selected = p
      this.file = null
      this.rowsSeq += 1
      void this.loadFile(p)
      this.host.changed()
    }
  }

  private closePreview(emit = true): void {
    if (this.selected === null && this.file === null) return
    this.selected = null
    this.file = null
    this.fileLoading = false
    this.fileSeq += 1
    this.rowsSeq += 1
    if (emit) this.host.changed()
  }

  private async loadFile(p: string): Promise<void> {
    const gen = this.gen
    const seq = ++this.fileSeq
    const id = this.paneId
    if (!id) return
    this.fileLoading = true
    this.post({ type: 'loading', path: p })
    let res: ChangesFileResponse | null = null
    try {
      res = await this.host.invoke<ChangesFileResponse>('changes:file', { paneId: id, path: p })
    } catch {
      res = null
    }
    if (gen !== this.gen || seq !== this.fileSeq || this.selected !== p) return
    this.fileLoading = false
    if (!res || !res.ok) {
      this.file = null
      this.post({ type: 'error', path: p, message: res && !res.ok ? res.message : 'The file could not be read' })
      return
    }
    this.file = res
    this.previewSeq += 1
    this.show()
    this.host.changed()
  }

  /** Tells the page what to show (on a load, and again when the page says it is ready). */
  private show(): void {
    const f = this.file
    if (!f) {
      if (this.selected && this.fileLoading) this.post({ type: 'loading', path: this.selected })
      return
    }
    this.post({
      type: 'show',
      seq: this.previewSeq,
      file: {
        path: f.path,
        rel: f.rel,
        change: f.change,
        before: f.before,
        after: f.after,
        beforeKnown: f.beforeKnown,
        binary: f.binary,
        truncated: f.truncated,
        ...(f.image ? { image: f.image } : {}),
      },
    })
  }

  private post(message: Record<string, unknown>): void {
    this.host.viewCmd({ op: 'post', message: { ...message, theme: pageTheme(this.host.tokens()) } })
  }

  /** The theme changed: the page restyles without reloading. */
  themeChanged(): void {
    if (this.selected) this.post({ type: 'theme' })
  }

  /** `view:event` from the shell. */
  view(e: ViewEvent): void {
    if (!e || typeof e !== 'object') return
    if (e.type === 'navigate') {
      this.openLink(e.uri)
      return
    }
    if (e.type !== 'message') return
    const m = e.message as { type?: unknown; action?: unknown; url?: unknown } | null
    if (!m || typeof m !== 'object') return
    if (m.type === 'ready') {
      this.show()
      return
    }
    if (m.type === 'link') {
      this.openLink(m.url)
      return
    }
    if (m.type !== 'action') return
    const f = this.file
    const p = this.selected
    switch (m.action) {
      case 'close':
        this.closePreview()
        break
      case 'open':
        if (p && f?.change !== 'deleted') this.host.openWithDefaultApp(p)
        break
      case 'reveal':
        if (p && f?.change !== 'deleted') void this.host.reveal(p, false)
        break
      case 'copy':
        if (p) {
          void this.host.invokeShell<{ ok?: unknown } | null>('clip:write', { text: p }).then(
            (r) => this.host.toast(r?.ok === true ? 'Copied path' : 'Could not copy the path'),
            () => this.host.toast('Could not copy the path')
          )
        }
        break
      default:
        break
    }
  }

  /** A link in a previewed page: http and https only, in the browser, never faster than one per two seconds. */
  private openLink(raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > 4096) return
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    const now = this.host.now()
    if (now - this.lastLinkAt < LINK_GAP_MS) return
    this.lastLinkAt = now
    void this.host.invoke('open:externalHttp', { url: url.href }).catch(() => undefined)
  }
}

/**
 * The sessions a save lookup proved (claude's process or registry ids, the
 * other agents' process verdicts), to start watching: a session's baseline
 * is the folder as it stood when SeaShell first saw it. [pure]
 */
export function provenSessions(
  state: AppState,
  proven: Readonly<Record<string, string>>,
  agents: Readonly<Record<string, PaneAgentVerdict>>,
  cwds: Readonly<Record<string, string>> = {}
): Array<{ paneId: string } & TrackedSession> {
  const out: Array<{ paneId: string } & TrackedSession> = []
  for (const [paneId, sid] of Object.entries(proven)) {
    const p = paneById(state, paneId)
    if (p && !agents[paneId]) out.push({ paneId, kind: 'claude', sid, cwd: absolute(cwds[paneId]) ?? p.cwd })
  }
  for (const [paneId, v] of Object.entries(agents)) {
    const p = paneById(state, paneId)
    if (p && isAgentKind(v.kind) && v.source === 'process') {
      out.push({ paneId, kind: v.kind, ...(v.sid ? { sid: v.sid } : {}), cwd: absolute(v.cwd) ?? p.cwd })
    }
  }
  return out
}
