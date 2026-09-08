import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../../src/renderer/update/UpdateBanner.js'

afterEach(cleanup)

describe('UpdateBanner', () => {
  it('offers Download when available and Later dismisses', () => {
    const onDownload = vi.fn(), onLater = vi.fn()
    render(<UpdateBanner state={{ phase: 'available', version: '0.6.0', pageUrl: 'https://x', canInstall: true }} onDownload={onDownload} onInstall={() => {}} onLater={onLater} />)
    expect(screen.getByText(/SeaShell 0.6.0 is available/)).toBeTruthy()
    fireEvent.click(screen.getByText('Download'))
    expect(onDownload).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText('Later'))
    expect(onLater).toHaveBeenCalledOnce()
  })
  it('shows progress, then Install and Relaunch with the warning', () => {
    const { rerender } = render(<UpdateBanner state={{ phase: 'downloading', version: '0.6.0', received: 50, total: 200 }} onDownload={() => {}} onInstall={() => {}} onLater={() => {}} />)
    expect(screen.getByText(/25%/)).toBeTruthy()
    const onInstall = vi.fn()
    rerender(<UpdateBanner state={{ phase: 'ready', version: '0.6.0' }} onDownload={() => {}} onInstall={onInstall} onLater={() => {}} />)
    fireEvent.click(screen.getByText('Install and Relaunch'))
    expect(onInstall).toHaveBeenCalledOnce()
    expect(screen.getByText(/closes every pane/)).toBeTruthy()
  })
  it('offers Try again after a failure, and Dismiss', () => {
    const onDownload = vi.fn(), onLater = vi.fn()
    render(<UpdateBanner state={{ phase: 'error', version: '0.6.0', message: 'network went away' }} onDownload={onDownload} onInstall={() => {}} onLater={onLater} />)
    expect(screen.getByText(/network went away/)).toBeTruthy()
    fireEvent.click(screen.getByText('Try again'))
    expect(onDownload).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText('Dismiss'))
    expect(onLater).toHaveBeenCalledOnce()
  })
  it('renders nothing when idle', () => {
    const { container } = render(<UpdateBanner state={{ phase: 'idle' }} onDownload={() => {}} onInstall={() => {}} onLater={() => {}} />)
    expect(container.innerHTML).toBe('')
  })
})
