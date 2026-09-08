import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DirWatcher } from '../../src/main/fs/watcher.js'

let dir = ''
let w: DirWatcher | null = null
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seashell-w-')) })
afterEach(async () => { w?.close(); await fs.rm(dir, { recursive: true, force: true }) })

describe('DirWatcher', () => {
  it('emits once, debounced, when a file appears', async () => {
    const seen: string[] = []
    w = new DirWatcher({ emit: (d) => seen.push(d), lost: () => {}, debounceMs: 50 })
    w.subscribe(dir)
    await fs.writeFile(path.join(dir, 'a.txt'), '1')
    await fs.writeFile(path.join(dir, 'b.txt'), '2')
    await new Promise((r) => setTimeout(r, 400))
    expect(seen).toEqual([dir])
  })
  it('reports a watch it had to drop', async () => {
    const lost: string[] = []
    w = new DirWatcher({ emit: () => {}, lost: (d) => lost.push(d) })
    w.subscribe(path.join(dir, 'missing'))
    await new Promise((r) => setTimeout(r, 50))
    expect(lost).toEqual([path.join(dir, 'missing')])
  })
  it('evicts the oldest subscription past the cap', () => {
    w = new DirWatcher({ emit: () => {}, lost: () => {}, max: 2 })
    w.subscribe(dir)
    const sub = path.join(dir)
    w.subscribe(os.tmpdir())
    w.subscribe(os.homedir())
    expect(w.size()).toBe(2)
    expect(w.has(sub)).toBe(false)
  })
})
