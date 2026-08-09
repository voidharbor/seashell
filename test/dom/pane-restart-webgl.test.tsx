import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

/**
 * A restarted pane must be handed a WebGL context.
 *
 * Restarting disposes the pane's PaneTerminal and builds a new one. The
 * construction effect is keyed on `generation`; the effect that owns WebGL was
 * keyed only on `[pane.id, hidden]`, neither of which changes on a restart. So
 * the replacement terminal never got `enableWebgl()` and quietly ran on the DOM
 * renderer — where `customGlyphs` does nothing and every TUI border grows 1px
 * gaps — until the pane happened to be hidden and shown again.
 *
 * That is invisible to a typecheck and to every other test, and it presents as
 * an intermittent rendering glitch rather than as a restart bug, so it is worth
 * the mocking scaffolding below to pin it.
 */

/** Every PaneTerminal built during a test, in construction order. */
const built: FakeTerminal[] = []

class FakeTerminal {
  enableWebgl = vi.fn()
  disableWebgl = vi.fn()
  refit = vi.fn()
  dispose = vi.fn()
  write = vi.fn()
  setFontSize = vi.fn()
  markExited = vi.fn()
  selectInputLine = vi.fn()
  findNext = vi.fn(() => true)
  findPrevious = vi.fn(() => true)
  clearSearch = vi.fn()
  term = { cols: 80, rows: 24, focus: vi.fn() }

  constructor(public readonly opts: { paneId: string }) {
    built.push(this)
  }
}

vi.mock('../../src/renderer/term/terminal.js', () => ({
  PaneTerminal: FakeTerminal,
  loadTerminalFont: vi.fn(async () => true),
  effectiveFontSize: (px: number) => px,
}))

const { PaneView, terminals } = await import('../../src/renderer/panes/PaneView.js')
type PaneViewProps = Parameters<typeof PaneView>[0]

function pane(over: Record<string, unknown> = {}): PaneViewProps['pane'] {
  return {
    id: 'p1',
    kind: 'term',
    cwd: '/Users/test',
    label: 'zsh',
    labelIsCustom: false,
    command: 'zsh',
    pid: 4242,
    status: 'live',
    generation: 0,
    ...over,
  } as PaneViewProps['pane']
}

function props(over: Partial<PaneViewProps> = {}): PaneViewProps {
  return {
    pane: pane(),
    index: 1,
    rect: { x: 0, y: 0, width: 800, height: 600 },
    focused: true,
    hidden: false,
    fontSize: 13,
    findOpen: false,
    findNonce: 0,
    findDirection: 'next',
    onCloseFind: () => {},
    onFocus: () => {},
    onClose: () => {},
    onZoom: () => {},
    onReveal: () => {},
    onSpawned: () => {},
    onRestart: () => {},
    onUrlChange: () => {},
    onToggleRaw: () => {},
    onSetColor: () => {},
    onTitle: () => {},
    onCwd: () => {},
    glow: false,
    onToast: () => {},
    ...over,
  } as PaneViewProps
}

beforeEach(() => {
  built.length = 0
  terminals.clear()
  ;(globalThis as Record<string, unknown>).window = globalThis.window
  ;(window as unknown as Record<string, unknown>).seashell = {
    pty: {
      spawn: vi.fn(async () => ({ ok: true, pid: 4242 })),
      write: vi.fn(),
      resize: vi.fn(),
    },
    open: { externalHttp: vi.fn(async () => undefined) },
    fs: { statBatch: vi.fn(async () => ({ results: [] })) },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('a restarted pane keeps its WebGL renderer', () => {
  it('enables WebGL on the terminal built for a new generation', () => {
    const { rerender } = render(<PaneView {...props()} />)

    expect(built).toHaveLength(1)
    expect(built[0]!.enableWebgl).toHaveBeenCalledTimes(1)

    // A restart: same pane, same visibility, new generation.
    rerender(<PaneView {...props({ pane: pane({ generation: 1 }) })} />)

    expect(built).toHaveLength(2)
    expect(built[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(
      built[1]!.enableWebgl,
      'the replacement terminal was never given a WebGL context, so the pane fell back to the DOM renderer'
    ).toHaveBeenCalledTimes(1)
  })

  it('still leaves a hidden pane without a context after a restart', () => {
    const { rerender } = render(<PaneView {...props({ hidden: true })} />)
    expect(built[0]!.enableWebgl).not.toHaveBeenCalled()

    rerender(<PaneView {...props({ hidden: true, pane: pane({ generation: 1 }) })} />)

    expect(built).toHaveLength(2)
    expect(built[1]!.enableWebgl).not.toHaveBeenCalled()
    expect(built[1]!.disableWebgl).toHaveBeenCalled()
  })

  it('does not rebuild the terminal when nothing but an ordinary prop changes', () => {
    const { rerender } = render(<PaneView {...props()} />)
    rerender(<PaneView {...props({ focused: false })} />)
    expect(built).toHaveLength(1)
  })
})
