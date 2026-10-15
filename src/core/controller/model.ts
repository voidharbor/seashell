/**
 * The wire shape between the core and the native shell (redesign spec 4.4).
 *
 * The core owns every piece of UI state and sends the whole snapshot as one
 * `ui:model` after each change; the shell draws it and reports raw input back
 * as `UiEvent`s keyed by the target ids below. DIP = device-independent pixels
 * with `uiScale` already applied, so the shell only multiplies by its DPI scale.
 *
 * Target id grammar (the shell's hit testing keys on these): `tab:<id>`,
 * `tab:<id>:close`, `tab:new`, `tab:<id>:rename` (the edit widget),
 * `strip:empty`, `pane:<id>:title`, `pane:<id>:close`, `pane:<id>:color`,
 * `pane:<id>:link`, `pane:<id>:restart`, `pane:<id>:grid`, `divider:<id>`,
 * `find:query`, `find:case`, `find:regex`, `find:next`, `find:prev`,
 * `find:close`, `restore:yes`, `restore:fresh`, `zoom:badge`, `sleep`,
 * `settings`, `empty:newtab`, `web:new`, `pane:new`.
 *
 * Drags the shell tracks itself and reports as one `click` each: a tab
 * dragged along the strip sends `tab:<id>:move:<index>` every time it crosses
 * into a new slot; a pane dragged by its title and dropped on another sends
 * `pane:<id>:moveTo:<targetId>:<where>` once, `where` being `swap`, `left`,
 * `right`, `top` or `bottom`. With the Graphite theme the shell draws the
 * caption buttons itself: `caption:min`, `caption:max`, `caption:close`
 * (handled in the shell, never sent).
 *
 * The file explorer (Phase 2): `sidebar:row:<path>` (click selects, a right
 * button click opens the menu at the event's point, dblclick toggles a
 * directory or opens a file), `sidebar:twisty:<path>` (click toggles without
 * selecting), `sidebar:grip` (down/move/up resize, dblclick resets),
 * `sidebar:refresh`, `sidebar:strip` (click copies), `sidebar:menu:<id>` (a
 * context menu item), `sidebar:menu` (the menu itself, for `key Escape`),
 * `sidebar:empty`. The path is everything after the prefix, colons included.
 *
 * The shell drawer (Phase 2): `drawer:grip` (down/move/up resize; the event's
 * y is the drawer's top edge), `drawer:cd`, `drawer:close`, `drawer:grid` (a
 * `down` there gives the drawer the keyboard). Its grid is an ordinary grid
 * under the pty id `drawer:<paneId>`.
 *
 * Sheets (Phase 2): `sheet:<kind>:<fieldId>` for a check, text or button
 * field, `sheet:<kind>:<fieldId>:<optionId>` for a buttons option,
 * `sheet:<kind>:btn:<id>` for a bottom button, `sheet:close`, and
 * `sheet:<kind>` itself for `key Escape`. The Projects sheet's rows:
 * `sheet:projects:row:<id>:delete|confirm|cancel|add|open`. The tutorial
 * (`sheet:tutorial`) takes `key` Escape, ArrowLeft and ArrowRight; its dots are
 * `sheet:tutorial:step:<n>`, its check `sheet:tutorial:dontShow`, its buttons
 * `sheet:tutorial:btn:skip|back|next`.
 *
 * The update banner (Phase 2): `update:download|page|later|install|retry|dismiss`.
 *
 * The pane popovers (Phase 2): `pane:<id>:color` and `pane:<id>:link` open
 * them, `popover:<itemId>` picks an item (a colour key or `none`; another
 * pane's id or `unlink`), and `popover` itself takes `key Escape`. Any `down`
 * outside the popover closes it.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface TabModel {
  id: string
  name: string
  active: boolean
  renaming: boolean
}

export interface PaneModel {
  id: string
  kind: 'term' | 'file' | 'web'
  rect: Rect
  gridRect: Rect
  cols: number
  rows: number
  index: number
  label: string
  tooltip: string
  badge: string
  memBadge: string | null
  memHigh: boolean
  zoomPercent: number | null
  fontPx: number
  color: string | null
  focused: boolean
  attention: 'none' | 'waiting' | 'done'
  status: 'starting' | 'live' | 'exited'
  exit: { text: string; failed: boolean } | null
  linked: boolean
  linkEnabled: boolean
}

export interface DividerModel {
  id: string
  rect: Rect
  orientation: 'vertical' | 'horizontal'
}

export interface FindModel {
  open: boolean
  paneId: string | null
  query: string
  caseSensitive: boolean
  regex: boolean
  count: { index: number; total: number; capped: boolean } | null
  miss: boolean
}

export interface RestoreCardModel {
  tabs: number
  panes: number
  savedAt: string
}

export interface ChordModel {
  chord: string
  command: string
}

export interface SidebarRow {
  /** 'row:' + path; the shell's target is 'sidebar:' + id. */
  id: string
  path: string
  /** 'Home' for the root when it is home, else the entry's own name. */
  name: string
  depth: number
  isDir: boolean
  expanded: boolean
  selected: boolean
  /** Matched by .gitignore: drawn at 45 percent. */
  ignored: boolean
  /** The reveal flash, 2.5 s. */
  flashing: boolean
  /** '#rrggbb' for a file's extension chip, null for none and for directories. */
  chip: string | null
  /** '(ENOENT)' style text for an expanded directory that failed to list. */
  error: string | null
  /** This row is followed by the '… too many entries to list' line. */
  truncatedAfter: boolean
}

