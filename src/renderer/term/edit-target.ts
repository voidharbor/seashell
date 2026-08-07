/**
 * Where an Edit-menu action goes.
 *
 * The Edit accelerators (⌘C / ⌘V / ⌘A / ⌘K) are menu accelerators, and menu.ts
 * spells out why: they fire regardless of DOM focus and are forwarded to the
 * renderer to be dispatched on whatever is focused. That dispatch never
 * happened for these four. Every one of them resolved its target as
 * `activeTab.focusedPaneId` — correct only while the sole place text can go is
 * a pane, which stopped being true twice over:
 *
 *   1. The ⌘J shell drawer is a real terminal that is deliberately NOT a pane.
 *      With it focused, `focusedPaneId` still named the pane behind it, so ⌘V
 *      pasted the clipboard into an AGENT'S pty. That is worse than the "paste
 *      does nothing in the drawer" it looks like from the front: a clipboard
 *      ending in a newline submits itself into that agent's conversation, and
 *      the drawer's whole isolation rule is that nothing in it reaches an
 *      agent's pty.
 *
 *   2. The app is full of ordinary text fields — a Lookout card's draft box,
 *      the find bar, the project name box, a pane rename. Because these items
 *      are deliberately NOT `role: 'paste'` (a role would swallow the chord
 *      before a focused terminal ever saw it), the browser's own paste never
 *      runs. So ⌘V while editing a card's drafted reply did not paste into the
 *      draft: it typed the clipboard into the pane behind the card.
 *
 * Hence two questions, asked in this order, and the order is the whole design:
 *
 *   `terminalOwningFocus` FIRST, because xterm keeps a real <textarea> inside
 *   its container to receive keystrokes. That textarea is a text field by every
 *   structural test, so asking "is this a text field" first would classify
 *   every terminal in the window as one and send ⌘V nowhere useful.
 *
 *   `isTextField` SECOND, for focus that is in an ordinary editable element.
 *
 *   Neither: fall back to the focused pane, which is what these commands have
 *   always done and the right answer when focus is on the file tree, a button,
 *   or nothing at all. Doing nothing there would make ⌘V dead whenever focus
 *   happened to be in the sidebar.
 */

/** The part of a terminal this resolver needs: its container element. */
export interface EditTargetTerminal {
  readonly term: { readonly element?: { contains(node: unknown): boolean } | null }
}

/**
 * The id of the terminal that owns the keyboard, or null if none does.
 *
 * @param terminals every live terminal, keyed by pane id (panes + the drawer)
 * @param active    `document.activeElement` when the command fired
 */
export function terminalOwningFocus(
  terminals: ReadonlyMap<string, EditTargetTerminal>,
  active: unknown
): string | null {
  if (!active) return null
  for (const [id, t] of terminals) {
    const el = t.term.element
    // `contains` is true for the element itself as well as its descendants,
    // which is what we want: focus legitimately sits on either the xterm
    // container or the helper textarea inside it.
    if (el && el.contains(active)) return id
  }
  return null
}

/**
 * The terminal an Edit command acts on: the one holding the keyboard, else the
 * focused pane. Callers must check `isTextField` first — see the module note.
 */
export function editTargetId(
  terminals: ReadonlyMap<string, EditTargetTerminal>,
  active: unknown,
  fallbackPaneId: string | null
): string | null {
  return terminalOwningFocus(terminals, active) ?? fallbackPaneId
}

/**
 * Input types that hold editable text. `email`, `url`, `tel` and `number` are
 * here because they are text fields with a keyboard caret whatever the widget
 * around them looks like; `checkbox`, `range`, `color` and friends are not, and
 * pasting into one is meaningless.
 *
 * A missing `type` attribute is `text` by definition, so undefined belongs in
 * this set too.
 */
const TEXT_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
])

/**
 * Whether focus is in an ordinary editable field — one that should receive the
 * paste itself rather than forwarding it to a terminal.
 *
 * Structural, not by class name: any text field added later gets this for free,
 * and nothing has to remember to register itself. Readonly and disabled fields
 * are excluded — text cannot be typed into them, so an Edit command aimed at
 * one should keep falling through to the pane rather than landing nowhere.
 */
export function isTextField(active: unknown): boolean {
  if (!active || typeof active !== 'object') return false
  const el = active as {
    tagName?: unknown
    isContentEditable?: unknown
    type?: unknown
    readOnly?: unknown
    disabled?: unknown
  }
  if (el.readOnly === true || el.disabled === true) return false
  if (el.isContentEditable === true) return true
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false
  const type = typeof el.type === 'string' ? el.type.toLowerCase() : ''
  return TEXT_INPUT_TYPES.has(type)
}
