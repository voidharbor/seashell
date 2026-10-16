/**
 * Line diffs for the changes panel. [pure]
 *
 * Myers' O((N+M)D) algorithm over lines, after trimming the common head and
 * tail (an agent's edit usually touches a few lines of a long file, so the
 * trim does most of the work). A diff whose edit distance passes `maxD` gives
 * up and reports the middle as one replaced block: the counts stay right and
 * a 50 000 line rewrite never stalls anything.
 */

export type DiffOp = { op: 'same' | 'del' | 'add'; text: string }

/** Splits text into lines, without the trailing empty line a final newline leaves. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function diffLines(a: readonly string[], b: readonly string[], maxD = 4000): DiffOp[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const out: DiffOp[] = []
  for (let i = 0; i < head; i += 1) out.push({ op: 'same', text: a[i]! })
  const A = a.slice(head, a.length - tail)
  const B = b.slice(head, b.length - tail)
  out.push(...myers(A, B, maxD))
  for (let i = a.length - tail; i < a.length; i += 1) out.push({ op: 'same', text: a[i]! })
  return out
}

function myers(a: readonly string[], b: readonly string[], maxD: number): DiffOp[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ op: 'add' as const, text }))
  if (m === 0) return a.map((text) => ({ op: 'del' as const, text }))
  const max = Math.min(n + m, maxD)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }
  if (found < 0) {
    return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))]
  }
  // Walk back through the saved frontiers.
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d -= 1) {
    const vd = trace[d]!
    const k = x - y
    const prevK = k === -d || (k !== d && vd[off + k - 1]! < vd[off + k + 1]!) ? k + 1 : k - 1
    const prevX = vd[off + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ op: 'same', text: a[x - 1]! })
      x -= 1
      y -= 1
    }
    if (x === prevX) ops.push({ op: 'add', text: b[prevY]! })
    else ops.push({ op: 'del', text: a[prevX]! })
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    ops.push({ op: 'same', text: a[x - 1]! })
    x -= 1
    y -= 1
  }
  return ops.reverse()
}

/** Lines added and removed between two texts. */
export function countChanges(before: string, after: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const d of diffLines(splitLines(before), splitLines(after))) {
    if (d.op === 'add') added += 1
    else if (d.op === 'del') removed += 1
  }
  return { added, removed }
}

export interface Hunk {
  oldStart: number
  newStart: number
  lines: Array<{ op: 'same' | 'del' | 'add'; text: string; oldNo: number | null; newNo: number | null }>
}

/** The diff grouped into hunks with `context` unchanged lines around each change. */
export function hunks(ops: readonly DiffOp[], context = 3): Hunk[] {
  const numbered: Hunk['lines'] = []
  let o = 1
  let n = 1
  for (const d of ops) {
    numbered.push({ op: d.op, text: d.text, oldNo: d.op === 'add' ? null : o, newNo: d.op === 'del' ? null : n })
    if (d.op !== 'add') o += 1
    if (d.op !== 'del') n += 1
  }
  // A line is kept when a change lies within `context` lines of it: one pass
  // each way, so a long file with many changes stays linear.
  const keep = new Array<boolean>(numbered.length).fill(false)
  let since = Number.POSITIVE_INFINITY
  for (let i = 0; i < numbered.length; i += 1) {
    since = numbered[i]!.op === 'same' ? since + 1 : 0
    if (since <= context) keep[i] = true
  }
  since = Number.POSITIVE_INFINITY
  for (let i = numbered.length - 1; i >= 0; i -= 1) {
    since = numbered[i]!.op === 'same' ? since + 1 : 0
    if (since <= context) keep[i] = true
  }
  const out: Hunk[] = []
  let cur: Hunk | null = null
  numbered.forEach((l, i) => {
    if (!keep[i]) {
      cur = null
      return
    }
    if (!cur) {
      cur = { oldStart: l.oldNo ?? (numbered[i - 1]?.oldNo ?? 0) + 1, newStart: l.newNo ?? (numbered[i - 1]?.newNo ?? 0) + 1, lines: [] }
      out.push(cur)
    }
    cur.lines.push(l)
  })
  return out
}
