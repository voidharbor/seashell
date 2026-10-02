import { useEffect, useState } from 'react'

/**
 * The three window buttons, drawn by the app because off macOS the window is
 * frameless (shared/window-chrome.ts) and nothing else will draw them.
 *
 * Shaped like Windows 11's: 46px wide, the bar's full height, one-pixel
 * glyphs, a quiet hover, and the close button going red, which is the one
 * caption convention every Windows hand has learned. The order is fixed,
 * minimize then maximize then close, because a hand reaches for the corner
 * without looking.
 *
 * The middle glyph tracks the window: maximize when it is not, restore (two
 * offset squares) when it is. The state comes from main, the only place that
 * knows it: asked once on mount, then pushed on every change.
 */
export function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let live = true
    void window.seashell.window.isMaximized().then((m) => {
      if (live) setMaximized(m)
    })
    const off = window.seashell.window.onMaximized((e) => setMaximized(e.maximized))
    return () => {
      live = false
      off()
    }
  }, [])

  const w = window.seashell.window
  return (
    <div className="winctl">
      <button
        type="button"
        className="winctl__btn"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => w.minimize()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" />
        </svg>
      </button>
      <button
        type="button"
        className="winctl__btn"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => w.toggleMaximize()}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5V0.5h7v7H7.5" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="winctl__btn winctl__btn--close"
        aria-label="Close"
        title="Close"
        onClick={() => w.close()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  )
}

/**
 * Where the menu went. With the frame gone the menu bar is hidden too (Alt
 * still shows it), and this pops the same menu at the left end of the tab
 * bar, in the space macOS spends on the traffic lights.
 */
export function MenuButton(): React.JSX.Element {
  return (
    <button
      type="button"
      className="tabbar__menu"
      aria-label="Menu"
      title="Menu (Alt)"
      onClick={() => window.seashell.window.menu()}
    >
      <svg viewBox="0 0 12 10" aria-hidden="true">
        <path d="M0 1h12M0 5h12M0 9h12" />
      </svg>
    </button>
  )
}
