/**
 * Mouse-to-cell and cell-to-candidate mapping (spec §8.2, §8.4).
 *
 * [pure] — no DOM, no 'electron', no '@xterm/xterm' import. The two things
 * that normally require a live Terminal (turning a MouseEvent into a buffer
 * cell, and joining wrapped xterm buffer rows into one logical line) are
 * expressed here against plain data the caller extracts from the terminal,
 * so this stays testable in bare node. The (non-pure) glue code that reads
 * `term.element!.getBoundingClientRect()`, `getComputedStyle`, and
 * `line.getCell(x, reusableCell)` lives elsewhere and feeds this module
 * numbers/cell arrays instead.
 */

import type { PathCandidate } from './tokenizer.js'

/** 1-based buffer cell coordinates: `x` is the column, `y` is the absolute
 *  (scrollback-inclusive) row — matches xterm's `ILink.range` convention. */
export interface BufferCell {
  x: number
  y: number
}

/**
 * Pixel/layout inputs needed to invert a DOM click into a buffer cell.
 * Plain numbers rather than a live element, because the rect **must be
 * re-read on every click** (spec §8.4: "Never cache `r`" — it drifts after
 * a font-size change, a DPR change, or a pane resize) and a pure function
 * can't do that reading itself.
 */
export interface TerminalGeometry {
  rectLeft: number
  rectTop: number
  rectWidth: number
  rectHeight: number
  paddingLeft: number
  paddingTop: number
  cols: number
  rows: number
  /** `term.buffer.active.viewportY` — added to the row to get an absolute row. */
  viewportY: number
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Mirrors xterm's internal `getCoords` using only public geometry — xterm
 * 6.0.0 exposes no supported API to turn a MouseEvent into a buffer cell.
 * Returns null for degenerate geometry (zero-sized rect, zero cols/rows)
 * rather than dividing by zero.
 */
export function cellFromPoint(clientX: number, clientY: number, geo: TerminalGeometry): BufferCell | null {
  if (geo.cols <= 0 || geo.rows <= 0 || geo.rectWidth <= 0 || geo.rectHeight <= 0) return null
  const cw = geo.rectWidth / geo.cols
  const ch = geo.rectHeight / geo.rows
  const col = clamp(Math.ceil((clientX - geo.rectLeft - geo.paddingLeft) / cw), 1, geo.cols)
  const row = clamp(Math.ceil((clientY - geo.rectTop - geo.paddingTop) / ch), 1, geo.rows)
  return { x: col, y: row + geo.viewportY }
}

/**
 * One buffer column's worth of content, already unwrapped from xterm's
 * `IBufferCell` by the (non-pure) caller — kept generic so this module
 * never has to import `@xterm/xterm` to name the real type.
 */
export interface RawCell {
  /** `cell.getChars() || ' '` — empty for the true default cell. */
  chars: string
  /** `cell.getWidth()` — 0 marks the placeholder half of a wide (CJK) char. */
  width: number
}

export interface LogicalLineRow {
  /** 1-based absolute buffer row this slice of cells came from. */
  y: number
  cells: RawCell[]
}

/** Buffer cell that produced one UTF-16 code unit of the assembled line text. */
export interface IdxMapEntry {
  y: number
  x: number
}

export interface LogicalLine {
  text: string
  /** `idxMap[i]` is the buffer cell that produced `text[i]`. Built during
   *  the join, not reconstructed afterward — the only way CJK/emoji columns
   *  stay exact when one cell's `getChars()` can be more than one UTF-16
   *  code unit. */
  idxMap: IdxMapEntry[]
}

/**
 * Joins wrapped rows into one logical line and records, per UTF-16 code
 * unit, which buffer cell produced it (spec §8.2 "Logical line assembly").
 * The caller is responsible for walking `isWrapped` to gather `rows` in
 * order and for populating one `RawCell` per column (0..cols-1), including
 * zero-width placeholder cells — this function only does the join.
 */
export function assembleLogicalLine(rows: LogicalLineRow[]): LogicalLine {
  let text = ''
  const idxMap: IdxMapEntry[] = []
  for (const row of rows) {
    let x = 0
    for (const cell of row.cells) {
      if (cell.width === 0) {
        x++
        continue
      }
      const chars = cell.chars.length > 0 ? cell.chars : ' '
      for (let k = 0; k < chars.length; k++) idxMap.push({ y: row.y, x: x + 1 })
      text += chars
      x++
    }
  }
  return { text, idxMap }
}

export interface CandidateHit {
  candidate: PathCandidate
  /** Absolute buffer cell of the FIRST character of `candidate.path` — what
   *  `term.select(x - 1, y - 1, len)` needs (the caller converts to 0-based). */
  start: BufferCell
  /** Column span to select: one `idxMap` entry per code unit of `candidate.path`. */
  len: number
}

/**
 * Finds which tokenizer candidate (if any) a clicked buffer cell landed on.
 * Kept separate from `tokenizeLine` so hover and double-click share one
 * source of truth (the candidate list) without this module depending on
 * any DOM or xterm runtime type.
 */
export function candidateAtCell(candidates: PathCandidate[], idxMap: IdxMapEntry[], cell: BufferCell): CandidateHit | null {
  let charIdx = -1
  for (let i = 0; i < idxMap.length; i++) {
    const e = idxMap[i]
    if (e !== undefined && e.x === cell.x && e.y === cell.y) {
      charIdx = i
      break
    }
  }
  if (charIdx === -1) return null

  for (const c of candidates) {
    if (charIdx >= c.start && charIdx < c.end) {
      const startEntry = idxMap[c.start]
      if (startEntry === undefined) return null
      return { candidate: c, start: startEntry, len: c.end - c.start }
    }
  }
  return null
}
