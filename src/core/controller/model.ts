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

export interface UiModel {
  seq: number
  window: { title: string; uiScale: number; fontPx: number; tabStripH: number; statusH: number }
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
