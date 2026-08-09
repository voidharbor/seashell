import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchDevicePixelRatio } from '../../src/renderer/term/dpr.js'

/**
 * Dragging the window between the built-in Retina panel and an external 1x
 * monitor changes the CSS cell size under a grid that nothing re-measures.
 * xterm rebuilds its glyph atlas on the same event but re-fits to the cols and
 * rows it already had, so the pane is left drawing to the old width.
 *
 * The watcher is driven here rather than observed through a mounted pane: the
 * whole point of it not being a React hook is that it has no component to test
 * through.
 */

type Listener = (e?: unknown) => void

/** A matchMedia stand-in that records queries and lets a test fire `change`. */
function installMatchMedia(): { fire: () => void; queries: string[] } {
  const queries: string[] = []
  const listeners = new Set<Listener>()
  ;(window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => {
    queries.push(q)
    return {
      matches: true,
      media: q,
      addEventListener: (_: string, fn: Listener) => listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    }
  }
  return { fire: () => [...listeners].forEach((fn) => fn()), queries }
}

function setDpr(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true })
}

const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.restoreAllMocks()
})

/** Runs scheduled work immediately, standing in for requestAnimationFrame. */
const now = (fn: () => void): void => fn()

describe('watchDevicePixelRatio', () => {
  it('refits once when the ratio actually changes', () => {
    setDpr(2)
    const mm = installMatchMedia()
    const onChange = vi.fn()
    stops.push(watchDevicePixelRatio({ onChange, schedule: now }))

    setDpr(1)
    mm.fire()

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the event fires but the ratio has not moved', () => {
    setDpr(2)
    const mm = installMatchMedia()
    const onChange = vi.fn()
    stops.push(watchDevicePixelRatio({ onChange, schedule: now }))

    mm.fire()
    window.dispatchEvent(new Event('resize'))

    expect(onChange).not.toHaveBeenCalled()
  })

  /**
   * The query is ratio-specific: `screen and (resolution: 2dppx)` stops
   * matching the moment the ratio is no longer 2. Without rebuilding it, the
   * first move would be the last one ever noticed.
   */
  it('re-arms on the new ratio, so a second move is still seen', () => {
    setDpr(2)
    const mm = installMatchMedia()
    const onChange = vi.fn()
    stops.push(watchDevicePixelRatio({ onChange, schedule: now }))

    setDpr(1)
    mm.fire()
    setDpr(2)
    mm.fire()

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(mm.queries).toEqual([
      'screen and (resolution: 2dppx)',
      'screen and (resolution: 1dppx)',
      'screen and (resolution: 2dppx)',
    ])
  })

  it('also catches a change that only arrives as a resize', () => {
    setDpr(2)
    installMatchMedia()
    const onChange = vi.fn()
    stops.push(watchDevicePixelRatio({ onChange, schedule: now }))

    setDpr(1)
    window.dispatchEvent(new Event('resize'))

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('stops for good once stopped', () => {
    setDpr(2)
    const mm = installMatchMedia()
    const onChange = vi.fn()
    const stop = watchDevicePixelRatio({ onChange, schedule: now })

    stop()
    setDpr(1)
    mm.fire()
    window.dispatchEvent(new Event('resize'))

    expect(onChange).not.toHaveBeenCalled()
  })

  it('survives an environment with no matchMedia at all', () => {
    setDpr(2)
    ;(window as unknown as { matchMedia: unknown }).matchMedia = undefined
    const onChange = vi.fn()
    expect(() => stops.push(watchDevicePixelRatio({ onChange, schedule: now }))).not.toThrow()

    setDpr(1)
    window.dispatchEvent(new Event('resize'))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
