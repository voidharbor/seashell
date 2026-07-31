/**
 * Depth-3 split-tree types for a single tab's pane layout: Row -> Col[] -> Pane[].
 *
 * The shape itself (not a runtime check) is what keeps the tree from ever
 * nesting a column inside a column, or a pane at the root: TypeScript will
 * not accept a `ColNode` where a `PaneLeaf` is expected. `validateInvariant`
 * in tree.ts still exists because the *values* (ratio sums, pane counts,
 * duplicate ids) are not something the type system can enforce.
 */

/** A leaf: exactly one terminal (pty-backed) pane. */
export interface PaneLeaf {
  readonly type: 'pane'
  readonly paneId: string
}

/** A vertical stack of one or more panes sharing a column's width. */
export interface ColNode {
  readonly type: 'col'
  /** Height fraction of each entry in `children`, same order. Sums to 1 (+/- RATIO_EPSILON). */
  readonly ratios: number[]
  readonly children: PaneLeaf[]
}

/** A horizontal row of one or more columns. Always the tree root. */
export interface RowNode {
  readonly type: 'row'
  /** Width fraction of each entry in `children`, same order. Sums to 1 (+/- RATIO_EPSILON). */
  readonly ratios: number[]
  readonly children: ColNode[]
}

/** The tab's layout tree is always rooted at a row node. */
export type LayoutTree = RowNode

/** Pixel size of one terminal cell, measured from the active font metrics. */
export interface CellSize {
  readonly cellW: number
  readonly cellH: number
}

/** Pixel width/height of an on-screen box (a tab's content area, a column, ...). */
export interface PixelSize {
  readonly width: number
  readonly height: number
}

/** A pane's assigned on-screen box, relative to the tab content area's top-left. */
export interface PaneRect {
  readonly paneId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

// ---------------------------------------------------------------------------
// Minimum-size tree: mirrors the layout tree shape, cached minW/minH per node.
// Kept as its own parallel structure (rather than mutating the layout tree)
// because minimums depend on cell size, which changes independently of the
// tree shape (font size change, window resize) and would otherwise force
// re-deriving ratios just to attach a number.
// ---------------------------------------------------------------------------

export interface PaneMinNode {
  readonly type: 'pane'
  readonly paneId: string
  readonly minW: number
  readonly minH: number
}

export interface ColMinNode {
  readonly type: 'col'
  readonly minW: number
  readonly minH: number
  readonly children: PaneMinNode[]
}

export interface RowMinNode {
  readonly type: 'row'
  readonly minW: number
  readonly minH: number
  readonly children: ColMinNode[]
}

export type MinNode = RowMinNode | ColMinNode | PaneMinNode

// ---------------------------------------------------------------------------
// Constants (spec section 5.3 and 5.2)
// ---------------------------------------------------------------------------

/** Hard drag clamp and PTY floor, in cells. */
export const MIN_COLS = 20
export const MIN_ROWS = 6

/** Auto-insert refuses to produce a pane smaller than this, in cells. */
export const AUTO_MIN_COLS = 32
export const AUTO_MIN_ROWS = 10

/** Divider hit-strip width in px; the visible line is 1px, centered in it. */
export const DIVIDER_PX = 9

/** Per-pane title bar height in px, counted into the leaf's minH. */
export const TITLEBAR_PX = 24

/** The "+" button and Cmd+D disable themselves at this count. */
export const MAX_PANES_PER_TAB = 6

/** Tolerance used for every ratio-sum / float-equality check in the layout engine. */
export const RATIO_EPSILON = 1e-9
