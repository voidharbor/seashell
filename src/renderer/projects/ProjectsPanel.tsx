import { useEffect, useRef, useState } from 'react'
import type { Project } from '../../shared/ipc.js'

/**
 * Save and reopen named sets of tabs and panes.
 *
 * Saving by name rather than by slot is what matches how people think about
 * this: "save as Solar Bear" twice means one project called Solar Bear, not two.
 * Overwriting an existing name is confirmed rather than silent, because the
 * thing being replaced is work the user arranged by hand.
 */

/**
 * What a save covers.
 *
 * `window` is everything open — the workspace. `tab` is the active tab alone,
 * which is the level people mean by "project": a tab is already a named group
 * of panes, so one saved tab is a project you can bring into any window later
 * without disturbing what is already there.
 */
export type SaveScope = 'window' | 'tab'

export interface ProjectsPanelProps {
  projects: Project[]
  /** Number of tabs currently open, shown so "save" is not a blind action. */
  tabCount: number
  paneCount: number
  /** The active tab's name and pane count, for the same reason at tab scope. */
  activeTabName: string
  activeTabPaneCount: number
  /** The project this window was opened from (or last saved as), if any —
   *  enables the in-place Save button. */
  currentProject: { id: string; name: string } | null
  /** Scope the panel opens on — File > Save Tab as Project… lands on 'tab'. */
  defaultScope?: SaveScope
  onSave: (name: string, scope: SaveScope) => void
  /** Update `currentProject` in place with what is open now. */
  onSaveCurrent: () => void
  /** Replace the window with this project. */
  onOpen: (project: Project) => void
  /** Add this project's tabs alongside what is already open. */
  onAdd: (project: Project) => void
  onDelete: (project: Project) => void
  onClose: () => void
}

function whenSaved(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function describe(project: Project): string {
  const tabs = project.tabs.length
  const panes = project.tabs.reduce((n, t) => n + Object.keys(t.panes ?? {}).length, 0)
  return `${tabs} tab${tabs === 1 ? '' : 's'} · ${panes} pane${panes === 1 ? '' : 's'}`
}

export function ProjectsPanel(props: ProjectsPanelProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<SaveScope>(props.defaultScope ?? 'window')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const existing = props.projects.find(
    (p) => p.name.toLowerCase() === name.trim().toLowerCase()
  )

  const save = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    props.onSave(trimmed, scope)
    setName('')
  }

  // The shell classes below are the settings panel's, deliberately shared. They
  // had been spelled `set`/`set__card`/`set__head`/`set__title` here and no such
  // rules exist — so this panel had no overlay, no card and no padding at all,
  // and rendered as a bare block below the status bar with its buttons hard
  // against the window edge. The `set__group`/`set__row`/`set__detail` classes
  // further down are real and genuinely shared; only the outer four were wrong.
  return (
    <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sheet__card">
        <div className="sheet__head">
          <h2 className="sheet__title">Projects</h2>
          <span className="pane__spacer" />
          <button className="btn" onClick={props.onClose}>
            Done
          </button>
        </div>

        <div className="set__group">
          <div className="set__heading">Save what is open</div>
          {/* Scope first, because it changes what every control under it means. */}
          <div className="proj__saverow">
            <button
              className={scope === 'window' ? 'btn btn--primary' : 'btn'}
              onClick={() => setScope('window')}
            >
              Whole window
            </button>
            <button
              className={scope === 'tab' ? 'btn btn--primary' : 'btn'}
              onClick={() => setScope('tab')}
            >
              This tab
            </button>
            <span className="set__detail">
              {scope === 'tab' ? 'a project you can add to any window' : 'the whole workspace'}
            </span>
          </div>
          {props.currentProject && (
            <div className="proj__saverow">
              <button className="btn btn--primary" onClick={props.onSaveCurrent}>
                Save “{props.currentProject.name}”
              </button>
              <span className="set__detail">updates the open project in place</span>
            </div>
          )}
          <div className="proj__saverow">
            <input
              ref={inputRef}
              className="proj__name"
              value={name}
              placeholder="Project name"
              spellCheck={false}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') save()
              }}
            />
            <button
              className={props.currentProject ? 'btn' : 'btn btn--primary'}
              disabled={name.trim() === ''}
              onClick={save}
            >
              {existing ? 'Overwrite' : props.currentProject ? 'Save as project' : 'Save'}
            </button>
          </div>
          <div className="set__detail">
            {scope === 'tab' ? (
              <>
                The tab “{props.activeTabName}” · {props.activeTabPaneCount} pane
                {props.activeTabPaneCount === 1 ? '' : 's'} will be saved.
              </>
            ) : (
              <>
                {props.tabCount} tab{props.tabCount === 1 ? '' : 's'} · {props.paneCount} pane
                {props.paneCount === 1 ? '' : 's'} will be saved.
              </>
            )}{' '}
            Layout, directories, names and colours, plus the claude session in each pane —
            reopening resumes it with a visible `claude -r` in that pane's shell. Other running
            programs come back as a fresh shell.
            {existing && ' A project with this name already exists and will be replaced.'}
          </div>
        </div>

        <div className="set__group">
          <div className="set__heading">Open a project</div>
          {props.projects.length === 0 ? (
            <div className="set__detail">Nothing saved yet.</div>
          ) : (
            props.projects.map((p) => (
              <div className="proj__row" key={p.id}>
                <span className="proj__text">
                  <span className="set__name">{p.name}</span>
                  <span className="set__detail">
                    {describe(p)} · saved {whenSaved(p.savedAt)}
                  </span>
                </span>
                {confirmDelete === p.id ? (
                  <>
                    <button
                      className="btn proj__danger"
                      onClick={() => {
                        props.onDelete(p)
                        setConfirmDelete(null)
                      }}
                    >
                      Delete
                    </button>
                    <button className="btn" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn" onClick={() => setConfirmDelete(p.id)}>
                      Delete
                    </button>
                    {/* Add before Open, and Open is the destructive one: it
                        replaces the window and reaps every pane currently
                        running. Add leaves them alone. */}
                    <button
                      className="btn"
                      title="Add these tabs to this window, leaving what is open alone"
                      onClick={() => props.onAdd(p)}
                    >
                      Add
                    </button>
                    <button
                      className="btn btn--primary"
                      title="Replace this window with the project — closes every pane open now"
                      onClick={() => props.onOpen(p)}
                    >
                      Open
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
