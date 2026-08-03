import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { CardStack } from '../../src/renderer/lookout/CardStack.js'

const card = {
  id: 'card-1', paneId: 'p1', source: 'push' as const, kind: 'input' as const,
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
    render(<CardStack cards={[card]} suppressedPaneId={null} paneName={(id) => `2 · ${id}`} pluginInstalled
      screenMode={() => 'input'} onAction={onAction} onGotoPane={() => {}} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes ship it tonight' } })
    fireEvent.click(screen.getByText(/approve/i))
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'approve', text: 'yes ship it tonight' })
  })
  it('suppresses the focused pane but keeps others', () => {
    render(<CardStack cards={[card]} suppressedPaneId="p1" paneName={(id) => `2 · ${id}`} pluginInstalled
      screenMode={() => 'input'} onAction={() => {}} onGotoPane={() => {}} />)
    expect(screen.queryByText(/ship the release/)).toBeNull()
  })
  it('stale cards disable their buttons', () => {
    const onAction = vi.fn()
    render(<CardStack cards={[{ ...card, state: 'stale' as const }]} suppressedPaneId={null} paneName={(id) => `2 · ${id}`}
      pluginInstalled  screenMode={() => 'input'} onAction={onAction} onGotoPane={() => {}} />)
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
    render(<CardStack cards={[]} suppressedPaneId={null} paneName={(id) => `2 · ${id}`} pluginInstalled={false}
      screenMode={() => 'input'} onAction={() => {}} onGotoPane={() => {}} />)
    expect(screen.getByText(/plugin install c-assistant@voidharbor/)).toBeTruthy()
  })
  it('detector cards send canned lowercase words', () => {
    const onAction = vi.fn()
    render(<CardStack cards={[{ ...card, source: 'detector' as const, draft: null }]}
      suppressedPaneId={null} paneName={(id) => `2 · ${id}`} pluginInstalled  screenMode={() => 'input'}
      onAction={onAction} onGotoPane={() => {}} />)
    fireEvent.click(screen.getByText('Continue'))
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'approve', text: 'continue' })
  })
  it('selector screens get no send buttons at all', () => {
    render(<CardStack cards={[card]} suppressedPaneId={null} paneName={(id) => `2 · ${id}`} pluginInstalled
      screenMode={() => 'selector'} onAction={() => {}} onGotoPane={() => {}} />)
    expect(screen.queryByText(/approve/i)).toBeNull()
    expect(screen.queryByText('Continue')).toBeNull()
    expect(screen.getByText(/showing a picker/i)).toBeTruthy()
  })
  // Regression: null means "could not parse the pane", NOT "a picker is
  // showing". Conflating them printed a picker hint on cards whose pane sat at
  // an ordinary input box and took their send buttons away. Main's click-time
  // read is the real guard.
  it('an unreadable pane keeps its send buttons', () => {
    render(<CardStack cards={[card]} suppressedPaneId={null} paneName={(id) => `2 · ${id}`} pluginInstalled
      screenMode={() => null} onAction={() => {}} onGotoPane={() => {}} />)
    expect(screen.queryByText(/approve/i)).not.toBeNull()
    expect(screen.queryByText(/showing a picker/i)).toBeNull()
  })
})
