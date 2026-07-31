import { useEffect, useMemo, useRef, useState } from 'react'
import { highlightToHast, languageFor, type HastNode } from './highlight.js'
import { renderHast } from './hast.js'
import { FindBar } from '../find/FindBar.js'

const MAX_BYTES = 8 * 1024 * 1024

/** Highlighting a very large file blocks the renderer for long enough to feel
 *  like a hang. Past this, the file is shown as plain text — still readable,
 *  still scrollable, just uncoloured. */
const HIGHLIGHT_MAX_BYTES = 512 * 1024

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

function extOf(p: string): string {
  const base = p.split('/').filter(Boolean).pop() ?? p
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

export interface FilePreviewProps {
  path: string
  rawSource: boolean
  onToggleRaw: (raw: boolean) => void
  findOpen: boolean
  findNonce: number
  findDirection: 'next' | 'prev'
  onCloseFind: () => void
}

type Loaded =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; src: string }
  | { kind: 'error'; code: string }

/**
 * Read-only file preview. Editing stays out of scope — this exists so you can
 * look at a file a terminal just mentioned without leaving the window.
 *
 * Nothing here ever uses innerHTML. Highlighted output arrives as HAST and is
 * turned into React elements by the allowlisting renderer in hast.tsx; plain
 * text goes through a React text node. File contents are untrusted input.
 */
export function FilePreview(props: FilePreviewProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [lines, setLines] = useState<HastNode[] | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const isImage = IMAGE_EXTS.has(extOf(props.path))
  const canHighlight = languageFor(props.path) !== null

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setLines(null)

    void (async () => {
      if (isImage) {
        const res = await window.seashell.fs.readImageFile({ path: props.path })
        if (cancelled) return
        setLoaded(
          res.ok
            ? { kind: 'image', src: `data:${res.mime};base64,${res.base64}` }
            : { kind: 'error', code: res.code }
        )
        return
      }

      const res = await window.seashell.fs.readTextFile({ path: props.path, maxBytes: MAX_BYTES })
      if (cancelled) return
      if (!res.ok) {
        setLoaded({ kind: 'error', code: res.code })
        return
      }
      setLoaded({ kind: 'text', text: res.text, truncated: res.truncated })
    })()

    return () => {
      cancelled = true
    }
  }, [props.path, isImage])

  // Highlight as a second pass so the text is on screen immediately and the
  // colour arrives when it is ready, rather than the pane staying blank
  // through a grammar load on first use of a language.
  useEffect(() => {
    let cancelled = false
    setLines(null)
    if (!loaded || loaded.kind !== 'text' || props.rawSource) return
    if (loaded.text.length > HIGHLIGHT_MAX_BYTES) return

    void highlightToHast(loaded.text, props.path).then((res) => {
      if (!cancelled && res) setLines(res.lines)
    })
    return () => {
      cancelled = true
    }
  }, [loaded, props.path, props.rawSource])

  /** Browser-native find over the rendered text, used by the pane's find bar. */
  const runFind = (query: string, direction: 'next' | 'prev'): boolean => {
    const sel = window.getSelection()
    if (!sel) return false
    bodyRef.current?.focus()
    // find() is non-standard but present in Chromium, which is the only engine
    // this app ever runs in. It is the cheapest correct way to search rendered
    // text without re-implementing range walking over the highlighted spans.
    const w = window as unknown as {
      find?: (q: string, caseSensitive: boolean, backwards: boolean) => boolean
    }
    if (typeof w.find !== 'function') return false
    return w.find(query, false, direction === 'prev')
  }

  const body = useMemo((): React.JSX.Element => {
    if (!loaded) return <div className="empty">Loading…</div>

    if (loaded.kind === 'error') {
      return <div className="empty">Could not read this file ({loaded.code})</div>
    }

    if (loaded.kind === 'image') {
      return (
        <div className="preview__imagewrap">
          <img className="preview__image" src={loaded.src} alt={props.path} />
        </div>
      )
    }

    if (lines) {
      return (
        <pre className="preview__code preview__code--hl">
          <code>{renderHast(lines)}</code>
        </pre>
      )
    }
    return <pre className="preview__code">{loaded.text}</pre>
  }, [loaded, lines, props.path])

  return (
    <>
      {props.findOpen && (
        <FindBar
          targetKey={props.path}
          nonce={props.findNonce}
          nonceDirection={props.findDirection}
          onSearch={runFind}
          onClose={props.onCloseFind}
        />
      )}
      <div className="preview__toolbar">
        {loaded?.kind === 'text' && loaded.truncated && (
          <span className="preview__flag">truncated at 8 MB</span>
        )}
        {canHighlight && loaded?.kind === 'text' && (
          <button
            className="btn"
            title="Toggle syntax highlighting"
            onClick={() => props.onToggleRaw(!props.rawSource)}
          >
            {props.rawSource ? 'Highlight' : 'Plain'}
          </button>
        )}
        <button
          className="btn"
          onClick={() => void window.seashell.open.revealInFinder({ path: props.path })}
        >
          Reveal
        </button>
        <button
          className="btn"
          onClick={() => void window.seashell.open.withDefaultApp({ path: props.path })}
        >
          Open
        </button>
      </div>
      <div className="preview__body" ref={bodyRef} tabIndex={-1}>
        {body}
      </div>
    </>
  )
}
