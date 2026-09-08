import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RestoreCard } from '../../src/renderer/session/RestoreCard.js'

afterEach(cleanup)

describe('RestoreCard', () => {
  it('names what it would restore and routes the two buttons', () => {
    const onRestore = vi.fn(), onFresh = vi.fn()
    render(<RestoreCard tabCount={2} paneCount={5} savedAt="2026-09-07T10:00:00.000Z" onRestore={onRestore} onFresh={onFresh} />)
    expect(screen.getByText(/2 tabs, 5 panes/)).toBeTruthy()
    fireEvent.click(screen.getByText('Restore'))
    expect(onRestore).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText('Start fresh'))
    expect(onFresh).toHaveBeenCalledOnce()
  })
  it('Escape means start fresh', () => {
    const onFresh = vi.fn()
    render(<RestoreCard tabCount={1} paneCount={2} savedAt="2026-09-07T10:00:00.000Z" onRestore={() => {}} onFresh={onFresh} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onFresh).toHaveBeenCalledOnce()
  })
})
