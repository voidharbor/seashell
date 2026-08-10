import { useEffect, useRef } from 'react'

/**
 * Choosing which pane to share notes with.
 *
 * Only agent panes are offered. The briefing is an English sentence, and typed
 * into a plain shell that is not a comment but a command line — so a pane that
 * is not running an agent is listed as unavailable rather than silently
 * accepting a link that would fill it with "command not found".
 */

export interface LinkCandidate {
  paneId: string
  /** What the tab bar calls it, so the list matches what is on screen. */
  label: string
  index: number
  /** Whether an agent is in the foreground right now. */
  briefable: boolean
  /** The link group it is already in, if any. */
  linkId?: string
}

export interface LinkPickerProps {
  /** The pane the picker was opened from. */
  paneId: string
  linkId?: string
  candidates: LinkCandidate[]
  onLink: (otherPaneId: string) => void
  onUnlink: () => void
  onClose: () => void
}

export function LinkPicker(props: LinkPickerProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Pointerdown for the same reason ColorPicker uses it: a click listener
    // fires after the terminal underneath has taken focus, so the popover
    // closes a frame late and the pane flickers on the way past.
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) props.onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [props])

  const others = props.candidates.filter((c) => c.paneId !== props.paneId)

  return (
    <div className="linkpick" ref={ref}>
      <div className="linkpick__head">Share notes with</div>

      {others.length === 0 && (
        <div className="linkpick__empty">No other terminal pane in this tab.</div>
      )}

      {others.map((c) => {
        const already = props.linkId !== undefined && c.linkId === props.linkId
        return (
          <button
            key={c.paneId}
            className={'linkpick__row' + (already ? ' linkpick__row--on' : '')}
            disabled={!c.briefable || already}
            title={
              already
                ? 'Already sharing notes with this pane'
                : c.briefable
                  ? 'Both panes get one shared notes file'
                  : 'Only a pane running an agent can be linked'
            }
            onClick={() => props.onLink(c.paneId)}
          >
            <span className="linkpick__index">{c.index}</span>
            <span className="linkpick__label">{c.label}</span>
            <span className="linkpick__note">
              {already ? 'linked' : c.briefable ? '' : 'no agent'}
            </span>
          </button>
        )
      })}

      {props.linkId !== undefined && (
        <button className="linkpick__unlink" onClick={props.onUnlink}>
          Stop sharing
        </button>
      )}
    </div>
  )
}
