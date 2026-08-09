/**
 * Noticing that the window moved to a screen with a different pixel density.
 *
 * xterm already regenerates its glyph atlas on a DPR change — its own
 * ScreenDprMonitor drives `_refreshCharAtlas`, and the atlas cache key includes
 * the ratio. What it does not do is re-fit the grid: the DPR handler calls
 * `handleResize(cols, rows)` with the same cols and rows it already had, while
 * the CSS cell size changes underneath it, because the renderer derives
 * `css.cell.width` from `Math.floor(charWidth * dpr) / dpr`.
 *
 * At the shipped 13px that is 8.0 CSS px at both ratios, so nothing moves. At
 * the other zoom rungs it does: 17px is 10.5 CSS px at DPR 2 and 10.0 at DPR 1,
 * half a pixel per column — about 40px of drift across an 80-column pane, which
 * is a pane that no longer fills its box and a program still drawing to the old
 * width.
 *
 * Deliberately not a React hook. It is one watcher for every terminal rather
 * than one listener per pane, it covers the shell drawer for free (the drawer's
 * terminal lives in the same map), and it keeps this out of app.tsx, where
 * hooks stop being legal below the readiness guard.
 */

/** Ratio-specific media queries stop matching once the ratio moves, so the
 *  query has to be rebuilt on every change — the same reason xterm's own
 *  monitor removes and re-adds its listener. */
function query(dpr: number): MediaQueryList | null {
  if (typeof window.matchMedia !== 'function') return null
  return window.matchMedia(`screen and (resolution: ${dpr}dppx)`)
}

export interface DprWatchDeps {
  /** Called once per real change, on the next frame. */
  onChange: () => void
  /** Test seam: defaults to requestAnimationFrame. */
  schedule?: (fn: () => void) => void
}

/**
 * Starts watching. Returns a stop function; the app never calls it, but a test
 * must, and a watcher that cannot be stopped is a leak waiting to be written.
 */
export function watchDevicePixelRatio(deps: DprWatchDeps): () => void {
  const schedule = deps.schedule ?? ((fn: () => void) => void requestAnimationFrame(fn))
  let current = window.devicePixelRatio
  let mql = query(current)
  let stopped = false

  const check = (): void => {
    if (stopped) return
    const next = window.devicePixelRatio
    if (next === current) return
    current = next

    // Re-arm before doing any work: the old query no longer matches, so a
    // second move would otherwise go unnoticed.
    mql?.removeEventListener('change', check)
    mql = query(current)
    mql?.addEventListener('change', check)

    // One frame later, so the fit measures the cell width xterm has already
    // recomputed for the new ratio rather than the stale one.
    schedule(() => {
      if (!stopped) deps.onChange()
    })
  }

  mql?.addEventListener('change', check)
  // Belt and braces, mirroring xterm: a resize is not the primary signal, and
  // the `!== current` check above makes it free on the ordinary resize path.
  window.addEventListener('resize', check)

  return () => {
    stopped = true
    mql?.removeEventListener('change', check)
    window.removeEventListener('resize', check)
  }
}
