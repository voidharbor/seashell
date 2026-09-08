import { describe, expect, it } from 'vitest'
import { isIgnoredDir, type IgnoredLookup } from '../../src/renderer/explorer/ignored.js'

const entry = (name: string, ignored: boolean) => ({
  name,
  isDir: true,
  isSymlink: false,
  size: 0,
  mtimeMs: 0,
  ignored,
})

const dirs: IgnoredLookup = {
  '/r': { entries: [entry('node_modules', true), entry('src', false)] },
  '/r/src': { entries: [] },
}

describe('isIgnoredDir', () => {
  it('is true when the parent listed it as ignored', () => {
    expect(isIgnoredDir(dirs, '/r/node_modules')).toBe(true)
  })

  it('is false when the parent listed it as ordinary', () => {
    expect(isIgnoredDir(dirs, '/r/src')).toBe(false)
  })

  it('is false when the parent has not been listed yet', () => {
    // The flag arrives with the parent's listing. Until it does there is
    // nothing to refuse on, and the answer must not be a guess.
    expect(isIgnoredDir(dirs, '/elsewhere/dist')).toBe(false)
  })

  it('is false for a root, which has no parent listing here', () => {
    expect(isIgnoredDir(dirs, '/r')).toBe(false)
    expect(isIgnoredDir(dirs, '/')).toBe(false)
  })

  it('does not confuse a name that merely ends the same way', () => {
    expect(isIgnoredDir(dirs, '/r/my_node_modules')).toBe(false)
  })
})
