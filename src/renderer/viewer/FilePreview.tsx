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

/** Rendered by Chromium's own PDFium viewer in a sandboxed guest — the same
 *  renderer Chrome uses. The webview guard in main only admits file:// URLs
 *  that end in .pdf, so this branch and that exception are a matched pair. */
const PDF_EXTS = new Set(['pdf'])

function extOf(p: string): string {
  const base = p.split('/').filter(Boolean).pop() ?? p
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

export interface FilePreviewProps {
  path: string
  /** Owning pane id, used to track unsaved edits for the close guard. */
  paneId?: string
  rawSource: boolean
  onToggleRaw: (raw: boolean) => void
  findOpen: boolean
  findNonce: number
  findDirection: 'next' | 'prev'
  onCloseFind: () => void
}

type Loaded =
  | { kind: 'text'; text: string; truncated: boolean; mtimeMs: number }
  | { kind: 'image'; src: string }
  | { kind: 'error'; code: string }

/**
 * Pane ids whose preview holds unsaved edits, read by app.tsx's close paths
 * so a close with edits pending asks first. A module-level set (same pattern
 * as PaneView's `terminals`) because the close handler lives far above this
 * component and threading the state up would couple half the tree to it.
 */
export const dirtyPreviewPanes = new Set<string>()

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

  // ------------------------------------------------------------- editing
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<'conflict' | 'refused' | null>(null)
  /** Bumped to re-run the load effect (after a conflict reload). */
  const [loadNonce, setLoadNonce] = useState(0)

  const isImage = IMAGE_EXTS.has(extOf(props.path))
  const isPdf = PDF_EXTS.has(extOf(props.path))
  const canHighlight = languageFor(props.path) !== null

  const dirty = editing && loaded?.kind === 'text' && draft !== loaded.text

  // The close guard reads this set; membership must track `dirty` exactly and
  // never outlive the pane (or the path shown in it).
  useEffect(() => {
    const id = props.paneId
    if (!id) return
    if (dirty) dirtyPreviewPanes.add(id)
    else dirtyPreviewPanes.delete(id)
    return () => {
      dirtyPreviewPanes.delete(id)
    }
  }, [dirty, props.paneId])

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setLines(null)
    setEditing(false)
    setSaveError(null)

    void (async () => {
      if (isPdf) return // the webview streams it; nothing to read here
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
      setLoaded({ kind: 'text', text: res.text, truncated: res.truncated, mtimeMs: res.mtimeMs })
    })()

    return () => {
      cancelled = true
    }
  }, [props.path, isImage, isPdf, loadNonce])

  const startEdit = (): void => {
    if (loaded?.kind !== 'text' || loaded.truncated) return
    setDraft(loaded.text)
    setSaveError(null)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    if (loaded?.kind !== 'text' || saving || !dirty) return
    setSaving(true)
    setSaveError(null)
    const res = await window.seashell.fs.writeTextFile({
      path: props.path,
      text: draft,
      expectedMtimeMs: loaded.mtimeMs,
    })
    setSaving(false)
    if (res.ok) {
      // The draft is now the on-disk truth; staying in the editor is the
      // normal keep-working flow.
      setLoaded({ kind: 'text', text: draft, truncated: false, mtimeMs: res.mtimeMs })
      return
    }
    setSaveError(res.code === 'ECONFLICT' ? 'conflict' : 'refused')
  }

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

    if (editing) {
      return (
        <textarea
          className="preview__editor"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault()
              void save()
            }
          }}
        />
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save is stable per render's closure needs
  }, [loaded, lines, props.path, editing, draft])

  if (isPdf) {
    return (
      <>
        <div className="preview__toolbar">
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
        {/* PDFium needs plugins enabled in the guest; everything else stays as
            locked down as the web preview. The find bar is deliberately absent:
            the PDF viewer ships its own search. */}
        <div className="preview__body preview__body--pdf">
          <webview
            src={`file://${encodeURI(props.path)}`}
            plugins
            partition="persist:seashell-preview"
            // eslint-disable-next-line react/no-unknown-property
            webpreferences="plugins=yes,contextIsolation=yes,nodeIntegration=no,sandbox=yes"
            className="preview__pdf"
          />
        </div>
      </>
    )
  }

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
        {dirty && <span className="preview__flag preview__flag--dirty">● unsaved changes</span>}
        {editing ? (
          <>
            <button className="btn btn--primary" disabled={!dirty || saving} onClick={() => void save()}>
              Save
            </button>
            <button
              className="btn"
              onClick={() => {
                // Leaving the editor with edits pending is an explicit act on a
                // visible unsaved-changes state, not a silent loss.
                if (dirty && !window.confirm('Discard unsaved changes?')) return
                setEditing(false)
                setSaveError(null)
              }}
            >
              {dirty ? 'Discard' : 'Done'}
            </button>
          </>
        ) : (
          <>
            {loaded?.kind === 'text' && !loaded.truncated && (
              <button className="btn" onClick={startEdit}>
                Edit
              </button>
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
          </>
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
      {saveError && (
        <div className="preview__conflict">
          {saveError === 'conflict' ? (
            <>
              <span>
                This file changed on disk since it was loaded — saving would overwrite those
                changes.
              </span>
              <button
                className="btn"
                onClick={() => {
                  // Reload replaces the draft with the on-disk contents; the
                  // banner is the explicit warning that edits here are lost.
                  if (!window.confirm('Reload from disk and discard your edits?')) return
                  setEditing(false)
                  setSaveError(null)
                  setLoadNonce((n) => n + 1)
                }}
              >
                Reload from disk
              </button>
            </>
          ) : (
            <span>Could not save this file — it may be read-only or outside your home folder.</span>
          )}
        </div>
      )}
      <div className="preview__body" ref={bodyRef} tabIndex={-1}>
        {body}
      </div>
    </>
  )
}
