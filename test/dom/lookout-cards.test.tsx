import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { CardStack, draftRows, type CardStackProps } from '../../src/renderer/lookout/CardStack.js'

const card = {
  id: 'card-1', paneId: 'p1', source: 'push' as const, kind: 'input' as const,
  question: 'ship the release?', draft: 'yes ship it', state: 'active' as const, createdAt: 1,
}

/**
 * Everything a stack needs, with the safe defaults: enabled, plugin present,
 * an ordinary input screen. Each test overrides only the thing it is about, so
 * a new prop does not mean editing every case — which is exactly what happened
 * when `enabled` was added and six tests started rendering an empty stack.
 */
function props(over: Partial<CardStackProps> = {}): CardStackProps {
  return {
    cards: [card],
    suppressedPaneId: null,
    pluginInstalled: true,
    enabled: true,
    paneName: (id) => `2 · ${id}`,
    paneColor: () => null,
    screenMode: () => 'input',
    nowMs: card.createdAt,
    drafts: new Map<string, string>(),
    onAction: () => {},
    onGotoPane: () => {},
    ...over,
  }
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
    render(<CardStack {...props({ onAction })} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes ship it tonight' } })
    fireEvent.click(screen.getByText(/approve/i))
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'approve', text: 'yes ship it tonight' })
  })
  it('suppresses the focused pane but keeps others', () => {
    render(<CardStack {...props({ suppressedPaneId: 'p1' })} />)
    expect(screen.queryByText(/ship the release/)).toBeNull()
  })
  it('stale cards disable their buttons', () => {
    const onAction = vi.fn()
    render(<CardStack {...props({ cards: [{ ...card, state: 'stale' as const }], onAction })} />)
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
    render(<CardStack {...props({ cards: [], pluginInstalled: false })} />)
    expect(screen.getByText(/plugin install c-assistant@voidharbor/)).toBeTruthy()
  })
  it('detector cards send canned lowercase words', () => {
    const onAction = vi.fn()
    render(<CardStack {...props({ cards: [{ ...card, source: 'detector' as const, draft: null }], onAction })} />)
    fireEvent.click(screen.getByText('Continue'))
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'approve', text: 'continue' })
  })
  it('selector screens get no send buttons at all', () => {
    render(<CardStack {...props({ screenMode: () => 'selector' })} />)
    expect(screen.queryByText(/approve/i)).toBeNull()
    expect(screen.queryByText('Continue')).toBeNull()
    expect(screen.getByText(/showing a picker/i)).toBeTruthy()
  })
  // Regression: null means "could not parse the pane", NOT "a picker is
  // showing". Conflating them printed a picker hint on cards whose pane sat at
  // an ordinary input box and took their send buttons away. Main's click-time
  // read is the real guard.
  it('an unreadable pane keeps its send buttons', () => {
    render(<CardStack {...props({ screenMode: () => null })} />)
    expect(screen.queryByText(/approve/i)).not.toBeNull()
    expect(screen.queryByText(/showing a picker/i)).toBeNull()
  })

  describe('off', () => {
    /**
     * Switching Lookout off has to be visibly different from Lookout having
     * nothing to say. Main clears the cards when the setting flips, but the
     * renderer must not depend on that arriving first: a stack told it is off
     * shows nothing actionable even if a card list is still in its props.
     */
    it('shows nothing actionable and says it is off', () => {
      render(<CardStack {...props({ enabled: false })} />)
      expect(screen.queryByText(/ship the release/)).toBeNull()
      expect(screen.queryByText(/approve/i)).toBeNull()
      expect(screen.getByText(/cards are off/i)).toBeTruthy()
    })
    it('does not tell you nothing needs you when you turned it off', () => {
      render(<CardStack {...props({ cards: [], enabled: false })} />)
      expect(screen.queryByText(/nothing needs you/i)).toBeNull()
    })
    // Someone who has switched cards off should not be handed install
    // instructions for the plugin that feeds them.
    it('does not push the plugin install while off', () => {
      render(<CardStack {...props({ cards: [], enabled: false, pluginInstalled: false })} />)
      expect(screen.queryByText(/plugin install/)).toBeNull()
      expect(screen.getByText(/cards are off/i)).toBeTruthy()
    })
  })

  /**
   * The card for the pane you are focused on is suppressed — you are already
   * looking at it. But the header badge counts it, so the rail was printing
   * "nothing needs you" directly beneath a count of 1.
   */
  it('says what is actually waiting when the only card is the focused pane’s', () => {
    render(<CardStack {...props({ suppressedPaneId: 'p1' })} />)
    expect(screen.queryByText(/nothing needs you/i)).toBeNull()
    expect(screen.getByText(/the pane you.re in is the one asking/i)).toBeTruthy()
  })

  it('still says nothing needs you when there really is nothing', () => {
    render(<CardStack {...props({ cards: [] })} />)
    expect(screen.getByText(/nothing needs you/i)).toBeTruthy()
  })

  /**
   * A card drops to a read-only view when its pane paints a picker, or when it
   * goes stale. It showed `card.draft` there — the model's original — which
   * reads as "your edit was thrown away" to anyone who had rewritten the
   * reply. The edit is safe; it just was not being shown.
   */
  it('the look-only view shows the user’s edit, not the model’s original', () => {
    const drafts = new Map<string, string>()
    const { rerender } = render(<CardStack {...props({ drafts })} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'no, ask me Monday' } })
    // A picker paints on the pane: the card becomes look-only.
    rerender(<CardStack {...props({ drafts, screenMode: () => 'selector' })} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('no, ask me Monday')).toBeTruthy()
    expect(screen.queryByText('yes ship it')).toBeNull()
  })

  describe('identity and age', () => {
    it("paints the card's left edge with the pane's colour", () => {
      const { container } = render(<CardStack {...props({ paneColor: () => '#35D06B' })} />)
      const el = container.querySelector('.card') as HTMLElement
      expect(el.style.borderLeftColor).toBeTruthy()
    })
    it('leaves the edge to the stylesheet for an untagged pane', () => {
      const { container } = render(<CardStack {...props({ paneColor: () => null })} />)
      const el = container.querySelector('.card') as HTMLElement
      expect(el.style.borderLeftColor).toBe('')
    })
    it('shows how long a card has been waiting', () => {
      render(<CardStack {...props({ nowMs: card.createdAt + 5 * 60_000 })} />)
      expect(screen.getByText('5m')).toBeTruthy()
    })
    // A clock skew that makes a card look like it arrives from the future must
    // print nothing, not a negative age.
    it('prints no age rather than a negative one', () => {
      const { container } = render(<CardStack {...props({ nowMs: card.createdAt - 1000 })} />)
      expect(container.querySelector('.card__age')).toBeNull()
    })
  })
})

