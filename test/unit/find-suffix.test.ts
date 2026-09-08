import { describe, expect, it } from 'vitest'
import { findBySuffix } from '../../src/main/fs/find-suffix.js'
import type { FsReadDirRequest, FsReadDirResponse } from '../../src/shared/ipc.js'

const tree: Record<string, Array<{ name: string; isDir: boolean }>> = {
  '/r': [
    { name: 'src', isDir: true },
    { name: 'docs', isDir: true },
    { name: 'app.tsx', isDir: false },
  ],
  '/r/src': [{ name: 'renderer', isDir: true }],
  '/r/src/renderer': [{ name: 'app.tsx', isDir: false }, { name: 'store.ts', isDir: false }],
  '/r/docs': [{ name: 'app.tsx', isDir: false }],
}
const fakeReadDir = async (req: FsReadDirRequest): Promise<FsReadDirResponse> => {
  const entries = tree[req.path]
  if (!entries) return { ok: false, code: 'ENOENT', message: 'no' } as FsReadDirResponse
  return { ok: true, entries: entries.map((e) => ({ ...e, size: 0 })), truncated: false } as FsReadDirResponse
}

describe('findBySuffix', () => {
  it('finds every path ending in the suffix, segment-anchored', async () => {
    const r = await findBySuffix({ root: '/r', suffix: '/app.tsx', limit: 10 }, fakeReadDir)
    expect(r.paths.sort()).toEqual(['/r/app.tsx', '/r/docs/app.tsx', '/r/src/renderer/app.tsx'])
    expect(r.truncated).toBe(false)
  })
  it('a longer suffix narrows to one', async () => {
    const r = await findBySuffix({ root: '/r', suffix: '/renderer/app.tsx', limit: 10 }, fakeReadDir)
    expect(r.paths).toEqual(['/r/src/renderer/app.tsx'])
  })
  it('does not spend the walk inside a gitignored directory', async () => {
    const withIgnored: Record<string, Array<{ name: string; isDir: boolean; ignored?: boolean }>> = {
      '/g': [
        { name: 'dist', isDir: true, ignored: true },
        { name: 'src', isDir: true },
      ],
      '/g/src': [{ name: 'app.tsx', isDir: false }],
      '/g/dist': [{ name: 'app.tsx', isDir: false }],
    }
    const readDir = async (req: FsReadDirRequest): Promise<FsReadDirResponse> => {
      const entries = withIgnored[req.path]
      if (!entries) return { ok: false, code: 'ENOENT', message: 'no' } as FsReadDirResponse
      return { ok: true, entries: entries.map((e) => ({ ...e, size: 0 })), truncated: false } as FsReadDirResponse
    }
    const r = await findBySuffix({ root: '/g', suffix: '/app.tsx', limit: 10 }, readDir)
    expect(r.paths).toEqual(['/g/src/app.tsx'])
  })

  it('reports a truncated listing as a truncated search', async () => {
    const flat: Record<string, Array<{ name: string; isDir: boolean }>> = {
      '/t': [
        { name: 'big', isDir: true },
        { name: 'app.tsx', isDir: false },
      ],
      // readDir stopped listing this one at its own 5,000-entry cap, so
      // "nothing here ends in .tsx" is a claim the walk cannot make.
      '/t/big': [{ name: 'one.ts', isDir: false }],
    }
    const readDir = async (req: FsReadDirRequest): Promise<FsReadDirResponse> => {
      const entries = flat[req.path]
      if (!entries) return { ok: false, code: 'ENOENT', message: 'no' } as FsReadDirResponse
      return {
        ok: true,
        entries: entries.map((e) => ({ ...e, size: 0 })),
        truncated: req.path === '/t/big',
      } as FsReadDirResponse
    }
    const r = await findBySuffix({ root: '/t', suffix: '/app.tsx', limit: 10 }, readDir)
    expect(r.paths).toEqual(['/t/app.tsx'])
    expect(r.truncated).toBe(true)
  })

  it('stops at the limit and says so', async () => {
    const r = await findBySuffix({ root: '/r', suffix: '/app.tsx', limit: 2 }, fakeReadDir)
    expect(r.paths).toHaveLength(2)
    expect(r.truncated).toBe(true)
  })
})
