/**
 * The changes preview page: one changed file at a time, as a diff, its source
 * or its rendered form (Markdown, HTML, SVG, images), like Claude Desktop's
 * preview. The native shell hosts it in WebView2 under a virtual host and
 * the Electron window in an iframe; either way the host posts
 * `{ type: 'show' | 'loading' | 'error' | 'theme', ... }` and the page
 * answers `{ type: 'ready' }`, `{ type: 'action', action }` and
 * `{ type: 'link', url }`.
 *
 * Nothing a file holds is ever parsed as markup in this page: source and
 * diffs are escaped text, and rendered previews go to render.html in a frame
 * sandboxed with scripts allowed and no same origin, under its own CSP with
 * no network at all.
 */
import { escapeHtml, renderMarkdown } from './markdown.js'
import { highlightLines } from './highlight.js'
import { modesFor, previewKind, renderDiff, renderSource, type Mode, type PreviewFile } from './view.js'

export interface PreviewTheme {
  bg: string
  fg: string
  dim: string
  header: string
  border: string
  accent: string
  accentText: string
  danger: string
  selection: string
  button: string
  buttonText: string
  radius: number
  light: boolean
}

type HostMessage =
  | { type: 'show'; seq: number; file: PreviewFile; theme?: PreviewTheme }
  | { type: 'loading'; path: string; theme?: PreviewTheme }
  | { type: 'error'; path: string; message: string; theme?: PreviewTheme }
  | { type: 'theme'; theme?: PreviewTheme }

interface WebView2Bridge {
  postMessage(m: unknown): void
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void
}

const bridge = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview

