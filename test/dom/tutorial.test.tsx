import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tutorial } from '../../src/renderer/tutorial/Tutorial.js'

/**
 * Behavioural invariants for the tutorial overlay.
 *
 * These were written after a running build was observed sitting on step 5 of 6
 * seconds after launch. That turned out NOT to be a self-advancing bug: the
 * window takes focus on launch, and keystrokes intended for another window
 * landed in the overlay. Re-registering the key listener on every render (the
 * original code had no dependency array) still leaves exactly one listener
 * attached at a time, so it could not double-count a key press — verified by
 * reintroducing it and watching these tests still pass.
 *
 * They are kept because the invariants are worth pinning regardless of that
 * false start: an ambient re-render must never change the step, a key press
 * must move exactly one step, the ends must clamp rather than wrap, and — the
 * one with lasting consequences — the first-run flag must only be spent when
 * the user actually dismisses it, never merely by the overlay existing.
 */

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  // Testing Library only auto-cleans when vitest runs with `globals: true`,
  // which this config deliberately does not. Without this, every render stays
  // in document.body and later queries match several mounted tutorials.
  cleanup()
  vi.restoreAllMocks()
})

function stepText(): string {
  return screen.getByText(/^\d+ \/ \d+$/).textContent ?? ''
}

/** Derived, never hardcoded — steps get added as features land, and a test that
 *  pins the count fails for a reason that has nothing to do with behaviour. */
function stepIndex(): number {
  return Number(stepText().split('/')[0]!.trim())
}

function stepCount(): number {
  return Number(stepText().split('/')[1]!.trim())
}

describe('Tutorial', () => {
  it('opens on the first step', () => {
    render(<Tutorial onClose={() => {}} />)
    expect(stepIndex()).toBe(1)
  })

  it('does not advance when the app re-renders around it', () => {
    const { rerender } = render(<Tutorial onClose={() => {}} />)
    // Stand in for the metrics tick and every other ambient re-render.
    for (let i = 0; i < 25; i += 1) rerender(<Tutorial onClose={() => {}} />)
    expect(stepIndex()).toBe(1)
  })

  it('advances exactly one step per key press, however many renders preceded it', () => {
    const { rerender } = render(<Tutorial onClose={() => {}} />)
    for (let i = 0; i < 10; i += 1) rerender(<Tutorial onClose={() => {}} />)

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(stepIndex()).toBe(2)

    for (let i = 0; i < 10; i += 1) rerender(<Tutorial onClose={() => {}} />)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(stepIndex()).toBe(3)

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(stepIndex()).toBe(2)
  })

  it('clamps at both ends rather than wrapping', () => {
    render(<Tutorial onClose={() => {}} />)
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(stepIndex()).toBe(1)

    for (let i = 0; i < 20; i += 1) fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(stepIndex()).toBe(stepCount())
  })

  it('reaches a step about Lookout when stepping all the way through', () => {
    render(<Tutorial onClose={() => {}} />)
    const count = stepCount()
    const titles = [screen.getByRole('heading', { level: 2 }).textContent]
    for (let i = 1; i < count; i += 1) {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      titles.push(screen.getByRole('heading', { level: 2 }).textContent)
    }
    expect(titles).toContain('Lookout')
  })

  it('only marks itself seen once actually dismissed', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Tutorial onClose={onClose} />)
    for (let i = 0; i < 15; i += 1) rerender(<Tutorial onClose={onClose} />)

    // Merely existing and re-rendering must not burn the first-run flag.
    expect(window.localStorage.getItem('seashell.tutorialSeen')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Skip'))
    expect(window.localStorage.getItem('seashell.tutorialSeen')).toBe('1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps showing next launch when "don\'t show again" is unticked', () => {
    const onClose = vi.fn()
    render(<Tutorial onClose={onClose} />)

    // Ticked by default — a first-run tutorial should be a first-run tutorial.
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)

    fireEvent.click(box)
    expect(box.checked).toBe(false)

    fireEvent.click(screen.getByText('Skip'))
    expect(onClose).toHaveBeenCalledTimes(1)
    // The whole point: dismissed, but not suppressed.
    expect(window.localStorage.getItem('seashell.tutorialSeen')).toBeNull()
  })

  it('honours the unticked box when dismissed with Escape too', () => {
    render(<Tutorial onClose={() => {}} />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(window.localStorage.getItem('seashell.tutorialSeen')).toBeNull()
  })

  it('stops listening once unmounted', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Tutorial onClose={onClose} />)
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
