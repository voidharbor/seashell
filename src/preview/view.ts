/**
 * The preview page's views as HTML strings. [pure]
 *
 * Every piece of file content goes through `escapeHtml` (or arrives already
 * escaped from the highlighter, one string per line); nothing a file holds is
 * ever parsed as markup here. Rendered previews (Markdown, HTML, SVG) are not
 * built here: they go to the sandboxed frame (main.ts).
 */
import { diffLines, hunks, splitLines, type Hunk } from '../shared/line-diff.js'
import { escapeHtml } from './markdown.js'

export type PreviewKind = 'markdown' | 'html' | 'svg' | 'image' | null

/** One file as the host posts it (ChangesFileResponse). */
export interface PreviewFile {
  path: string
  rel: string
  change: 'created' | 'edited' | 'deleted'
  before: string | null
  after: string | null
  beforeKnown: boolean
  binary: boolean
  truncated: boolean
  image?: { mime: string; base64: string }
}

export type Mode = 'diff' | 'split' | 'source' | 'preview'

/** Which files have a rendered form besides their source. */
export function previewKind(path: string): PreviewKind {
  const ext = (/\.([^./]+)$/.exec(path)?.[1] ?? '').toLowerCase()
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'svg') return 'svg'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'].includes(ext)) return 'image'
  return null
}

/**
 * The ways a file can be shown, the default first: an edit with a known
 * earlier version opens on its diff; a created or deleted Markdown, HTML or
 * SVG file opens rendered; anything else on its source. Images only render,
 * and other binaries have nothing to show.
 */
export function modesFor(f: PreviewFile): Mode[] {
  const kind = previewKind(f.path)
  if (f.image) return ['preview']
  if (f.binary) return []
  const hasDiff = f.change === 'edited' && f.beforeKnown && f.before !== null && f.after !== null
  const renderable = kind === 'markdown' || kind === 'html' || kind === 'svg'
  const out: Mode[] = []
  if (hasDiff) out.push('diff', 'split')
  if (renderable && f.change !== 'edited') out.push('preview')
  out.push('source')
  if (renderable && f.change === 'edited') out.push('preview')
  return out
}

/** One line's HTML: the highlighter's when there is one, else the escaped text. */
function lineHtml(text: string, hl: readonly string[] | null, index: number): string {
  const h = hl?.[index]
  return h !== undefined ? h : escapeHtml(text)
}

/** A whole file with line numbers. */
export function renderSource(text: string, hl: readonly string[] | null, cls = ''): string {
  const lines = splitLines(text)
  if (lines.length === 0) return '<div class="empty-file">This file is empty.</div>'
  const rows = lines.map((l, i) => `<tr><td class="ln">${i + 1}</td><td class="code">${lineHtml(l, hl, i) || ' '}</td></tr>`)
  return `<table class="src ${cls}"><tbody>${rows.join('')}</tbody></table>`
}

const MARK = { same: ' ', del: '-', add: '+' } as const

/** Lines skipped between two hunks, as a bar the user can expand. */
function gap(n: number, id: number, cols: number): string {
  return `<tr class="gap"><td colspan="${cols}"><button class="expand" data-gap="${id}">${n} unchanged line${n === 1 ? '' : 's'}</button></td></tr>`
}

export interface DiffOptions {
  mode: 'unified' | 'split'
  /** Gaps the user expanded, by index. */
  expanded: ReadonlySet<number>
  context?: number
}

/** The diff of two texts, highlighted line by line, unified or side by side. */
export function renderDiff(
  before: string,
  after: string,
  hlBefore: readonly string[] | null,
  hlAfter: readonly string[] | null,
  opts: DiffOptions
): string {
  const a = splitLines(before)
  const b = splitLines(after)
  const ops = diffLines(a, b)
  if (!ops.some((o) => o.op !== 'same')) return '<div class="empty-file">No differences.</div>'
  // Expanded gaps are shown by widening the context to everything.
  const all = hunks(ops, Number.MAX_SAFE_INTEGER)[0]!
  const shown = hunks(ops, opts.context ?? 3)
  const pieces: Array<{ kind: 'hunk'; h: Hunk } | { kind: 'gap'; from: number; to: number; id: number }> = []
  let nextOld = 1
  shown.forEach((h, i) => {
    const firstOld = h.lines.find((l) => l.oldNo !== null)?.oldNo ?? h.oldStart
    if (firstOld > nextOld) pieces.push({ kind: 'gap', from: nextOld, to: firstOld - 1, id: i })
    pieces.push({ kind: 'hunk', h })
    const lastOld = [...h.lines].reverse().find((l) => l.oldNo !== null)?.oldNo
    nextOld = lastOld !== undefined && lastOld !== null ? lastOld + 1 : nextOld
  })
  if (nextOld <= a.length) pieces.push({ kind: 'gap', from: nextOld, to: a.length, id: shown.length })

  const sameLines = (from: number, to: number): Hunk['lines'] =>
    all.lines.filter((l) => l.op === 'same' && l.oldNo !== null && l.oldNo >= from && l.oldNo <= to)

  const rowsUnified = (lines: Hunk['lines']): string =>
    lines
      .map((l) => {
        const text = l.op === 'add' ? lineHtml(l.text, hlAfter, l.newNo! - 1) : lineHtml(l.text, hlBefore, l.oldNo! - 1)
        return `<tr class="${l.op}"><td class="ln">${l.oldNo ?? ''}</td><td class="ln">${l.newNo ?? ''}</td><td class="mk">${MARK[l.op]}</td><td class="code">${text || ' '}</td></tr>`
      })
      .join('')

  const rowsSplit = (lines: Hunk['lines']): string => {
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const l = lines[i]!
      if (l.op === 'same') {
        const t = lineHtml(l.text, hlBefore, l.oldNo! - 1) || ' '
        const t2 = lineHtml(l.text, hlAfter, l.newNo! - 1) || ' '
        out.push(`<tr class="same"><td class="ln">${l.oldNo}</td><td class="code">${t}</td><td class="ln">${l.newNo}</td><td class="code">${t2}</td></tr>`)
        i += 1
        continue
      }
      // A run of deletions beside the run of additions that follows it.
      const dels: Hunk['lines'] = []
      const adds: Hunk['lines'] = []
      while (i < lines.length && lines[i]!.op === 'del') dels.push(lines[i++]!)
      while (i < lines.length && lines[i]!.op === 'add') adds.push(lines[i++]!)
      for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
        const d = dels[k]
        const ad = adds[k]
        const left = d ? `<td class="ln del">${d.oldNo}</td><td class="code del">${lineHtml(d.text, hlBefore, d.oldNo! - 1) || ' '}</td>` : '<td class="ln none"></td><td class="code none"></td>'
        const right = ad ? `<td class="ln add">${ad.newNo}</td><td class="code add">${lineHtml(ad.text, hlAfter, ad.newNo! - 1) || ' '}</td>` : '<td class="ln none"></td><td class="code none"></td>'
        out.push(`<tr>${left}${right}</tr>`)
      }
    }
    return out.join('')
  }

  const rows = opts.mode === 'split' ? rowsSplit : rowsUnified
  const cols = 4
  const body = pieces
    .map((p) => {
      if (p.kind === 'hunk') return rows(p.h.lines)
      return opts.expanded.has(p.id) ? rows(sameLines(p.from, p.to)) : gap(p.to - p.from + 1, p.id, cols)
    })
    .join('')
  return `<table class="diff ${opts.mode}"><tbody>${body}</tbody></table>`
}

/** A short human size. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