function send(m: Record<string, unknown>): void {
  if (bridge) bridge.postMessage(m)
  else if (window.parent !== window) window.parent.postMessage({ seashellPreview: m }, '*')
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const bar = $('bar')
const body = $('body')

let file: PreviewFile | null = null
let mode: Mode = 'source'
let expanded = new Set<number>()
let theme: PreviewTheme | null = null
let renderToken = 0
let frame: HTMLIFrameElement | null = null
let frameHtml: string | null = null

const HEX = /^#[0-9a-f]{3,8}$/i
const color = (v: unknown, fallback: string): string => (typeof v === 'string' && HEX.test(v) ? v : fallback)

function applyTheme(t: PreviewTheme | undefined): void {
  if (!t || typeof t !== 'object') return
  theme = t
  const s = document.documentElement.style
  s.setProperty('--bg', color(t.bg, '#18191B'))
  s.setProperty('--fg', color(t.fg, '#E4E5E7'))
  s.setProperty('--dim', color(t.dim, '#A8ABB2'))
  s.setProperty('--header', color(t.header, '#1D1E21'))
  s.setProperty('--border', color(t.border, '#34353A'))
  s.setProperty('--accent', color(t.accent, '#2563EB'))
  s.setProperty('--accent-text', color(t.accentText, '#FFFFFF'))
  s.setProperty('--danger', color(t.danger, '#FF5F56'))
  s.setProperty('--selection', color(t.selection, '#3399FF'))
  s.setProperty('--button', color(t.button, '#2E2F33'))
  s.setProperty('--button-text', color(t.buttonText, '#E4E5E7'))
  const r = Number(t.radius)
  s.setProperty('--radius', `${Number.isFinite(r) && r >= 0 && r <= 24 ? r : 6}px`)
  document.documentElement.classList.toggle('light', t.light === true)
}

const CHANGE_TEXT = { created: 'Created', edited: 'Edited', deleted: 'Deleted' } as const

const MODE_LABEL: Record<Mode, string> = { diff: 'Diff', split: 'Side by side', source: 'Source', preview: 'Preview' }

function button(action: string, label: string, title: string, extra = ''): string {
  return `<button class="btn ${extra}" data-action="${action}" title="${escapeHtml(title)}">${label}</button>`
}

function drawBar(): void {
  if (!file) return
  const modes = modesFor(file)
  const seg = modes.length > 1
    ? `<div class="seg">${modes.map((m) => `<button class="${m === mode ? 'on' : ''}" data-mode="${m}">${MODE_LABEL[m]}</button>`).join('')}</div>`
    : ''
  const live = file.change !== 'deleted'
  bar.innerHTML =
    `<span class="chip ${file.change}">${CHANGE_TEXT[file.change]}</span>` +
    `<span class="path" title="${escapeHtml(file.path)}">${escapeHtml(file.rel)}</span>` +
    `<span class="grow"></span>${seg}` +
    (live ? button('open', 'Open', 'Open in its default app') + button('reveal', 'Reveal', 'Reveal in the file explorer') : '') +
    button('copy', 'Copy path', 'Copy the full path') +
    button('close', '&#x2715;', 'Close the preview (Esc)', 'close')
}

function note(text: string): string {
  return `<div class="note">${escapeHtml(text)}</div>`
}

/** The page's own CSS for rendered Markdown, in the theme's colours. */
function markdownCss(): string {
  const t = theme
  const fg = color(t?.fg, '#E4E5E7')
  const bg = color(t?.bg, '#18191B')
  const dim = color(t?.dim, '#A8ABB2')
  const border = color(t?.border, '#34353A')
  const accent = color(t?.accent, '#2563EB')
  return `body{margin:0;padding:20px 28px;background:${bg};color:${fg};font:14px/1.6 "Segoe UI",system-ui,-apple-system,sans-serif}
a{color:${accent}}h1,h2{border-bottom:1px solid ${border};padding-bottom:.3em}code{font-family:"Cascadia Mono",Consolas,Menlo,monospace;font-size:12.5px;background:${border}55;padding:1px 4px;border-radius:4px}
pre.md-code{background:${border}44;padding:10px 12px;border-radius:6px;overflow:auto}pre.md-code code{background:none;padding:0}
blockquote{margin:0;padding:0 1em;color:${dim};border-left:3px solid ${border}}table{border-collapse:collapse}th,td{border:1px solid ${border};padding:4px 10px}
img{max-width:100%}hr{border:0;border-top:1px solid ${border}}.md-missing{color:${dim}}`
}

/** The rendered form of `text` as `path`'s kind, for the sandboxed frame. */
function renderedHtml(path: string, text: string): string {
  const kind = previewKind(path)
  if (kind === 'markdown') return `<!doctype html><html><head><style>${markdownCss()}</style></head><body>${renderMarkdown(text)}</body></html>`
  if (kind === 'svg') {
    const b64 = btoa(unescape(encodeURIComponent(text)))
    return `<!doctype html><html><head><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff}img{max-width:100%;max-height:100vh}</style></head><body><img src="data:image/svg+xml;base64,${b64}"></body></html>`
  }
  return text
}

/** What the frame shows now, so an unchanged document is not reloaded. */
let frameShown: string | null = null

/**
 * Shows `html` in the sandboxed frame. The frame takes one document per load
 * (render.html writes it once), so new content is a fresh load: the frame
 * says it is ready and gets `frameHtml`.
 */
function showInFrame(html: string): void {
  const inPlace = frame !== null && frame.parentNode === body && body.childElementCount === 1
  if (inPlace && frameShown === html) return
  frameHtml = html
  frameShown = null
  if (!frame) {
    frame = document.createElement('iframe')
    frame.className = 'render'
    // Scripts may run, but in an origin of their own: no same origin, no
    // popups, no top navigation, no forms. render.html's CSP has no network.
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('referrerpolicy', 'no-referrer')
  }
  frame.src = 'render.html'
  if (!inPlace) body.replaceChildren(frame)
}

window.addEventListener('message', (e) => {
  // The frame says it loaded and asks for its document, or reports a link.
  if (frame && e.source === frame.contentWindow) {
    const d = e.data as { seashellRenderReady?: unknown; seashellLink?: unknown } | null
    if (d?.seashellRenderReady === true) {
      if (frameHtml !== null) {
        frame.contentWindow?.postMessage({ seashellRender: frameHtml }, '*')
        frameShown = frameHtml
      }
    } else if (typeof d?.seashellLink === 'string') {
      send({ type: 'link', url: d.seashellLink })
    }
    return
  }
  // Without WebView2 (the Electron window) the host is the parent.
  if (!bridge && e.source === window.parent) {
    const m = (e.data as { seashellHost?: unknown } | null)?.seashellHost
    if (m) onHost(m as HostMessage)
  }
})

async function draw(keepScroll: boolean): Promise<void> {
  const f = file
  if (!f) return
  const token = ++renderToken
  const scroll = keepScroll ? body.scrollTop : 0
  drawBar()
  const notes: string[] = []
  if (f.truncated) notes.push('Only the first 2 MB of this file is shown.')
  if (f.image) {
    body.innerHTML = `${notes.map(note).join('')}<div class="image"><img alt="" src="data:${escapeHtml(f.image.mime)};base64,${f.image.base64.replace(/[^A-Za-z0-9+/=]/g, '')}"></div>`
    return
  }
  if (f.binary) {
    body.innerHTML = note('This is a binary file, so it is not shown here. Open it in its default app instead.')
    return
  }
  const light = theme?.light === true
  const shown = f.change === 'deleted' ? f.before : f.after
  if (f.change === 'deleted') {
    if (shown === null) {
      body.innerHTML = note('This file was deleted, and what it held before is not known.')
      return
    }
    notes.unshift('This file was deleted. This is its last known content.')
  }
  if (f.change === 'edited' && (!f.beforeKnown || f.before === null)) notes.unshift('The earlier version of this file is not known, so it is shown as it is now.')
  const text = shown ?? ''

  if (mode === 'preview') {
    showInFrame(renderedHtml(f.path, text))
    return
  }
  if (mode === 'diff' || mode === 'split') {
    // Plain first, so a big file shows at once; colours follow.
    body.innerHTML = notes.map(note).join('') + renderDiff(f.before ?? '', f.after ?? '', null, null, { mode: mode === 'split' ? 'split' : 'unified', expanded })
    body.scrollTop = scroll
    const [hb, ha] = await Promise.all([highlightLines(f.before ?? '', f.path, light), highlightLines(f.after ?? '', f.path, light)])
    if (token !== renderToken || (!hb && !ha)) return
    const top = body.scrollTop
    body.innerHTML = notes.map(note).join('') + renderDiff(f.before ?? '', f.after ?? '', hb, ha, { mode: mode === 'split' ? 'split' : 'unified', expanded })
    body.scrollTop = top
    return
  }
  body.innerHTML = notes.map(note).join('') + renderSource(text, null, f.change)
  body.scrollTop = scroll
  const hl = await highlightLines(text, f.path, light)
  if (token !== renderToken || !hl) return
  const top = body.scrollTop
  body.innerHTML = notes.map(note).join('') + renderSource(text, hl, f.change)
  body.scrollTop = top
}

function onHost(m: HostMessage): void {
  if (!m || typeof m !== 'object') return
  applyTheme(m.theme)
  switch (m.type) {
    case 'loading':
      if (file?.path !== m.path) {
        renderToken += 1
        bar.innerHTML = `<span class="path">${escapeHtml(String(m.path).split('/').pop() ?? '')}</span><span class="grow"></span>${button('close', '&#x2715;', 'Close the preview (Esc)', 'close')}`
        body.innerHTML = '<div class="note">Loading…</div>'
      }
      break
    case 'error':
      renderToken += 1
      file = null
      bar.innerHTML = `<span class="path">${escapeHtml(String(m.path))}</span><span class="grow"></span>${button('close', '&#x2715;', 'Close the preview (Esc)', 'close')}`
      body.innerHTML = note(String(m.message))
      break
    case 'show': {
      const same = file?.path === m.file.path
      file = m.file
      const modes = modesFor(file)
      if (!same || !modes.includes(mode)) {
        mode = modes[0] ?? 'source'
        expanded = new Set()
      }
      if (mode !== 'preview' && frame) {
        frame.remove()
        frame = null
      }
      void draw(same)
      break
    }
    case 'theme':
      if (file) void draw(true)
      break
    default:
      break
  }
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement | null)?.closest('button')
  if (!el) return
  const action = el.getAttribute('data-action')
  if (action) {
    send({ type: 'action', action })
    return
  }
  const m = el.getAttribute('data-mode') as Mode | null
  if (m && file && modesFor(file).includes(m) && m !== mode) {
    mode = m
    if (mode !== 'preview' && frame) {
      frame.remove()
      frame = null
    }
    void draw(false)
    return
  }
  const g = el.getAttribute('data-gap')
  if (g !== null) {
    expanded.add(Number(g))
    void draw(true)
  }
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') send({ type: 'action', action: 'close' })
})

// The context menu is the shell's to give, and this page has none.
document.addEventListener('contextmenu', (e) => e.preventDefault())

if (bridge) bridge.addEventListener('message', (e) => onHost(e.data as HostMessage))
send({ type: 'ready' })
