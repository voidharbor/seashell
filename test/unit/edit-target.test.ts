import { describe, expect, it } from 'vitest'
import {
  editTargetId,
  isTextField,
  terminalOwningFocus,
  type EditTargetTerminal,
} from '../../src/renderer/term/edit-target.js'

/**
 * A stand-in for an xterm container: `contains` is the only thing the resolver
 * asks of it, and it is true for the element itself as well as its children —
 * exactly as the DOM behaves, and the reason focus sitting on xterm's helper
 * textarea still resolves to the terminal that owns it.
 */
function host(...owned: unknown[]): EditTargetTerminal {
  const el = { contains: (node: unknown) => node === el || owned.includes(node) }
  return { term: { element: el } }
}

const DRAWER = 'drawer-shell'

describe('editTargetId', () => {
  it('resolves to the pane holding focus', () => {
    const paneTextarea = {}
    const terminals = new Map<string, EditTargetTerminal>([
      ['p1', host(paneTextarea)],
      ['p2', host()],
    ])
    expect(editTargetId(terminals, paneTextarea, 'p2')).toBe('p1')
  })

  /**
   * The bug this module exists for. The drawer is a terminal that is not a
   * pane, so `focusedPaneId` keeps naming the pane BEHIND it while the user
   * types in the drawer. Resolving ⌘V through the fallback sent the clipboard
   * into that agent pane's pty — a paste that looks dead in the drawer and
   * lands, possibly with a trailing newline that submits it, in an agent's
   * conversation.
   */
  it('resolves to the drawer when the drawer holds focus, not the pane behind it', () => {
    const drawerTextarea = {}
    const terminals = new Map<string, EditTargetTerminal>([
      ['p1', host()],
      [DRAWER, host(drawerTextarea)],
    ])
    // 'p1' is the focused PANE the whole time — the drawer is never a pane.
    expect(editTargetId(terminals, drawerTextarea, 'p1')).toBe(DRAWER)
  })

  it('focus on the container itself counts, not just a child', () => {
    const t = host()
    const terminals = new Map<string, EditTargetTerminal>([[DRAWER, t]])
    expect(editTargetId(terminals, t.term.element, 'p1')).toBe(DRAWER)
  })

  /**
   * Focus outside every terminal must keep the old behaviour. The file tree,
   * a Lookout card's draft box and the find input are all real places focus
   * sits while someone hits ⌘V expecting it to reach the pane they are working
   * in; returning null there would make paste dead in the common case while
   * fixing the rare one.
   */
  it('falls back to the focused pane when focus is not in any terminal', () => {
    const terminals = new Map<string, EditTargetTerminal>([['p1', host()], [DRAWER, host()]])
    expect(editTargetId(terminals, { sidebarButton: true }, 'p1')).toBe('p1')
  })

  it('falls back when nothing at all has focus', () => {
    const terminals = new Map<string, EditTargetTerminal>([['p1', host()]])
    expect(editTargetId(terminals, null, 'p1')).toBe('p1')
  })

  it('returns null only when there is no terminal focused and no focused pane', () => {
    expect(editTargetId(new Map(), null, null)).toBeNull()
  })

  /**
   * A terminal that has been disposed, or one rendered but not yet attached,
   * has no element. It must be skipped rather than throwing — the resolver
   * runs on every ⌘V, including during the frame a pane is being torn down.
   */
  it('skips terminals with no element yet', () => {
    const focused = {}
    const terminals = new Map<string, EditTargetTerminal>([
      ['dead', { term: { element: null } }],
      ['p1', host(focused)],
    ])
    expect(editTargetId(terminals, focused, null)).toBe('p1')
  })
})

describe('terminalOwningFocus', () => {
  it('distinguishes "a terminal has focus" from the fallback', () => {
    const stray = {}
    const terminals = new Map<string, EditTargetTerminal>([['p1', host()]])
    // editTargetId would answer 'p1' here, from the fallback. The caller needs
    // to know that is a fallback and not a terminal actually holding the
    // keyboard, or it cannot tell a focused text field apart from a pane.
    expect(editTargetId(terminals, stray, 'p1')).toBe('p1')
    expect(terminalOwningFocus(terminals, stray)).toBeNull()
  })
})

describe('isTextField', () => {
  const field = (over: Record<string, unknown> = {}): unknown => ({
    tagName: 'TEXTAREA',
    readOnly: false,
    disabled: false,
    ...over,
  })

  it('recognises a textarea and an ordinary input', () => {
    expect(isTextField(field())).toBe(true)
    expect(isTextField(field({ tagName: 'INPUT', type: 'text' }))).toBe(true)
    // A missing type attribute IS text.
    expect(isTextField(field({ tagName: 'INPUT', type: '' }))).toBe(true)
    expect(isTextField(field({ tagName: 'INPUT', type: 'search' }))).toBe(true)
  })
  it('recognises contenteditable', () => {
    expect(isTextField(field({ tagName: 'DIV', isContentEditable: true }))).toBe(true)
  })
  it('rejects inputs that hold no typed text', () => {
    expect(isTextField(field({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false)
    expect(isTextField(field({ tagName: 'INPUT', type: 'range' }))).toBe(false)
    expect(isTextField(field({ tagName: 'INPUT', type: 'color' }))).toBe(false)
  })
  /**
   * A field you cannot type into must keep falling through to the pane, or ⌘V
   * over a read-only draft (the look-only view of a card) would land nowhere
   * at all instead of doing what it has always done.
   */
  it('rejects readonly and disabled fields', () => {
    expect(isTextField(field({ readOnly: true }))).toBe(false)
    expect(isTextField(field({ disabled: true }))).toBe(false)
  })
  it('rejects buttons, the file tree and nothing at all', () => {
    expect(isTextField(field({ tagName: 'BUTTON' }))).toBe(false)
    expect(isTextField(field({ tagName: 'DIV' }))).toBe(false)
    expect(isTextField(null)).toBe(false)
    expect(isTextField(undefined)).toBe(false)
  })
  /**
   * The ordering rule this whole module rests on. xterm receives keystrokes
   * through a real <textarea> inside its container, so a terminal IS a text
   * field structurally — the caller must ask terminalOwningFocus first, and
   * this test exists so that stays true if anyone reorders the checks.
   */
  it("says yes to xterm's own helper textarea, which is why order matters", () => {
    const xtermSink = { tagName: 'TEXTAREA', readOnly: false, disabled: false }
    expect(isTextField(xtermSink)).toBe(true)
    const terminals = new Map<string, EditTargetTerminal>([['p1', host(xtermSink)]])
    expect(terminalOwningFocus(terminals, xtermSink)).toBe('p1')
  })
})
