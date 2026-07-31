import { useEffect, useRef, useState } from 'react'

/**
 * A live web page in a tiled pane.
 *
 * The point is adjacency, not replacing a browser: run a dev server in one
 * pane, watch the page in the one next to it, with no window switching and no
 * hunting for the right Chrome tab. It does not save memory — Chromium costs
 * roughly the same per page wherever it renders — so it earns its place by
 * layout, not by footprint.
 *
 * Implemented with the `<webview>` tag rather than a main-process
 * `WebContentsView`. `WebContentsView` is the API Electron is steering toward,
 * but it composites *above* the DOM: it would paint over the find bar, the
 * toast, and the divider hit-strips, and it needs its bounds pushed manually on
 * every layout change. `<webview>` participates in normal DOM stacking, so the
 * entire existing layout, zoom and divider machinery applies to it unchanged.
 *
 * The guest is a separate process with node integration off and its own
 * partition. Nothing it loads can reach this renderer's preload surface.
 */

interface WebviewElement extends HTMLElement {
  src: string
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
}

/**
 * Only http and https. A `file://` preview would hand the guest read access to
 * the local disk, and custom schemes can reach OS handlers.
 *
 * A bare `localhost:5173` or `:3000` is the form a dev server actually prints,
 * so both are accepted and normalized rather than rejected as invalid.
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (raw === '') return null

  // Every accepted form falls through to the same URL parse below, so they all
  // come back normalized identically. Returning a hand-built string from here
  // would make `:3000` and `localhost:3000` produce different values for the
  // same destination.
  const bare = /^:\d{2,5}$/.test(raw) ? `localhost${raw}` : raw

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(bare) ? bare : `http://${bare}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

export interface WebPreviewProps {
  url: string
  onUrlChange: (url: string) => void
  onToast: (message: string) => void
}

export function WebPreview(props: WebPreviewProps): React.JSX.Element {
  const viewRef = useRef<WebviewElement | null>(null)
  const [draft, setDraft] = useState(props.url)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => setDraft(props.url), [props.url])

  useEffect(() => {
    const el = viewRef.current
    if (!el) return

    const onStart = (): void => {
      setLoading(true)
      setFailed(null)
    }
    const onStop = (): void => setLoading(false)
    const onFail = (e: Event): void => {
      const detail = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean }
      // Sub-resource failures are noise; only a main-frame failure means the
      // page the user asked for is not there.
      if (detail.isMainFrame === false) return
      // -3 is ABORTED, which is what a normal navigation-away reports.
      if (detail.errorCode === -3) return
      setLoading(false)
      setFailed(detail.errorDescription || `error ${detail.errorCode}`)
    }
    const onNavigate = (e: Event): void => {
      const detail = e as unknown as { url: string }
      if (detail.url) props.onUrlChange(detail.url)
    }

    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('did-navigate', onNavigate)
    return () => {
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('did-navigate', onNavigate)
    }
  }, [props])

  const go = (value: string): void => {
    const normalized = normalizeUrl(value)
    if (!normalized) {
      props.onToast('Enter an http:// or https:// address')
      return
    }
    props.onUrlChange(normalized)
  }

  return (
    <>
      <div className="web__bar">
        <button
          className="btn web__nav"
          title="Back"
          onClick={() => viewRef.current?.canGoBack() && viewRef.current.goBack()}
        >
          ‹
        </button>
        <button
          className="btn web__nav"
          title="Forward"
          onClick={() => viewRef.current?.canGoForward() && viewRef.current.goForward()}
        >
          ›
        </button>
        <button
          className="btn web__nav"
          title={loading ? 'Stop' : 'Reload'}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
        >
          {loading ? '✕' : '⟳'}
        </button>
        <input
          className="web__url"
          value={draft}
          placeholder="localhost:3000"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') go(draft)
            if (e.key === 'Escape') setDraft(props.url)
          }}
        />
        <button
          className="btn"
          title="Open in your browser"
          onClick={() =>
            props.url && void window.seashell.open.externalHttp({ url: props.url })
          }
        >
          ↗
        </button>
      </div>

      {props.url === '' ? (
        <div className="empty">
          <div>Enter an address to preview</div>
          <div className="web__hint">a dev server, e.g. localhost:3000</div>
        </div>
      ) : (
        <div className="web__frame">
          {failed && <div className="web__error">Could not load — {failed}</div>}
          <webview
            ref={viewRef as never}
            src={props.url}
            partition="persist:seashell-preview"
            // eslint-disable-next-line react/no-unknown-property
            webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
            className="web__view"
          />
        </div>
      )}
    </>
  )
}
