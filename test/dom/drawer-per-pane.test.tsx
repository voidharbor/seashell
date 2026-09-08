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
  /** `onDoubleClick` is kept because it is the only way in: the real gesture
   *  needs a live xterm to hit-test, so a test drives the callback directly. */
  constructor(
    public readonly opts: {
      paneId: string
      onDoubleClick: (x: number, y: number, mods: { meta: boolean; alt: boolean }) => void
    }
  ) {
    built.push(this)
  }
}
const built: FakeTerminal[] = []

/**
 * What the drawer believes is under the cursor.
 *
 * The real `pathAtPoint` reads `term.element.getBoundingClientRect()` and the
 * xterm buffer, neither of which a fake terminal has, so it would return null
 * before the handler under test ever ran. Stubbing it is what makes the
 * resolve-and-report half reachable.
 */
interface FakeHit {
  path: string
  start: number
  end: number
  absY: number
}
const pathAtPoint = vi.fn<(term: unknown, x: number, y: number) => FakeHit | null>(() => null)
/** A token that touches neither edge of an 80-column row, so the wrap-join
 *  pass adds nothing and the candidate list is the token alone. */
const hitOf = (path: string): FakeHit => ({ path, start: 0, end: path.length, absY: 1 })

vi.mock('../../src/renderer/term/terminal.js', () => ({
  PaneTerminal: FakeTerminal,
  loadTerminalFont: vi.fn(async () => true),
  effectiveFontSize: (px: number) => px,
}))
vi.mock('../../src/renderer/panes/PaneView.js', () => ({
  terminals: new Map(),
  currentHostname: () => 'testhost',
}))
vi.mock('../../src/renderer/panes/pathclick.js', () => ({
  pathAtPoint: (term: unknown, x: number, y: number) => pathAtPoint(term, x, y),
  // Reads the xterm buffer for real, so it is stubbed for the same reason
  // pathAtPoint is: there is no buffer behind a fake terminal.
  rowContext: () => ({ prevRow: null, nextRow: null, startCol: 0, endCol: 13, cols: 80 }),
}))

const { DrawerShell } = await import('../../src/renderer/drawer/DrawerShell.js')
const { terminals } = await import('../../src/renderer/panes/PaneView.js')
type DrawerProps = Parameters<typeof DrawerShell>[0]

let spawns: Array<{ paneId: string; cwd: string }> = []

/**
 * Typed, not asserted.
 *
 * This used to be one object literal ending in `as DrawerProps`, and the
 * assertion silently absorbed a newly required prop: `onToast` was missing here
 * and TS2741 never fired. Declaring the defaults as a checked `DrawerProps`
 * puts that back, so the next required prop breaks this file loudly. The
 * assertion survives only on the merge, where spreading a Partial widens every
 * field to `| undefined`.
 *
 * The default `onToast` throws rather than being a silent no-op: a toast is a
 * user-visible claim that something failed, and a test that provokes one
 * without meaning to should say so.
 */
const defaults: DrawerProps = {
  paneId: 'p1',
  paneLabel: 'zsh',
  open: true,
  height: 240,
  fontSize: 13,
  focusCwd: '/Users/test/one',
  gridWidth: 800,
  onReveal: () => {},
  onOpen: (path: string, mode: string) => {
    throw new Error(`unexpected open: ${path} as ${mode}`)
  },
  searchRoot: '/Users/test',
  onToast: (message: string) => {
    throw new Error(`unexpected toast: ${message}`)
  },
  onClose: () => {},
  onDragStart: () => {},
}

function props(over: Partial<DrawerProps> = {}): DrawerProps {
  return { ...defaults, ...over } as DrawerProps
}

