import { describe, expect, it } from 'vitest'
import { escapeHtml, inline, renderMarkdown } from '../../src/preview/markdown.js'
import { modesFor, previewKind, renderDiff, renderSource, type PreviewFile } from '../../src/preview/view.js'

const file = (over: Partial<PreviewFile>): PreviewFile => ({
  path: '/home/user/proj/a.ts',
  rel: 'a.ts',
  change: 'edited',
  before: 'a\n',
  after: 'b\n',
  beforeKnown: true,
  binary: false,
  truncated: false,
  ...over,
})

describe('the preview page’s markdown', () => {
  it('escapes everything a file holds', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
  })

  it('keeps only safe link and image targets', () => {
    expect(inline('[a](https://example.com) [b](javascript:alert(1)) [c](#top)')).toBe(
      '<a href="https://example.com">a</a> b) <a href="#top">c</a>'
    )
    expect(inline('![x](https://example.com/p.png)')).toBe('<span class="md-missing">[x]</span>')
    expect(inline('![x](data:image/png;base64,AAAA)')).toBe('<img alt="x" src="data:image/png;base64,AAAA">')
    expect(inline('`<b>` **bold** *em* ~~gone~~')).toBe('<code>&lt;b&gt;</code> <strong>bold</strong> <em>em</em> <del>gone</del>')
  })

  it('renders the block structure', () => {
    const html = renderMarkdown('Title\n=====\n\n## Sub\n\n> quoted\n\n1. one\n2. two\n\n- [x] done\n- [ ] not\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n```ts\nconst x = 1 < 2\n```\n\n---\n')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<h2>Sub</h2>')
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<ol><li>one</li><li>two</li></ol>')
    expect(html).toContain('<input type="checkbox" disabled checked> done')
    expect(html).toContain('<td style="text-align:right">2</td>')
    expect(html).toContain('<pre class="md-code"><code>const x = 1 &lt; 2</code></pre>')
    expect(html).toContain('<hr>')
  })
})

describe('the preview page’s views', () => {
  it('opens each file on the view that fits it', () => {
    expect(modesFor(file({}))).toEqual(['diff', 'split', 'source'])
    expect(modesFor(file({ path: '/x/README.md', change: 'created', before: null }))).toEqual(['preview', 'source'])
    expect(modesFor(file({ path: '/x/page.html' }))).toEqual(['diff', 'split', 'source', 'preview'])
    expect(modesFor(file({ beforeKnown: false, before: null }))).toEqual(['source'])
    expect(modesFor(file({ binary: true }))).toEqual([])
    expect(modesFor(file({ image: { mime: 'image/png', base64: '' } }))).toEqual(['preview'])
    expect(previewKind('/x/a.SVG')).toBe('svg')
  })

  it('renders source and diffs as escaped text with line numbers', () => {
    const src = renderSource('<b>\nx\n', null)
    expect(src).toContain('<td class="ln">1</td><td class="code">&lt;b&gt;</td>')
    const d = renderDiff('a\n<i>\nc\n', 'a\n<u>\nc\n', null, null, { mode: 'unified', expanded: new Set() })
    expect(d).toContain('<tr class="del"><td class="ln">2</td><td class="ln"></td><td class="mk">-</td><td class="code">&lt;i&gt;</td></tr>')
    expect(d).toContain('<tr class="add"><td class="ln"></td><td class="ln">2</td><td class="mk">+</td><td class="code">&lt;u&gt;</td></tr>')
    expect(renderDiff('same\n', 'same\n', null, null, { mode: 'unified', expanded: new Set() })).toContain('No differences')
  })

  it('folds long unchanged stretches and expands them on request', () => {
    const a = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
    const b = a.replace('l20', 'L20')
    const folded = renderDiff(a, b, null, null, { mode: 'unified', expanded: new Set() })
    expect(folded).toContain('17 unchanged lines')
    expect(folded).toContain('16 unchanged lines')
    const open = renderDiff(a, b, null, null, { mode: 'unified', expanded: new Set([0, 1]) })
    expect(open).not.toContain('unchanged line')
    expect(open.match(/<tr class="same">/g)).toHaveLength(39)
  })

  it('uses the highlighter’s line when it has one', () => {
    expect(renderSource('x\n', ['<span style="color:#fff">x</span>'])).toContain('<span style="color:#fff">x</span>')
  })
})