export interface SidebarMenuItem {
  id: 'open-outside' | 'reveal'
  label: string
  enabled: boolean
}

export interface SidebarModel {
  visible: boolean
  /** The column, DIP, including the path strip; all zero while hidden. */
  rect: Rect
  /** The 6 DIP grip between the column and the grid; all zero while hidden. */
  gripRect: Rect
  /** The stored base width, DIP at uiScale 1 (170 to 620); the column is this times uiScale. */
  width: number
  /**
   * The rows, as `rowsSeq` numbers them. A `ui:model` on the wire leaves this
   * key out when `rowsSeq` is the one it sent last; the shell keeps the rows it has.
   */
  rows: SidebarRow[]
  /**
   * Bumps whenever `rows` changes (an expand, a listing, the selection, the
   * flash, showing or hiding), so a model that only moves a divider, retitles a
   * pane or ticks the status does not carry every row again.
   */
  rowsSeq: number
  /** Bumps when the shell should scroll `revealRowId` to the centre. */
  revealSeq: number
  revealRowId: string | null
  /** The selected path, or the root; the shell truncates it from the left. Empty while hidden. */
  strip: string
  menu: { rowId: string; x: number; y: number; items: SidebarMenuItem[] } | null
}

/**
 * The shell drawer (`DrawerShell.tsx`): one shell per pane, shown over the
 * bottom of the grid area for the focused terminal pane. Rects are all zero
 * and the ids null while it is closed.
 */
export interface DrawerModel {
  open: boolean
  /** The panel over the bottom of the grid area, DIP; the panes under it keep their rects. */
  rect: Rect
  /** The 6 DIP grip straddling the panel's top edge. */
  gripRect: Rect
  /** The drawer's terminal, below the header. */
  gridRect: Rect
  /** The stored base height, DIP at uiScale 1 (120 to 800); the panel is this times uiScale. */
  height: number
  /** The pane whose shell is shown (the focused terminal pane). */
  paneId: string | null
  /** 'drawer:<paneId>', the id of its pty and its grid. */
  ptyId: string | null
  cols: number
  rows: number
  fontPx: number
  /**
   * 'Shell · <pane label>'; the shell's OSC title, else its cwd, else the
   * pane's; `showCd` while the drawer's cwd is known and differs from the pane's.
   */
  header: { label: string; title: string; showCd: boolean }
  status: 'starting' | 'live' | 'exited'
  /** Keyboard focus is in the drawer's grid. */
  focused: boolean
}

