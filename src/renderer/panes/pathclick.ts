import type { Terminal } from '@xterm/xterm'
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
 */
export function pathAtPoint(term: Terminal, clientX: number, clientY: number): string | null {
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
  return hit ? hit.candidate.path : null
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
