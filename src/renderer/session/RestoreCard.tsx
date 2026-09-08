import { useEffect } from 'react'

export interface RestoreCardProps {
  tabCount: number
  paneCount: number
  savedAt: string
  onRestore: () => void
  onFresh: () => void
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

/**
 * The one thing SeaShell asks before it opens: bring back the window you had,
 * or start clean. Shown only when the snapshot is worth a prompt, so a plain
 * single shell never sees it. Escape is start fresh, which makes the card
 * dismissable without reading it.
 */
export function RestoreCard(props: RestoreCardProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onFresh()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div className="restore">
      <div className="restore__card">
        <div className="restore__title">Restore last session?</div>
        <div className="restore__detail">
          {props.tabCount} {props.tabCount === 1 ? 'tab' : 'tabs'}, {props.paneCount}{' '}
          {props.paneCount === 1 ? 'pane' : 'panes'}
          {props.savedAt ? `, saved ${when(props.savedAt)}` : ''}. Claude panes resume their sessions.
        </div>
        <div className="restore__buttons">
          <button className="btn btn--primary" autoFocus onClick={props.onRestore}>
            Restore
          </button>
          <button className="btn" onClick={props.onFresh}>
            Start fresh
          </button>
        </div>
      </div>
    </div>
  )
}
