import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

/**
 * The drawer is one shell per pane.
 *
 * The first version shared a single shell across every pane, which is what the
 * feature's original requester reported back: "it seems to be independent of
 * the selected pane, just one shell for all of them". What matters now is that
 * two panes get two ptys, each spawned in its own pane's directory, and that a
 * hidden one costs nothing.
 *
 * Driven at the component rather than through ⌘J: the accelerator is a native
 * menu item, and synthetic keystrokes do not reach this app's menu on the
 * machine this was written on, so an end-to-end script cannot toggle it.
 */

class FakeTerminal {
  enableWebgl = vi.fn()
  disableWebgl = vi.fn()
  refit = vi.fn()
  dispose = vi.fn()
  write = vi.fn()
  setFontSize = vi.fn()
  markExited = vi.fn()
  term = { cols: 80, rows: 24, focus: vi.fn() }
  constructor(public readonly opts: { paneId: string }) {
    built.push(this)
  }
}
const built: FakeTerminal[] = []

vi.mock('../../src/renderer/term/terminal.js', () => ({
  PaneTerminal: FakeTerminal,
  loadTerminalFont: vi.fn(async () => true),
  effectiveFontSize: (px: number) => px,
}))
vi.mock('../../src/renderer/panes/PaneView.js', () => ({
  terminals: new Map(),
  currentHostname: () => 'testhost',
}))

const { DrawerShell } = await import('../../src/renderer/drawer/DrawerShell.js')
const { terminals } = await import('../../src/renderer/panes/PaneView.js')
type DrawerProps = Parameters<typeof DrawerShell>[0]

let spawns: Array<{ paneId: string; cwd: string }> = []

function props(over: Partial<DrawerProps> = {}): DrawerProps {
  return {
    paneId: 'p1',
    paneLabel: 'zsh',
    open: true,
    height: 240,
    fontSize: 13,
    focusCwd: '/Users/test/one',
    gridWidth: 800,
    onReveal: () => {},
    onClose: () => {},
    onDragStart: () => {},
    ...over,
  } as DrawerProps
}

beforeEach(() => {
  built.length = 0
  spawns = []
  terminals.clear()
  ;(window as unknown as Record<string, unknown>).seashell = {
    pty: {
      spawn: vi.fn(async (req: { paneId: string; cwd: string }) => {
        spawns.push({ paneId: req.paneId, cwd: req.cwd })
        return { ok: true, pid: 1 }
      }),
      write: vi.fn(),
      resize: vi.fn(),
      onExit: vi.fn(() => () => {}),
    },
    open: { externalHttp: vi.fn() },
    fs: { statBatch: vi.fn(async () => ({ results: [] })) },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the drawer is per pane', () => {
  it('spawns a shell under a pty id namespaced to its pane', () => {
    render(<DrawerShell {...props()} />)
    expect(spawns).toEqual([{ paneId: 'drawer:p1', cwd: '/Users/test/one' }])
    expect(terminals.has('drawer:p1')).toBe(true)
  })

  it('gives two panes two shells, each in its own directory', () => {
    render(<DrawerShell {...props({ paneId: 'p1', focusCwd: '/Users/test/one' })} />)
    render(<DrawerShell {...props({ paneId: 'p2', focusCwd: '/Users/test/two' })} />)

    expect(spawns).toEqual([
      { paneId: 'drawer:p1', cwd: '/Users/test/one' },
      { paneId: 'drawer:p2', cwd: '/Users/test/two' },
    ])
    // Both stay registered, which is what lets a shell survive switching away.
    expect(terminals.has('drawer:p1')).toBe(true)
    expect(terminals.has('drawer:p2')).toBe(true)
  })

  it('costs nothing while hidden: no spawn, no GPU context', () => {
    render(<DrawerShell {...props({ open: false })} />)
    expect(spawns).toEqual([])
    expect(built[0]!.enableWebgl).not.toHaveBeenCalled()
  })

  it('spawns only once for a pane, however often the drawer is toggled', () => {
    const { rerender } = render(<DrawerShell {...props({ open: true })} />)
    rerender(<DrawerShell {...props({ open: false })} />)
    rerender(<DrawerShell {...props({ open: true })} />)
    expect(spawns).toHaveLength(1)
  })

  it('names the pane in its header, so which shell you are in is visible', () => {
    const { container } = render(<DrawerShell {...props({ paneLabel: 'solar-bear' })} />)
    expect(container.querySelector('.drawer__label')?.textContent).toContain('solar-bear')
  })

  it('releases the GPU context when it goes hidden', () => {
    const { rerender } = render(<DrawerShell {...props({ open: true })} />)
    expect(built[0]!.enableWebgl).toHaveBeenCalled()
    rerender(<DrawerShell {...props({ open: false })} />)
    expect(built[0]!.disableWebgl).toHaveBeenCalled()
  })
})
