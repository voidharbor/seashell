/**
 * Projects: save, open, add and delete named sets of tabs and panes
 * (inventory row N), ported from `app.tsx` (refreshProjects 182-185,
 * saveProject 514-563, restoreProjectTabs 649-692 through session.ts,
 * addProject 694-718, openProject 720-749, deleteProject 803-810, the
 * commands 961-973) and the panel state of `ProjectsPanel.tsx` (name, scope,
 * the inline delete confirm). The controller owns whether the sheet is up;
 * this file owns what it shows (`projectsSheet` in sheets.ts) and what its
 * buttons do.
 */
import { stateToTabs, tabToSaved } from '../../renderer/projects/serialize.js'
import { isTerm, type Action, type AppState, type TabState } from '../../renderer/store.js'
import type { Project, ProjectsListResponse, ProjectsSaveResponse, PtyKillResponse } from '../../shared/ipc.js'
import type { SheetModel, UiEvent } from './model.js'
import { collectSaveLookup, restoreSavedTabs } from './session.js'
import { PROJECT_NAME_MAX, projectsSheet, type SaveScope } from './sheets.js'

type Invoke = <T = unknown>(ch: string, p: unknown) => Promise<T>

export interface ProjectsHost {
  invoke: Invoke
  state(): AppState
  dispatch(action: Action): void
  toast(message: string): void
  /** Open and Add close the sheet, as they close the panel (app.tsx:708, 745). */
  closeSheet(): void
  /** Something the sheet shows changed. */
  changed(): void
  mintId(prefix: string): string
  /** Ms since the epoch, for `saved <ago>`. */
  now(): number
}

/** The name as the panel's input holds it: no control characters, at most 60 (`maxLength={60}`). */
function cleanName(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, PROJECT_NAME_MAX)
}

function isProject(p: unknown): p is Project {
  const x = p as Partial<Project> | null
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.savedAt === 'string' && Array.isArray(x.tabs)
}

export class Projects {
  private readonly host: ProjectsHost
  private projects: Project[] = []
  /** app.tsx:119 `projectsScope`: the scope the sheet opens on; `app.projects` keeps the last one set. */
  private defaultScope: SaveScope = 'window'
  /** ProjectsPanel's own state, fresh on every open (the panel mounts while open). */
  private scope: SaveScope = 'window'
  private name = ''
  private nameRev = 0
  private confirmDelete: string | null = null
  /**
   * app.tsx:464: the project this window was opened from or last saved as at
   * window scope; it arms `Save “<name>”`. A tab-scope save never adopts one
   * (app.tsx:522-527).
   */
  currentProject: { id: string; name: string } | null = null
  private listSeq = 0

  constructor(host: ProjectsHost) {
    this.host = host
  }

  /** The sheet opened (app.tsx:961-973, 187-189): fresh panel state on `scope`, and the list read again. */
  opened(scope?: SaveScope): void {
    if (scope) this.defaultScope = scope
    this.scope = this.defaultScope
    this.name = ''
    this.nameRev++
    this.confirmDelete = null
    void this.refreshProjects()
  }

  sheet(uiScale: number): SheetModel {
    const s = this.host.state()
    const active = s.tabs.find((t) => t.id === s.activeTabId)
    return projectsSheet(
      {
        projects: this.projects,
        scope: this.scope,
        name: this.name,
        nameRev: this.nameRev,
        confirmDelete: this.confirmDelete,
        currentProject: this.currentProject,
        tabCount: s.tabs.length,
        paneCount: s.tabs.reduce((n, t) => n + Object.keys(t.panes).length, 0),
        activeTabName: active?.name ?? '',
        activeTabPaneCount: active ? Object.keys(active.panes).length : 0,
      },
      this.host.now(),
      uiScale,
    )
  }

  /**
   * One event on `sheet:projects:<rest>`, after the controller took Escape,
   * Done and the dim: the name field (text, Enter saves), the scope buttons,
   * `Save “<current>”`, the save button, and the rows' buttons
   * (`row:<id>:delete|confirm|cancel|add|open`).
   */
  event(rest: string, e: UiEvent): void {
    if (e.type === 'text') {
      if (rest === 'name') {
        this.name = cleanName(e.text)
        this.host.changed()
      }
      return
    }
    if (e.type === 'key') {
      if (rest === 'name' && e.key === 'Enter') this.submit()
      return
    }
    if (e.type !== 'click') return
    if (rest === 'scope:window' || rest === 'scope:tab') {
      this.scope = rest === 'scope:tab' ? 'tab' : 'window'
      this.host.changed()
      return
    }
    if (rest === 'saveCurrent') {
      const cur = this.currentProject
      if (cur && this.scope === 'window') void this.saveProject(cur.name, cur.id)
      return
    }
    if (rest === 'save') {
      this.submit()
      return
    }
    if (!rest.startsWith('row:')) return
    const body = rest.slice('row:'.length)
    const cut = body.lastIndexOf(':')
    if (cut <= 0) return
    const id = body.slice(0, cut)
    const project = this.projects.find((p) => p.id === id)
    if (!project) return
    const confirming = this.confirmDelete === id
    switch (body.slice(cut + 1)) {
      case 'delete':
        if (!confirming) {
          this.confirmDelete = id
          this.host.changed()
        }
        break
      case 'cancel':
        if (confirming) {
          this.confirmDelete = null
          this.host.changed()
        }
        break
      case 'confirm':
        if (confirming) {
          this.confirmDelete = null
          this.host.changed()
          void this.deleteProject(project)
        }
        break
      case 'add':
        if (!confirming) void this.addProject(project)
        break
      case 'open':
        if (!confirming) void this.openProject(project)
        break
      default:
        break
    }
  }

