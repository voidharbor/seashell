import { describe, expect, it } from 'vitest'
import { ancestorsOf, expandChain, parentOf } from '../../src/renderer/explorer/chain.js'

const ROOT = '/Users/j'

describe('parentOf', () => {
  it('walks up one level', () => {
    expect(parentOf('/Users/j/work/a.ts')).toBe('/Users/j/work')
  })

  it('bottoms out at the filesystem root rather than the empty string', () => {
    expect(parentOf('/Users')).toBe('/')
    expect(parentOf('/')).toBe('/')
  })
})

describe('ancestorsOf', () => {
  it('lists the directories from the root down to the parent', () => {
    expect(ancestorsOf('/Users/j/work/src/a.ts', ROOT)).toEqual([
      '/Users/j',
      '/Users/j/work',
      '/Users/j/work/src',
    ])
  })

  it('yields nothing for a path outside the root', () => {
    // The tree can only expand to something beneath its own root.
    expect(ancestorsOf('/tmp/a.ts', ROOT)).toEqual([])
  })
})

/**
 * The reported bug: files reveal correctly, folders land on the row and stop.
 *
 * `ancestorsOf` stops at the parent — right for a file, since the parent is
 * what has to be open for the file's row to exist at all. For a directory it
 * meant the folder was selected, scrolled to, and left firmly shut.
 */
describe('expandChain', () => {
  it('opens a revealed directory, not just its parent', () => {
    const chain = expandChain('/Users/j/work/src', ROOT, true)
    expect(chain).toEqual(['/Users/j', '/Users/j/work', '/Users/j/work/src'])
    // Deepest last, so the loader opens them outermost-first.
    expect(chain.at(-1)).toBe('/Users/j/work/src')
  })

  it('leaves a file expanding nothing beyond its parent', () => {
    // Unchanged behaviour, asserted so the directory case cannot regress it.
    expect(expandChain('/Users/j/work/a.ts', ROOT, false)).toEqual([
      '/Users/j',
      '/Users/j/work',
    ])
  })

  it('does not expand a directory that lies outside the root', () => {
    // Appending it would open an orphan whose ancestors are not in the tree.
    expect(expandChain('/tmp/somewhere', ROOT, true)).toEqual([])
  })

  it('asks for nothing when the root itself is revealed', () => {
    // The root has no ancestors inside the tree and is expanded from mount, so
    // there is genuinely nothing to open. Selection still lands on it.
    expect(expandChain(ROOT, ROOT, true)).toEqual([])
  })

  it('handles a directory sitting directly under the root', () => {
    expect(expandChain('/Users/j/work', ROOT, true)).toEqual(['/Users/j', '/Users/j/work'])
  })
})
