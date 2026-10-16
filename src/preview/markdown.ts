/**
 * A small Markdown renderer for the changes preview. [pure]
 *
 * CommonMark's everyday subset: ATX and setext headings, paragraphs, emphasis,
 * strong, strikethrough, inline code, fenced and indented code, block quotes,
 * ordered and unordered lists (task items too), tables, rules, links and
 * images. Raw HTML is shown as text, never parsed. Every piece of text goes
 * through `escapeHtml`, and a URL keeps only http, https, mailto and `#`
 * (images only `data:image/`), so the output is safe even before it reaches
 * the sandboxed frame it is shown in.
 *
 * `highlight` colours a fenced block; it gets the code and the info string's
 * language and returns HTML (escaped by it) or null for plain.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function safeHref(url: string): string | null {
  const u = url.trim()
  if (/^(https?:|mailto:)/i.test(u) || u.startsWith('#')) return u
  return null
}

function safeImage(url: string): string | null {
  const u = url.trim()
  return /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i.test(u) ? u : null
}

/** Inline spans: code first (its content is literal), then images, links, emphasis. */
export function inline(text: string): string {
  const out: string[] = []
  let i = 0
  const plain = (s: string): string =>
    escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<strong>${a ?? b}</strong>`)
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  while (i < text.length) {
    const rest = text.slice(i)
    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest)
    if (code) {
      out.push(`<code>${escapeHtml(code[2]!.replace(/^ (.*) $/, '$1'))}</code>`)
      i += code[0].length
      continue
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (img) {
      const src = safeImage(img[2]!)
      out.push(src ? `<img alt="${escapeHtml(img[1]!)}" src="${escapeHtml(src)}">` : `<span class="md-missing">[${escapeHtml(img[1] || 'image')}]</span>`)
      i += img[0].length
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link) {
      const href = safeHref(link[2]!)
      out.push(href ? `<a href="${escapeHtml(href)}">${inline(link[1]!)}</a>` : inline(link[1]!))
      i += link[0].length
      continue
    }
    const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest)
    if (auto) {
      out.push(`<a href="${escapeHtml(auto[1]!)}">${escapeHtml(auto[1]!)}</a>`)
      i += auto[0].length
      continue
    }
    // Up to the next character that can start a span.
    const next = rest.slice(1).search(/[`!\[<]/)
    const take = next < 0 ? rest.length : next + 1
    out.push(plain(rest.slice(0, take)))
    i += take
  }
  return out.join('')
}

interface Ctx {
  highlight?: (code: string, lang: string) => string | null
}

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** Block structure, line by line. */
export function renderMarkdown(src: string, ctx: Ctx = {}): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  return blocks(lines, ctx)
}

function blocks(lines: string[], ctx: Ctx): string {
  const out: string[] = []
  let i = 0
  const para: string[] = []
  const flush = (): void => {
    if (para.length > 0) out.push(`<p>${inline(para.join('\n')).replace(/ {2,}\n|\\\n/g, '<br>')}</p>`)
    para.length = 0
  }
  while (i < lines.length) {
    const line = lines[i]!
    if (/^\s*$/.test(line)) {
      flush()
      i += 1
      continue
    }
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      flush()
      const marker = fence[1]!
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) body.push(lines[i++]!)
      i += 1
      const code = body.join('\n')
      const lang = fence[2] ?? ''
      const html = (lang && ctx.highlight?.(code, lang)) || escapeHtml(code)
      out.push(`<pre class="md-code"><code>${html}</code></pre>`)
      continue
    }
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      flush()
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`)
      i += 1
      continue
    }
    if (para.length > 0 && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      const level = line.trim().startsWith('=') ? 1 : 2
      const text = para.join('\n')
      para.length = 0
      out.push(`<h${level}>${inline(text)}</h${level}>`)
      i += 1
      continue
    }
    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push('<hr>')
      i += 1
      continue
    }
    if (/^ {0,3}>/.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^ {0,3}> ?/, ''))
      out.push(`<blockquote>${blocks(body, ctx)}</blockquote>`)
      continue
    }
    const item = /^( {0,3})([-*+]|\d{1,9}[.)])\s+/.exec(line)
    if (item) {
      flush()
      const ordered = /\d/.test(item[2]!)
      const items: string[][] = []
      while (i < lines.length) {
        const l = lines[i]!
        const m = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(l)
        if (m && /\d/.test(m[2]!) === ordered) {
          items.push([m[3]!])
          i += 1
          continue
        }
        if (items.length > 0 && /^\s{2,}\S/.test(l)) {
          items[items.length - 1]!.push(l.replace(/^\s{2,4}/, ''))
          i += 1
          continue
        }
        if (items.length > 0 && /^\s*$/.test(l) && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!)) {
          items[items.length - 1]!.push('')
          i += 1
          continue
        }
        break
      }
      const start = ordered ? Number(/\d+/.exec(item[2]!)![0]) : 1
      const lis = items.map((body) => {
        const task = /^\[( |x|X)\]\s+/.exec(body[0]!)
        if (task) body[0] = body[0]!.slice(task[0].length)
        const inner = body.length === 1 ? inline(body[0]!) : blocks(body, ctx)
        const box = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ` : ''
        return `<li>${box}${inner}</li>`
      })
      out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${lis.join('')}</ol>` : `<ul>${lis.join('')}</ul>`)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      flush()
      const head = tableRow(line)
      const aligns = tableRow(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && !/^\s*$/.test(lines[i]!)) rows.push(tableRow(lines[i++]!))
      const cell = (tag: string, c: string, j: number): string => `<${tag}${aligns[j] ? ` style="text-align:${aligns[j]}"` : ''}>${inline(c)}</${tag}>`
      out.push(
        `<table><thead><tr>${head.map((c, j) => cell('th', c, j)).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, j) => cell('td', r[j] ?? '', j)).join('')}</tr>`)
          .join('')}</tbody></table>`
      )
      continue
    }
    if (para.length === 0 && /^ {4}\S/.test(line)) {
      const body: string[] = []
      while (i < lines.length && (/^ {4}/.test(lines[i]!) || /^\s*$/.test(lines[i]!))) body.push(lines[i++]!.slice(4))
      while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop()
      out.push(`<pre class="md-code"><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    para.push(line)
    i += 1
  }
  flush()
  return out.join('\n')
}
