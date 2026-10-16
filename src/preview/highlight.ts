/**
 * Syntax colours for the preview page, line by line: shiki's core with its
 * JavaScript regex engine (no WASM, so no CSP widening), the same grammars
 * the Electron preview carries, each one loaded the first time a file needs
 * it. Every line comes back as HTML: spans whose colour is a checked hex
 * value around escaped text.
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { LANGS, languageFor } from '../renderer/viewer/highlight.js'
import { escapeHtml } from './markdown.js'

/** Past this the file is shown uncoloured: highlighting it would stall the page. */
export const HIGHLIGHT_MAX_CHARS = 400_000

const DARK = 'github-dark-default'
const LIGHT = 'github-light-default'

let core: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [import('shiki/themes/github-dark-default.mjs'), import('shiki/themes/github-light-default.mjs')],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return core
}

const HEX = /^#[0-9a-f]{3,8}$/i

/** Each line of `code` as HTML, or null when the language is unknown or it is too big. */
export async function highlightLines(code: string, path: string, light: boolean): Promise<string[] | null> {
  if (code.length > HIGHLIGHT_MAX_CHARS) return null
  const lang = languageFor(path)
  if (!lang) return null
  try {
    const hl = await highlighter()
    if (!loaded.has(lang)) {
      const mod = (await LANGS[lang]!()) as { default: unknown }
      await hl.loadLanguage(mod.default as Parameters<HighlighterCore['loadLanguage']>[0])
      loaded.add(lang)
    }
    const lines = hl.codeToTokensBase(code, { lang, theme: light ? LIGHT : DARK })
    return lines.map((line) =>
      line
        .map((t) => {
          const color = t.color && HEX.test(t.color) ? `color:${t.color};` : ''
          const fs = t.fontStyle ?? 0
          const style = `${color}${fs & 1 ? 'font-style:italic;' : ''}${fs & 2 ? 'font-weight:600;' : ''}`
          return style ? `<span style="${style}">${escapeHtml(t.content)}</span>` : escapeHtml(t.content)
        })
        .join('')
    )
  } catch {
    return null
  }
}
