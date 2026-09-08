import type { Terminal } from '@xterm/xterm'
import type { PathHit, RowContext } from '../links/resolve.js'
import { tokenizeLine } from '../links/tokenizer.js'
import {
  assembleLogicalLine,
  candidateAtCell,
  cellFromPoint,
  type LogicalLineRow,
  type RawCell,
} from '../links/cellmap.js'

/**
 * Resolves a double-click in a terminal to a filesystem path, if one is there.
 *
 * The pieces are all pure and unit-tested; this is the glue that reads xterm's
 * buffer, which is the one part that cannot be tested without a real terminal.
 *
 * Wrapped lines matter: a long path printed at the edge of the pane occupies
 * two buffer rows, and tokenizing each row separately would split the path in
 * half. So the whole logical line is reassembled first.
 *
 * The hit carries the token's column span and the row it was on, because that
 * is the only evidence available for the other kind of wrap: a program that
 * hard-wraps its own output writes a real newline, so xterm never marks the
 * continuation row and the logical line stops at the screen edge. `wrap-join`
 * needs the span to tell that case from an ordinary token.
 */
export function pathAtPoint(term: Terminal, clientX: number, clientY: number): PathHit | null {
  const el = term.element
  if (!el) return null

  const screen = el.querySelector('.xterm-screen') as HTMLElement | null
  const target = screen ?? el
  const rect = target.getBoundingClientRect()

  const cell = cellFromPoint(clientX, clientY, {
    rectLeft: rect.left,
    rectTop: rect.top,
    rectWidth: rect.width,
    rectHeight: rect.height,
    paddingLeft: 0,
    paddingTop: 0,
    cols: term.cols,
    rows: term.rows,
    viewportY: term.buffer.active.viewportY,
  })
  if (!cell) return null

  const rows = collectLogicalRows(term, cell.y)
  if (rows.length === 0) return null

  const logical = assembleLogicalLine(rows)
  const candidates = tokenizeLine(logical.text)
  if (candidates.length === 0) return null

  const hit = candidateAtCell(candidates, logical.idxMap, cell)
  if (!hit) return null

  /**
   * The span, in 0-based columns of the clicked row, [start, end).
   *
   * `idxMap` is per code unit of the whole logical line, so the first and last
   * entries of the candidate name real buffer cells. When either of them sits
   * on another row the token is already an xterm-wrapped one: it spans the
   * full width by definition, so the bounds become the whole row and the
   * wrap-join pass simply finds nothing new to add.
   */
  const first = logical.idxMap[hit.candidate.start]
  const last = logical.idxMap[hit.candidate.end - 1]
  const sameRow = first !== undefined && last !== undefined && first.y === cell.y && last.y === cell.y
  return {
    path: hit.candidate.path,
    start: sameRow ? first.x - 1 : 0,
    end: sameRow ? last.x : term.cols,
    absY: cell.y,
  }
}

/** The candidate's column span on its row plus the raw text of its neighbours,
 *  for the wrap-join pass. `absY` is the 1-based buffer row pathAtPoint used. */
export function rowContext(
  term: Terminal,
  absY: number,
  candidateStart: number,
  candidateEnd: number
): RowContext {
  const buf = term.buffer.active
  const y = absY - 1
  const text = (row: number): string | null => buf.getLine(row)?.translateToString(true) ?? null
  return {
    prevRow: y > 0 ? text(y - 1) : null,
    nextRow: text(y + 1),
    startCol: candidateStart,
    endCol: candidateEnd,
    cols: term.cols,
  }
}

/**
 * Walks backwards to the start of the wrapped run and forwards to its end,
 * returning every buffer row that forms one logical line.
 */
function collectLogicalRows(term: Terminal, absY: number): LogicalLineRow[] {
  const buf = term.buffer.active
  const yIndex = absY - 1
  if (yIndex < 0 || yIndex >= buf.length) return []

  let start = yIndex
  while (start > 0) {
    const line = buf.getLine(start)
    if (!line?.isWrapped) break
    start -= 1
  }

  let end = yIndex
  while (end + 1 < buf.length) {
    const next = buf.getLine(end + 1)
    if (!next?.isWrapped) break
    end += 1
  }

  const out: LogicalLineRow[] = []
  for (let y = start; y <= end; y += 1) {
    const line = buf.getLine(y)
    if (!line) continue
    const cells: RawCell[] = []
    for (let x = 0; x < line.length; x += 1) {
      const c = line.getCell(x)
      if (!c) {
        cells.push({ chars: ' ', width: 1 })
        continue
      }
      cells.push({ chars: c.getChars() || ' ', width: c.getWidth() })
    }
    out.push({ y: y + 1, cells })
  }
  return out
}
