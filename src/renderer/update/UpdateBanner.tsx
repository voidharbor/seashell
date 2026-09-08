import type { UpdateState } from '../../shared/ipc.js'

/**
 * The one place an update is ever mentioned.
 *
 * It sits above the status bar rather than over the window, and every phase
 * is a strip of text with at most two buttons. Nothing here starts a download
 * or an install on its own: both are clicks, always.
 */
export interface UpdateBannerProps {
  state: UpdateState
  onDownload: () => void
  onInstall: () => void
  onLater: () => void
}

export function UpdateBanner(props: UpdateBannerProps): React.JSX.Element | null {
  const s = props.state
  if (s.phase === 'idle') return null
  return (
    <div className="update-banner" role="status">
      {s.phase === 'available' && (
        <>
          <span>SeaShell {s.version} is available.</span>
          {s.canInstall ? (
            <button className="btn btn--primary" onClick={props.onDownload}>
              Download
            </button>
          ) : (
            // Never a raw anchor: the renderer refuses to navigate, so the URL
            // goes to the main process, which opens the default browser.
            <button
              className="btn"
              onClick={() => void window.seashell.open.externalHttp({ url: s.pageUrl })}
            >
              Release page
            </button>
          )}
          <button className="btn" onClick={props.onLater}>
            Later
          </button>
        </>
      )}
      {s.phase === 'downloading' && (
        <span>
          Downloading {s.version}:{' '}
          {s.total > 0
            ? `${Math.floor((s.received / s.total) * 100)}%`
            : `${Math.floor(s.received / 1024 / 1024)} MB`}
        </span>
      )}
      {s.phase === 'ready' && (
        <>
          <span>
            SeaShell {s.version} is ready. Installing closes every pane and relaunches.
          </span>
          <button className="btn btn--primary" onClick={props.onInstall}>
            Install and Relaunch
          </button>
          <button className="btn" onClick={props.onLater}>
            Later
          </button>
        </>
      )}
      {s.phase === 'error' && (
        <>
          <span>
            Update {s.version} failed: {s.message}
          </span>
          <button className="btn" onClick={props.onLater}>
            Dismiss
          </button>
        </>
      )}
    </div>
  )
}