describe('edited drafts survive the card unmounting', () => {
  /**
   * The card for the pane you focus is suppressed — you are looking at the
   * pane, so the card is redundant. That is exactly what someone does halfway
   * through editing a reply: go and read what the agent actually asked. The
   * card unmounted, its local state went with it, and coming back re-seeded
   * the box from the MODEL'S draft — replacing the user's words with wording
   * they had already rejected, still one click from being sent.
   */
  it('keeps the edit when focusing the card’s own pane hides it, then returning', () => {
    const drafts = new Map<string, string>()
    const { rerender } = render(<CardStack {...props({ drafts })} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'no, hold off until Monday' } })

    // The user focuses p1 to read the question — its card is suppressed.
    rerender(<CardStack {...props({ drafts, suppressedPaneId: 'p1' })} />)
    expect(screen.queryByRole('textbox')).toBeNull()

    // ...and comes back.
    rerender(<CardStack {...props({ drafts })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'no, hold off until Monday'
    )
  })

  it('sends the restored edit, not the model’s original', () => {
    const drafts = new Map<string, string>()
    const onAction = vi.fn()
    const { rerender } = render(<CardStack {...props({ drafts, onAction })} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'no, hold off' } })
    rerender(<CardStack {...props({ drafts, onAction, suppressedPaneId: 'p1' })} />)
    rerender(<CardStack {...props({ drafts, onAction })} />)
    fireEvent.click(screen.getByText(/approve/i))
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'approve', text: 'no, hold off' })
  })

  it('forgets the draft once the card is gone', () => {
    const drafts = new Map<string, string>()
    const { rerender } = render(<CardStack {...props({ drafts })} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'something' } })
    // Card answered or dismissed: it leaves the list entirely.
    rerender(<CardStack {...props({ drafts, cards: [] })} />)
    expect(drafts.size).toBe(0)
  })
})

describe('draftRows', () => {
  // A one-line draft used to get a five-row box: three empty lines per card,
  // and with four cards waiting that is the file tree pushed off the screen.
  it('gives a short draft a short box', () => {
    expect(draftRows('yes ship it')).toBe(2)
  })
  it('grows with the draft', () => {
    expect(draftRows('a\nb\nc\nd')).toBe(4)
  })
  it('stops growing before a long draft eats the rail', () => {
    expect(draftRows('x\n'.repeat(50))).toBe(8)
  })
})