beforeEach(() => {
  built.length = 0
  spawns = []
  terminals.clear()
  pathAtPoint.mockReturnValue(null)
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
    fs: {
      statBatch: vi.fn(async () => ({ results: [] })),
      findBySuffix: vi.fn(async () => ({ paths: [], truncated: false })),
    },
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

/**
 * A double-clicked path that resolves nowhere used to end in silence here, the
 * same way it did in a pane: `statBatch` omits everything that does not exist,
 * so `results[0]` was undefined and the handler just returned. Silence is
 * indistinguishable from a dead feature, which is exactly how it was reported.
 */
describe('a path that resolves nowhere', () => {
  it('names the candidate and the directory it was resolved against', async () => {
    const onToast = vi.fn()
    const onReveal = vi.fn()
    render(<DrawerShell {...props({ onToast, onReveal, focusCwd: '/Users/test/one' })} />)

    // No OSC 7 has arrived, so the pane's own directory is what it resolves
    // against, which is the case a fresh drawer is always in.
    pathAtPoint.mockReturnValue(hitOf('notafile/x.ts'))
    built[0]!.opts.onDoubleClick(40, 40, { meta: false, alt: false })

    await vi.waitFor(() => expect(onToast).toHaveBeenCalledTimes(1))
    expect(onToast).toHaveBeenCalledWith('No file at notafile/x.ts from /Users/test/one')
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('reveals instead of toasting when the path is real', async () => {
    const onToast = vi.fn()
    const onReveal = vi.fn()
    ;(window as unknown as { seashell: { fs: { statBatch: unknown } } }).seashell.fs.statBatch =
      vi.fn(async () => ({
        results: [{ i: 0, resolved: '/Users/test/one/real.ts', kind: 'file', size: 1, exec: false }],
      }))
    render(<DrawerShell {...props({ onToast, onReveal })} />)

    pathAtPoint.mockReturnValue(hitOf('real.ts'))
    built[0]!.opts.onDoubleClick(40, 40, { meta: false, alt: false })

    await vi.waitFor(() => expect(onReveal).toHaveBeenCalledWith('/Users/test/one/real.ts', false))
    expect(onToast).not.toHaveBeenCalled()
  })
})


/**
 * The modifiers ride along with the same gesture. A plain double-click only
 * reveals, which is inert; Cmd asks for the file itself, and Cmd+Opt asks for
 * it outside SeaShell. Both still reveal, because seeing where a file lives is
 * the part that is never wrong.
 */
describe('Cmd and Cmd+Opt on a resolved path', () => {
  function hitting(): void {
    ;(window as unknown as { seashell: { fs: { statBatch: unknown } } }).seashell.fs.statBatch =
      vi.fn(async () => ({
        results: [{ i: 0, resolved: '/Users/test/one/real.ts', kind: 'file', size: 1, exec: false }],
      }))
  }

  it('previews on Cmd', async () => {
    hitting()
    const onOpen = vi.fn()
    const onReveal = vi.fn()
    render(<DrawerShell {...props({ onOpen, onReveal })} />)

    pathAtPoint.mockReturnValue(hitOf('real.ts'))
    built[0]!.opts.onDoubleClick(40, 40, { meta: true, alt: false })

    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('/Users/test/one/real.ts', 'preview'))
    expect(onReveal).toHaveBeenCalledWith('/Users/test/one/real.ts', false)
  })

  it('hands the file to the OS on Cmd+Opt', async () => {
    hitting()
    const onOpen = vi.fn()
    render(<DrawerShell {...props({ onOpen })} />)

    pathAtPoint.mockReturnValue(hitOf('real.ts'))
    built[0]!.opts.onDoubleClick(40, 40, { meta: true, alt: true })

    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('/Users/test/one/real.ts', 'os'))
  })

  it('never opens a directory, whatever is held down', async () => {
    ;(window as unknown as { seashell: { fs: { statBatch: unknown } } }).seashell.fs.statBatch =
      vi.fn(async () => ({
        results: [{ i: 0, resolved: '/Users/test/one/src', kind: 'dir', size: 0, exec: false }],
      }))
    const onOpen = vi.fn()
    const onReveal = vi.fn()
    render(<DrawerShell {...props({ onOpen, onReveal })} />)

    pathAtPoint.mockReturnValue(hitOf('src'))
    built[0]!.opts.onDoubleClick(40, 40, { meta: true, alt: true })

    await vi.waitFor(() => expect(onReveal).toHaveBeenCalledWith('/Users/test/one/src', true))
    expect(onOpen).not.toHaveBeenCalled()
  })
})