  /** ProjectsPanel `save`: a blank name does nothing; the field clears at once. */
  private submit(): void {
    const trimmed = this.name.trim()
    if (!trimmed) return
    const scope = this.scope
    this.name = ''
    this.nameRev++
    this.host.changed()
    void this.saveProject(trimmed, undefined, scope)
  }

  /** app.tsx:182-185. A failed read keeps the list the sheet already shows. */
  async refreshProjects(): Promise<void> {
    const seq = ++this.listSeq
    let list: Project[] | null = null
    try {
      const res = await this.host.invoke<ProjectsListResponse>('projects:list', undefined)
      if (res && Array.isArray(res.projects)) list = res.projects.filter(isProject)
    } catch {
      /* the list stays as it was */
    }
    if (list === null || seq !== this.listSeq) return
    this.projects = list
    this.host.changed()
  }

  /**
   * app.tsx:514-563: the window, or just the active tab, captured the way the
   * session snapshot is (session ids settled by main first), saved by name.
   */
  async saveProject(name: string, id?: string, scope: SaveScope = 'window'): Promise<void> {
    const state = this.host.state()
    const active = state.tabs.find((t) => t.id === state.activeTabId)
    const { lookup, proven } = await collectSaveLookup(state, this.host.invoke)
    if (Object.keys(proven).length > 0) this.host.dispatch({ type: 'panes.sessionIds', ids: proven })
    const tabs =
      scope === 'tab'
        ? active
          ? [tabToSaved(active, lookup?.ids, lookup?.running)]
          : []
        : stateToTabs(state, lookup?.ids, lookup?.running)
    if (tabs.length === 0) {
      this.host.toast('Nothing to save')
      return
    }
    let res: ProjectsSaveResponse | null = null
    try {
      res = await this.host.invoke<ProjectsSaveResponse>('projects:save', { ...(id ? { id } : {}), name, tabs })
    } catch {
      res = null
    }
    if (!res || !res.ok || !isProject(res.project)) {
      // No reply at all is reported with a code of its own rather than none.
      const code = res && !res.ok && typeof res.code === 'string' ? res.code : 'EIPC'
      this.host.toast(`Could not save project (${code})`)
      return
    }
    const saved = res.project
    if (scope === 'window') this.currentProject = { id: saved.id, name: saved.name }
    await this.refreshProjects()
    this.host.toast(scope === 'tab' ? `Saved tab as “${saved.name}”` : `Saved project “${saved.name}”`)
  }

  /**
   * app.tsx:694-718: the project's tabs alongside what is open; nothing is
   * reaped because nothing is replaced.
   */
  async addProject(project: Project): Promise<void> {
    const restored = await restoreSavedTabs(project.tabs, this.host.invoke, this.host.mintId).catch(() => [] as TabState[])
    if (restored.length === 0) {
      this.host.toast('That project has nothing to add')
      return
    }
    this.host.dispatch({ type: 'tabs.append', tabs: restored })
    this.host.closeSheet()
    this.host.toast(restored.length === 1 ? `Added “${project.name}”` : `Added “${project.name}” (${restored.length} tabs)`)
  }

  /**
   * app.tsx:720-749: the project replaces the window, so every pane open now
   * is reaped first; their sessions are free for the project to resume. The
   * panes reaped are the ones open when the restore lands, so a pane opened
   * while main was answering is not left running with nothing pointing at it.
   */
  async openProject(project: Project): Promise<void> {
    const releasing = termPaneIds(this.host.state())
    const restored = await restoreSavedTabs(project.tabs, this.host.invoke, this.host.mintId, releasing).catch(() => [] as TabState[])
    if (restored.length === 0) {
      this.host.toast('That project has nothing to open')
      return
    }
    await Promise.all(
      termPaneIds(this.host.state()).map(async (paneId) => {
        try {
          await this.host.invoke<PtyKillResponse>('pty:kill', { paneId })
        } catch {
          /* as closeTab: the pane goes regardless; main's own sweep catches survivors */
        }
      }),
    )
    this.host.dispatch({ type: 'tabs.replace', tabs: restored })
    this.currentProject = { id: project.id, name: project.name }
    this.host.closeSheet()
    this.host.toast(`Opened “${project.name}”`)
  }

  /** app.tsx:803-810. */
  async deleteProject(project: Project): Promise<void> {
    try {
      await this.host.invoke('projects:delete', { id: project.id })
      if (this.currentProject?.id === project.id) this.currentProject = null
    } catch {
      /* the refreshed list shows what is really there */
    }
    await this.refreshProjects()
  }
}

function termPaneIds(state: AppState): string[] {
  return state.tabs.flatMap((t) => Object.values(t.panes).filter(isTerm).map((p) => p.id))
}
