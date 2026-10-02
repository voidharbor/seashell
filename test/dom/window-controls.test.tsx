import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MenuButton, WindowControls } from '../../src/renderer/chrome/WindowControls.js'

/**
 * Off macOS these three buttons are the only way to minimize, maximize or
 * close with the mouse, so each has to reach main, and the middle one has to
 * say which of its two jobs it will do next.
 */
type Listener = (e: { maximized: boolean }) => void
let listener: Listener | null = null

const w = {
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  menu: vi.fn(),
  isMaximized: vi.fn(async () => false),
  onMaximized: vi.fn((cb: Listener) => {
    listener = cb
    return () => {
      listener = null
    }
  }),
}

beforeEach(() => {
  listener = null
  for (const f of Object.values(w)) f.mockClear()
  w.isMaximized.mockImplementation(async () => false)
  Object.defineProperty(window, 'seashell', { value: { window: w }, configurable: true })
})
afterEach(cleanup)

describe('WindowControls', () => {
  it('routes the three buttons to main', () => {
    render(<WindowControls />)
    fireEvent.click(screen.getByLabelText('Minimize'))
    expect(w.minimize).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByLabelText('Maximize'))
    expect(w.toggleMaximize).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByLabelText('Close'))
    expect(w.close).toHaveBeenCalledOnce()
  })

  it('offers Restore while the window is maximized, Maximize otherwise', () => {
    render(<WindowControls />)
    expect(screen.getByLabelText('Maximize')).toBeTruthy()
    act(() => listener?.({ maximized: true }))
    expect(screen.getByLabelText('Restore')).toBeTruthy()
    expect(screen.queryByLabelText('Maximize')).toBeNull()
    act(() => listener?.({ maximized: false }))
    expect(screen.getByLabelText('Maximize')).toBeTruthy()
  })

  it('asks main for the state it starts in', async () => {
    w.isMaximized.mockImplementation(async () => true)
    render(<WindowControls />)
    expect(await screen.findByLabelText('Restore')).toBeTruthy()
  })

  it('stops listening when unmounted', () => {
    const { unmount } = render(<WindowControls />)
    expect(listener).not.toBeNull()
    unmount()
    expect(listener).toBeNull()
  })
})

describe('MenuButton', () => {
  it('pops the application menu', () => {
    render(<MenuButton />)
    fireEvent.click(screen.getByLabelText('Menu'))
    expect(w.menu).toHaveBeenCalledOnce()
  })
})
