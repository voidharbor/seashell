import { useEffect, useState } from 'react'

export interface ViewerProps {
  path: string
  onClose: () => void
}

const MAX_BYTES = 8 * 1024 * 1024

/**
 * Read-only by design. Editing is explicitly out of scope — this exists so you
 * can glance at a file a terminal mentioned without leaving the window, not to
 * replace an editor.
 *
 * Text is rendered into a <pre> via React's text node, never innerHTML. The
 * CSP forbids inline script, and file contents are untrusted input.
 */
export function Viewer(props: ViewerProps): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    let cancelled = false
    setText(null)
    setError(null)
    void window.seashell.fs.readTextFile({ path: props.path, maxBytes: MAX_BYTES }).then((res) => {
      if (cancelled) return
      if (res.ok) {
        setText(res.text)
        setTruncated(res.truncated)
      } else {
        setError(res.code)
      }
    })
    return () => {
      cancelled = true
    }
  }, [props.path])

  return (
    <div className="viewer">
      <div className="viewer__head">
        <button className="btn" onClick={props.onClose}>
          ← Close
        </button>
        <span className="viewer__path">{props.path}</span>
        <span className="pane__spacer" />
        {truncated && <span className="pane__idle">truncated</span>}
        <button
          className="btn"
          onClick={() => void window.seashell.open.revealInFinder({ path: props.path })}
        >
          Reveal in Finder
        </button>
        <button
          className="btn"
          onClick={() => void window.seashell.open.withDefaultApp({ path: props.path })}
        >
          Open externally
        </button>
      </div>
      {error ? (
        <div className="empty">Could not read this file ({error})</div>
      ) : text === null ? (
        <div className="empty">Loading…</div>
      ) : (
        <pre className="viewer__body">{text}</pre>
      )}
    </div>
  )
}
