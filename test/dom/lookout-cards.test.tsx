import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { CardStack } from '../../src/renderer/lookout/CardStack.js'

const card = {
  id: 'card-1', paneId: 'p1', source: 'push' as const,
  question: 'ship the release?', draft: 'yes ship it', state: 'active' as const, createdAt: 1,
}

// Testing Library only auto-cleans when vitest runs with `globals: true`, which
// this config deliberately does not (see tutorial.test.tsx). Without this, every
// render stays in document.body and later queries match several mounted stacks.
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CardStack', () => {
  it('approve sends the edited textarea text', () => {
    const onAction = vi.fn()
    render(<CardStack cards={[card]} suppressedPaneId={null} pluginInstalled open={false}
      screenMode={() => 'input'} onAction={onAction} onGotoPane={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes ship it tonight' } })
    fireEvent.click(screen.getByText(/approve/i))
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'approve', text: 'yes ship it tonight' })
  })
  it('suppresses the focused pane but keeps others', () => {
    render(<CardStack cards={[card]} suppressedPaneId="p1" pluginInstalled open={false}
      screenMode={() => 'input'} onAction={() => {}} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/ship the release/)).toBeNull()
  })
  it('stale cards disable their buttons', () => {
    const onAction = vi.fn()
    render(<CardStack cards={[{ ...card, state: 'stale' as const }]} suppressedPaneId={null}
      pluginInstalled open={false} screenMode={() => 'input'} onAction={onAction} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.getByText(/session moved on/i)).toBeTruthy()
    expect((screen.getByText(/approve/i) as HTMLButtonElement).disabled).toBe(true)
    // Only send affordances are disabled — dismiss never sends, so a stale
    // card must not become permanently stuck in the stack.
    const denyButton = screen.getByText(/deny/i) as HTMLButtonElement
    expect(denyButton.disabled).toBe(false)
    fireEvent.click(denyButton)
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'dismiss' })
  })
  it('empty open stack shows install commands when the plugin is absent', () => {
    render(<CardStack cards={[]} suppressedPaneId={null} pluginInstalled={false} open
      screenMode={() => 'input'} onAction={() => {}} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.getByText(/plugin install c-assistant@voidharbor/)).toBeTruthy()
  })
  it('detector cards send canned lowercase words', () => {
    const onAction = vi.fn()
    render(<CardStack cards={[{ ...card, source: 'detector' as const, draft: null }]}
      suppressedPaneId={null} pluginInstalled open={false} screenMode={() => 'input'}
      onAction={onAction} onGotoPane={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByText('Continue'))
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'approve', text: 'continue' })
  })
  it('selector screens get no send buttons at all', () => {
    render(<CardStack cards={[card]} suppressedPaneId={null} pluginInstalled open={false}
      screenMode={() => 'selector'} onAction={() => {}} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/approve/i)).toBeNull()
    expect(screen.queryByText('Continue')).toBeNull()
    expect(screen.getByText(/showing a picker/i)).toBeTruthy()
  })
  it('an unreadable pane is treated like a selector', () => {
    render(<CardStack cards={[card]} suppressedPaneId={null} pluginInstalled open={false}
      screenMode={() => null} onAction={() => {}} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/approve/i)).toBeNull()
  })
})
