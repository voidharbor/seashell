import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every class the UI asks for must actually exist in the stylesheet.
 *
 * This is here because of a bug that was invisible for exactly as long as
 * nobody opened the panel: the projects panel asked for `set`, `set__card`,
 * `set__head` and `set__title`, and no such rules had ever been written — the
 * settings panel's shell is spelled `sheet*`. The panel therefore had no
 * overlay, no card and no padding whatsoever, and rendered as a bare block
 * below the status bar with its buttons hard against the window edge. It looked
 * like a spacing bug and was a typo.
 *
 * Nothing in a typecheck or a render test catches this — a className is just a
 * string, and a missing rule is not an error anywhere, it is simply nothing.
 *
 * Scope is deliberately a floor rather than a ceiling: static class strings
 * only. Names assembled at runtime (`pane--attn-${...}`) are not checked, and
 * making them checkable is not worth contorting the components for.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8')

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsxFiles(full))
    else if (full.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Where each class name was first seen, so a failure names the file. */
function classesInUse(): Map<string, string> {
  const seen = new Map<string, string>()
  const note = (name: string, file: string): void => {
    if (name && !seen.has(name)) seen.set(name, path.relative(root, file))
  }

  for (const file of tsxFiles(path.join(root, 'src/renderer'))) {
    const src = fs.readFileSync(file, 'utf8')

    // className="a b c" and className={'a b c'}
    for (const m of src.matchAll(/className=(?:"([^"{}]*)"|\{\s*'([^'{}]*)'\s*\})/g)) {
      for (const token of (m[1] ?? m[2] ?? '').split(/\s+/)) note(token, file)
    }

    // Conditional fragments: ' pane--focused', 'node--selected', and friends.
    // Restricted to BEM-shaped literals so ordinary strings are not mistaken
    // for class names.
    for (const m of src.matchAll(/'\s*([a-z][a-z0-9]*(?:__|--)[a-z0-9-]+)\s*'/g)) {
      note(m[1] ?? '', file)
    }
  }

  return seen
}

const defined = (name: string): boolean =>
  new RegExp(`\\.${name.replace(/-/g, '\\-')}(?![\\w-])`).test(css)

describe('the stylesheet covers what the components ask for', () => {
  it('finds a rule for every static class name in the renderer', () => {
    const missing = [...classesInUse()]
      .filter(([name]) => !defined(name))
      .map(([name, file]) => `${name} (${file})`)

    expect(missing).toEqual([])
  })

  /**
   * `.node:hover` is (0,2,0) — a class and a pseudo-class. A state rule written
   * as a bare `.node--selected` is (0,1,0), so specificity beat source order
   * and hovering the row you had just clicked replaced its blue selection pill
   * with the hover tint, leaving the white text on it. The fix is to double the
   * selector, and the only thing that can undo it is someone tidying the
   * "redundant" `.node` back off — which looks like a cleanup and is a
   * regression, so it is pinned here.
   *
   * A DOM test cannot cover this: happy-dom never enters :hover state, so
   * getComputedStyle never exercises the cascade.
   */
  it('keeps the explorer state rules at hover specificity', () => {
    expect(css).toMatch(/\.node\.node--selected\s*\{/)
    expect(css).toMatch(/\.node\.node--revealed\s*\{/)
    // The rules only win by being later in the file, so order is load-bearing.
    expect(css.indexOf('.node:hover')).toBeLessThan(css.indexOf('.node.node--selected'))
    expect(css.indexOf('.node.node--selected')).toBeLessThan(css.indexOf('.node.node--revealed'))
  })

  it('is actually looking at something', () => {
    // A guard on the guard: if the scan silently found nothing, the assertion
    // above would pass forever while checking nothing at all.
    const seen = classesInUse()
    expect(seen.size).toBeGreaterThan(40)
    expect(seen.has('sheet__card')).toBe(true)
  })
})
