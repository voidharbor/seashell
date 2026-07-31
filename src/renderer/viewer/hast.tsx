import { createElement, type CSSProperties, type ReactNode } from 'react'
import type { HastElement, HastNode } from './highlight.js'

/**
 * Renders shiki's HAST output as React elements.
 *
 * The obvious implementation is `dangerouslySetInnerHTML` with shiki's HTML
 * string, and it is the wrong one here. The viewer's whole security stance is
 * that file contents are untrusted input that never becomes markup — a file
 * preview renders bytes produced by arbitrary programs, and this app also runs
 * under a CSP with no `unsafe-inline`. Handing a highlighter's HTML string to
 * innerHTML would discard that guarantee for the sake of colour.
 *
 * Building React elements keeps the guarantee: text is always a text node, and
 * only the tags and properties on the allowlists below can ever be produced.
 * Anything shiki emits outside them is dropped rather than passed through, so a
 * future shiki version that starts emitting new markup cannot silently widen
 * what the viewer will render.
 */

/** Shiki emits only these three. Everything else is dropped. */
const ALLOWED_TAGS = new Set(['span', 'pre', 'code'])

/**
 * Style properties a syntax theme legitimately needs. Restricting these is what
 * stops a crafted theme (or a future shiki change) from injecting layout- or
 * position-affecting CSS into the preview.
 */
const ALLOWED_STYLE: Record<string, keyof CSSProperties> = {
  color: 'color',
  'background-color': 'backgroundColor',
  'font-style': 'fontStyle',
  'font-weight': 'fontWeight',
  'text-decoration': 'textDecoration',
}

/**
 * Parses shiki's inline style string into a React style object, keeping only
 * allowlisted declarations. Values containing `url(`, `expression(` or a
 * semicolon-escape are rejected outright — none of those can appear in a
 * legitimate token colour.
 */
export function parseStyle(raw: unknown): CSSProperties | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return undefined
  const out: Record<string, string> = {}
  for (const decl of raw.split(';')) {
    const colon = decl.indexOf(':')
    if (colon <= 0) continue
    const prop = decl.slice(0, colon).trim().toLowerCase()
    const value = decl.slice(colon + 1).trim()
    const mapped = ALLOWED_STYLE[prop]
    if (!mapped || value === '') continue
    if (/url\(|expression\(|[<>{}\\]/i.test(value)) continue
    out[mapped] = value
  }
  return Object.keys(out).length > 0 ? (out as CSSProperties) : undefined
}

function classOf(properties: Record<string, unknown> | undefined): string | undefined {
  const c = properties?.['class'] ?? properties?.['className']
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join(' ')
  return undefined
}

export function renderHast(nodes: HastNode[], keyPrefix = 'h'): ReactNode[] {
  const out: ReactNode[] = []
  nodes.forEach((node, i) => {
    const key = `${keyPrefix}-${i}`
    if (node.type === 'text') {
      out.push((node as { value: string }).value)
      return
    }
    if (node.type !== 'element') return

    const el = node as HastElement
    if (!ALLOWED_TAGS.has(el.tagName)) {
      // Unknown tag: keep the text, drop the element. Losing colour is a far
      // better failure than rendering markup this module does not understand.
      out.push(...renderHast(el.children ?? [], key))
      return
    }

    out.push(
      createElement(
        el.tagName,
        {
          key,
          className: classOf(el.properties),
          style: parseStyle(el.properties?.['style']),
        },
        ...renderHast(el.children ?? [], key)
      )
    )
  })
  return out
}
