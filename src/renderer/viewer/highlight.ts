import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/**
 * Syntax highlighting for the file preview pane.
 *
 * Two constraints shaped this, both non-obvious:
 *
 * 1. **No WASM.** Shiki's default engine is Oniguruma compiled to WebAssembly,
 *    and instantiating it requires `script-src 'wasm-unsafe-eval'`. This
 *    renderer runs under `default-src 'none'` and displays bytes produced by
 *    arbitrary programs; widening the CSP to get prettier colours is a bad
 *    trade. Shiki 4's pure-JavaScript RegExp engine needs no CSP change at all.
 *    `forgiving` keeps a grammar the JS engine cannot fully express from
 *    throwing — the affected tokens simply come back unstyled.
 *
 * 2. **Explicit language map.** Vite can only code-split a dynamic import it can
 *    statically analyse, and `import(\`shiki/langs/${name}.mjs\`)` is not
 *    analysable — it fails at build time rather than runtime. Listing the
 *    languages explicitly makes each one its own lazily-fetched chunk, so the
 *    highlighter costs nothing until a file that needs it is opened.
 */

type LangLoader = () => Promise<unknown>

/** Curated rather than exhaustive: shiki's full bundle is ~200 grammars, and
 *  every one is a chunk in the packaged app. These are the languages actually
 *  worth carrying for this machine's work. */
const LANGS: Record<string, LangLoader> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  php: () => import('shiki/langs/php.mjs'),
}

/** Extension / basename to grammar. Anything unmapped renders unhighlighted,
 *  which is a correct outcome, not a failure. */
const BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  json: 'json', jsonl: 'json',
  jsonc: 'jsonc',
  py: 'python', pyw: 'python',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', command: 'shellscript',
  swift: 'swift',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  java: 'java',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  xml: 'xml', svg: 'xml', plist: 'xml',
  diff: 'diff', patch: 'diff',
  ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
  lua: 'lua',
  php: 'php',
}

const BY_BASENAME: Record<string, string> = {
  Dockerfile: 'docker',
  Makefile: 'shellscript',
  '.zshrc': 'shellscript',
  '.bashrc': 'shellscript',
  '.zprofile': 'shellscript',
  '.gitignore': 'ini',
  '.env': 'ini',
}

export function languageFor(filePath: string): string | null {
  const base = filePath.split('/').filter(Boolean).pop() ?? filePath
  const byName = BY_BASENAME[base]
  if (byName) return byName
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = base.slice(dot + 1).toLowerCase()
  const lang = BY_EXT[ext]
  return lang && LANGS[lang] ? lang : null
}

let corePromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Set<string>()

async function core(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = createHighlighterCore({
      themes: [import('shiki/themes/github-dark-default.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
  }
  return corePromise
}

/** Minimal HAST subset — exactly what shiki emits, nothing more. */
export interface HastText {
  type: 'text'
  value: string
}
export interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastNode[]
}
export type HastNode = HastText | HastElement | { type: string; [k: string]: unknown }

export interface HighlightResult {
  /** The `<code>` element's children — one element per line. */
  lines: HastNode[]
  lang: string
}

/**
 * Returns the highlighted lines, or null when the file's language is unknown or
 * highlighting failed. Null is a normal result: the caller renders plain text,
 * which is always correct and never worse than an error state.
 */
export async function highlightToHast(
  code: string,
  filePath: string
): Promise<HighlightResult | null> {
  const lang = languageFor(filePath)
  if (!lang) return null

  try {
    const hl = await core()
    if (!loadedLangs.has(lang)) {
      const mod = (await LANGS[lang]!()) as { default: unknown }
      await hl.loadLanguage(mod.default as Parameters<HighlighterCore['loadLanguage']>[0])
      loadedLangs.add(lang)
    }

    // codeToHast returns a Root, which has children but no tagName of its own.
    const hast = hl.codeToHast(code, { lang, theme: 'github-dark-default' }) as unknown as {
      children: HastNode[]
    }
    // root > pre > code > line spans
    const pre = hast.children.find(
      (c): c is HastElement => (c as HastElement).tagName === 'pre'
    )
    const codeEl = pre?.children.find(
      (c): c is HastElement => (c as HastElement).tagName === 'code'
    )
    if (!codeEl) return null
    return { lines: codeEl.children, lang }
  } catch {
    return null
  }
}
