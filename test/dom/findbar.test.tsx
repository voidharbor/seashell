import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FindBar } from '../../src/renderer/find/FindBar.js'

afterEach(cleanup)

function mount(onSearch = vi.fn(() => true), extra: Record<string, unknown> = {}) {
  let cb: ((r: { resultIndex: number; resultCount: number }) => void) | null = null
  const onResults = (c: typeof cb) => {
    cb = c
    return () => {
      cb = null
    }
  }
  render(
    <FindBar
      targetKey="p1"
      onSearch={onSearch}
      onClose={() => {}}
      nonce={0}
      nonceDirection="next"
      onResults={onResults}
      {...extra}
    />
  )
  return { onSearch, emit: (r: { resultIndex: number; resultCount: number }) => act(() => cb?.(r)) }
}

describe('FindBar', () => {
  it('searches as you type, debounced, incrementally', () => {
    vi.useFakeTimers()
    const { onSearch } = mount()
    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'ab' } })
    expect(onSearch).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(130))
    expect(onSearch).toHaveBeenCalledWith('ab', 'next', {
      incremental: true,
      caseSensitive: false,
      regex: false,
    })
    vi.useRealTimers()
  })

  it('Enter steps forward non-incrementally, Shift+Enter back', () => {
    const { onSearch } = mount()
    const input = screen.getByPlaceholderText('Find')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSearch).toHaveBeenLastCalledWith('x', 'next', expect.objectContaining({ incremental: false }))
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSearch).toHaveBeenLastCalledWith('x', 'prev', expect.objectContaining({ incremental: false }))
  })

  it('shows the counter from the addon', () => {
    const { emit } = mount()
    emit({ resultIndex: 2, resultCount: 14 })
    expect(screen.getByText('3 of 14')).toBeTruthy()
    emit({ resultIndex: -1, resultCount: 0 })
    expect(screen.getByText('0 of 0')).toBeTruthy()
    emit({ resultIndex: 0, resultCount: 1000 })
    expect(screen.getByText('1 of 1000+')).toBeTruthy()
  })

  it('toggles pass through to the search', () => {
    const { onSearch } = mount()
    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTitle('Match case'))
    fireEvent.click(screen.getByTitle('Regular expression'))
    fireEvent.keyDown(screen.getByPlaceholderText('Find'), { key: 'Enter' })
    expect(onSearch).toHaveBeenLastCalledWith('x', 'next', {
      incremental: false,
      caseSensitive: true,
      regex: true,
    })
  })

  it('hides regex and count when the target cannot do them', () => {
    mount(vi.fn(() => true), { capabilities: { regex: false, count: false } })
    expect(screen.queryByTitle('Regular expression')).toBeNull()
    expect(screen.queryByText(/ of /)).toBeNull()
  })
})
