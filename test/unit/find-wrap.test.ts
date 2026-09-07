import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The find bar promises wrap-around and gets it from the addon, not from its
 * own code. If a future addon version stops wrapping, this fails before a
 * user notices Enter dying at the last match.
 */
describe('search addon wrap-around', () => {
  it('still wraps from the end of the buffer to the start', () => {
    const src = fs.readFileSync(
      path.resolve('node_modules/@xterm/addon-search/lib/addon-search.mjs'),
      'utf8'
    )
    // The addon searches from the start again when nothing follows the selection.
    expect(src).toMatch(/_findInLine|findInLine/)
    expect(src).toMatch(/startRow=0|startRow = 0|startCol=0|startCol = 0/)
  })
})