export interface SheetOption {
  id: string
  label: string
  selected: boolean
  disabled: boolean
  tooltip: string | null
  /** '#rrggbb' for an accent swatch, else null. */
  swatch: string | null
}

/** One saved project in the Projects sheet's `rows` field. */
export interface SheetRow {
  id: string
  name: string
  /** 'N tabs · M panes · saved <ago>'. */
  meta: string
  /** Delete was pressed once: the row shows Delete (danger) and Cancel. */
  confirming: boolean
}

export interface SheetField {
  id: string
  kind: 'buttons' | 'check' | 'text' | 'button' | 'note' | 'rows'
  label: string
  /**
   * A check's state, a text field's value, a button's caption. A button with
   * no value has its label as the caption and no row label.
   */
  value?: string | boolean
  options?: SheetOption[]
  placeholder?: string
  maxLen?: number
  /** The detail line under the field (beside a captionless button; a `rows` field with no rows shows it instead). */
  note?: string
  /** A button that does nothing yet (the Projects save button with no name). */
  disabled?: boolean
  /** A text field's value revision: bumps when the core sets the value itself, and the shell reloads its widget from `value`. */
  rev?: number
  /** A `rows` field's rows. */
  rows?: SheetRow[]
}

export interface SheetSection {
  title: string
  fields: SheetField[]
}

/** One sheet at a time: it dims the window like the restore card and takes the keyboard. */
export interface SheetModel {
  kind: 'settings' | 'projects' | 'tutorial'
  title: string
  /** The card's width, DIP (uiScale in); the shell caps it at 88 percent of the body. */
  width: number
  sections: SheetSection[]
  buttons: Array<{ id: string; label: string; isDefault: boolean; disabled: boolean }>
  focusField: string | null
}

/**
 * The strip above the status bar (`UpdateBanner.tsx`): one phase of
 * `UpdateState` with its text and at most two buttons, null while idle or
 * while the offered version was put off with Later.
 */
export interface UpdateBannerModel {
  phase: 'available' | 'downloading' | 'ready' | 'error'
  text: string
  buttons: Array<{ id: 'download' | 'page' | 'later' | 'install' | 'retry' | 'dismiss'; label: string }>
  /** 0 to 1 while a download with a known size runs, else null. */
  progress: number | null
  /** The band the body leaves for it above the status bar, DIP (the core's layout). */
  rect: Rect
}

/** One row of a pane popover (`ColorPicker.tsx`, `LinkPicker.tsx`). */
export interface PopoverItem {
  /** The target is `popover:<id>`: a colour key or `none`, another pane's id, `unlink`, or `empty` for the no-panes line. */
  id: string
  label: string
  /** '#rrggbb' for a colour, else null. */
  swatch: string | null
  selected: boolean
  disabled: boolean
  /** Right-aligned in `badgeText`: `no agent`, `linked`. */
  note: string | null
}

/**
 * The colour or link popover of one pane, drawn by the shell's `Popup` with
 * its top-left corner at the anchor's bottom-left: the colour dot for the
 * colour popover, the title bar's left edge for the link popover (where the
 * renderer's `.swatches` and `.linkpick` sit).
 */
export interface PopoverModel {
  kind: 'color' | 'link'
  paneId: string
  /** Window client DIP, like every other rect in the model. */
  anchor: Rect
  /** A header line above the items (`Share notes with`), or null. */
  title: string | null
  items: PopoverItem[]
}

/**
 * One item of the application menu as the core's shim serializes main's
 * template (`src/main/menu.ts`). `path` is the item's index at each level from
 * the top, which `menu:click { path }` sends back. A role item without a label
 * carries Electron's default label for that role.
 */
export interface MenuItemModel {
  label: string
  accelerator: string | null
  role: string | null
  type: 'normal' | 'separator' | 'submenu'
  enabled: boolean
  path: number[]
  submenu: MenuItemModel[] | null
}

