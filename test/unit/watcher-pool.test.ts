import { describe, expect, it } from 'vitest'
import { isWatchable, pickEvictions } from '../../src/main/fs/watcher-pool.js'

describe('pickEvictions', () => {
  it('evicts the least recently touched beyond the cap', () => {
    const e = [
      { dir: '/a', lastTouch: 30 },
      { dir: '/b', lastTouch: 10 },
      { dir: '/c', lastTouch: 20 },
    ]
    expect(pickEvictions(e, 2)).toEqual(['/b'])
    expect(pickEvictions(e, 1)).toEqual(['/b', '/c'])
    expect(pickEvictions(e, 3)).toEqual([])
  })
})

describe('isWatchable', () => {
  it('refuses always-hidden directories anywhere in the path', () => {
    expect(isWatchable('/r/node_modules/x')).toBe(false)
    expect(isWatchable('/r/.git')).toBe(false)
    expect(isWatchable('/r/src')).toBe(true)
  })
})
