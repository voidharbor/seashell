import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { anchorAction, type AnchorInput } from '../../src/renderer/term/find-anchor.js'

/**
 * The search addon re-runs itself 200ms after any pty write. In a pane that
 * keeps printing, that re-run can walk the active match to the far end of the
 * buffer with scrolling suppressed, so the user's match silently leaves the
 * screen. These cases pin the decision that puts it back.
 */
function input(over: Partial<AnchorInput> = {}): AnchorInput {
  return {
    anchor: { line: 100, col: 4, disposed: false },
    selection: { line: 2919, col: 0 },
    viewportY: 90,
    findViewportY: 90,
    rows: 24,
    ...over,
  }
}

describe('anchorAction', () => {
  it('does nothing without an anchor', () => {
    expect(anchorAction(input({ anchor: null }))).toEqual({ restore: false, scroll: false })
  })

  it('does nothing once the anchored row has been trimmed away', () => {
    expect(anchorAction(input({ anchor: { line: 100, col: 4, disposed: true } }))).toEqual({
      restore: false,
      scroll: false,
    })
  })

  it('does nothing while the selection still sits on the anchor', () => {
    expect(anchorAction(input({ selection: { line: 100, col: 4 } }))).toEqual({
      restore: false,
      scroll: false,
    })
  })

  it('restores without scrolling when the anchor is still on screen', () => {
    expect(anchorAction(input({ viewportY: 90, findViewportY: 90 }))).toEqual({
      restore: true,
      scroll: false,
    })
  })

  it('restores and scrolls when the anchor left the screen on its own', () => {
    expect(anchorAction(input({ viewportY: 400, findViewportY: 400 }))).toEqual({
      restore: true,
      scroll: true,
    })
  })

  it('restores without scrolling when the user scrolled away since the find', () => {
    expect(anchorAction(input({ viewportY: 400, findViewportY: 90 }))).toEqual({
      restore: true,
      scroll: false,
    })
  })

  it('restores when the selection is gone entirely', () => {
    expect(anchorAction(input({ selection: null }))).toEqual({ restore: true, scroll: false })
  })

  it('treats the last row of the viewport as on screen', () => {
    expect(anchorAction(input({ anchor: { line: 113, col: 0, disposed: false }, viewportY: 90 }))).toEqual({
      restore: true,
      scroll: false,
    })
    expect(anchorAction(input({ anchor: { line: 114, col: 0, disposed: false }, viewportY: 90 }))).toEqual({
      restore: true,
      scroll: true,
    })
  })
})

/**
 * Restoring the anchor re-runs the search from inside the addon's own results
 * event and relies on two things being true of the addon at that instant: the
 * background refresh has already dropped its cached term, and the event fires
 * before that term is put back. Together they make a search issued from the
 * handler start at the selection we just restored rather than step past it.
 * Both are pinned here so an addon upgrade fails a test instead of quietly
 * turning the restore into a jump to the next match.
 */
describe('search addon refresh order', () => {
  const src = fs.readFileSync(
    path.resolve('node_modules/@xterm/addon-search/lib/addon-search.mjs'),
    'utf8'
  )

  it('drops the cached term before the background re-search', () => {
    expect(src).toMatch(/clearCachedTerm\(\)\s*,\s*this\.findPrevious/)
  })

  it('fires the results event before restoring the cached term', () => {
    expect(src).toMatch(/_fireResults\([a-zA-Z$_]+\)\s*,\s*this\._state\.cachedSearchTerm\s*=/)
  })
})