/**
 * A one-off order to the shell (`shell:cmd`), outside the model. `menu` is the
 * application menu, sent whenever main sets it (once at boot); the shell pops
 * it under the `≡` button (the `menu` target) or on an Alt tap.
 */
export type ShellCmd = { op: 'ping' } | { op: 'menu'; items: MenuItemModel[] }

export interface UiModel {
  seq: number
  window: {
    title: string
    uiScale: number
    fontPx: number
    tabStripH: number
    statusH: number
    /** The terminal palette override as xterm `ITheme` keys (`PALETTES[key]`), null for `native`. */
    palette: Record<string, string> | null
  }
  tabs: TabModel[]
  tabFull: boolean
  sleep: boolean
  zoomBadge: string | null
  panes: PaneModel[]
  dividers: DividerModel[]
  zoomedPaneId: string | null
  emptyState: boolean
  starting: boolean
  find: FindModel
  restore: RestoreCardModel | null
  toast: string | null
  status: {
    panes: string
    inPanes: string
    used: string
    usedLevel: 'ok' | 'warn' | 'crit'
    compressed: string | null
    swap: string | null
    swapWarn: boolean
    hint: string
  }
  chords: ChordModel[]
  /** The Aero token table (colorization.ts) plus `composition`: '1' glass, '0' the opaque strip. */
  tokens: Record<string, string>
  sidebar: SidebarModel
  drawer: DrawerModel
  sheet: SheetModel | null
  update: UpdateBannerModel | null
  popover: PopoverModel | null
}

export interface Mods {
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export type UiEvent =
  | { type: 'click' | 'dblclick' | 'down' | 'up' | 'move'; target: string; x: number; y: number; button: 0 | 1 | 2; mods: Mods }
  | { type: 'wheel'; target: string; x: number; y: number; dy: number; mods: Mods }
  /** Only for non-grid targets (edit widgets, sheets). */
  | { type: 'key'; target: string; key: string; mods: Mods }
  /** Edit widget value changes. */
  | { type: 'text'; target: string; text: string }
  | { type: 'drop'; target: string; paths: string[]; text: string | null }
  | { type: 'focus' | 'blur'; target: string }

/**
 * The shell's client area and font cell. `clientW`/`clientH` are device pixels
 * (the PerMonitorV2 client rect); `cellW`/`cellH` are the cell of the model's
 * `window.fontPx`, which is already in DIP units.
 */
export interface Geometry {
  clientW: number
  clientH: number
  dpi: number
  cellW: number
  cellH: number
}

export type TermEvent =
  | { type: 'title'; paneId: string; title: string }
  | { type: 'cwd'; paneId: string; cwd: string }
  | { type: 'bell'; paneId: string }
  | { type: 'pathclick'; paneId: string; line: string; index: number; mods: Mods }
  /** A plain click (no drag) at `index` of the logical line: opens a bare http(s) URL there. */
  | { type: 'urlclick'; paneId: string; line: string; index: number }
  | { type: 'selection'; paneId: string; text: string }
  | { type: 'findResult'; paneId: string; index: number; total: number; capped: boolean }

export type GridCmd =
  | { paneId: string; op: 'create'; cols: number; rows: number; fontPx: number; scrollback: number }
  | { paneId: string; op: 'dispose' }
  | { paneId: string; op: 'resize'; cols: number; rows: number; fontPx: number }
  | { paneId: string; op: 'focus' }
  | { paneId: string; op: 'clear' }
  | { paneId: string; op: 'selectAll' }
  | { paneId: string; op: 'find'; query: string; direction: 'next' | 'prev'; caseSensitive: boolean; regex: boolean; incremental: boolean }
  | { paneId: string; op: 'findClear' }
  | { paneId: string; op: 'paste'; text: string }
  | { paneId: string; op: 'copy' }
  | { paneId: string; op: 'exited'; failed: boolean }
