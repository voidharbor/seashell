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

export interface ProjectsPanelProps {
  projects: Project[]
  /** Number of tabs currently open, shown so "save" is not a blind action. */
  tabCount: number
  paneCount: number
  onSave: (name: string) => void
  onOpen: (project: Project) => void
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
    props.onSave(trimmed)
    setName('')
  }

  return (
    <div className="set" onMouseDown={(e) => e.stopPropagation()}>
      <div className="set__card">
        <div className="set__head">
          <h2 className="set__title">Projects</h2>
          <span className="pane__spacer" />
          <button className="btn" onClick={props.onClose}>
            Done
          </button>
        </div>

        <div className="set__group">
          <div className="set__heading">Save what is open</div>
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
            <button className="btn btn--primary" disabled={name.trim() === ''} onClick={save}>
              {existing ? 'Overwrite' : 'Save'}
            </button>
          </div>
          <div className="set__detail">
            {props.tabCount} tab{props.tabCount === 1 ? '' : 's'} · {props.paneCount} pane
            {props.paneCount === 1 ? '' : 's'} will be saved. Layout, directories, names and
            colours only — running programs cannot be restored, so panes come back at a fresh
            shell.
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
                    <button className="btn btn--primary" onClick={() => props.onOpen(p)}>
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
