import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Explorer, type ExplorerProps } from '../../src/renderer/explorer/Explorer.js'
import type { FsDirEntry } from '../../src/shared/ipc.js'

/**
 * The reveal must show files that did not exist when the directory was first
 * listed. The tree caches each directory's entries, and the reveal effect used
 * to load only directories it had never seen — so a path whose parent was
 * already cached revealed into a listing that had no row for it. Nothing
 * expanded, nothing highlighted: a dead double-click, indistinguishable from
 * the tokenizer finding no path at all. The listing a reveal lands in must be
 * at least as fresh as the reveal.
 */

function entry(name: string, isDir = false): FsDirEntry {
  return { name, isDir, isSymlink: false, size: 0, mtimeMs: 0, ignored: false }
}

/** Per-path listings the fake readDir serves; tests mutate this to simulate
 *  files appearing on disk after a directory was already listed. */
let listings: Record<string, FsDirEntry[]>

beforeEach(() => {
  listings = { '/root': [entry('old.txt')] }
  vi.stubGlobal('seashell', {
    fs: {
      readDir: vi.fn(({ path }: { path: string }) =>
        Promise.resolve(
          listings[path]
            ? { ok: true, entries: listings[path], truncated: false }
            : { ok: false, code: 'ENOENT' }
        )
      ),
    },
  })
  // happy-dom leaves scrollIntoView unimplemented; the reveal calls it in a
  // requestAnimationFrame after the row exists.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function props(overrides: Partial<ExplorerProps> = {}): ExplorerProps {
  return {
    root: '/root',
    home: '/root',
    revealPath: null,
    refreshNonce: 0,
    onRevealHandled: () => {},
    onOpenInViewer: () => {},
    onToast: () => {},
    ...overrides,
  }
}

describe('Explorer reveal', () => {
  it('reveals a file that existed when the directory was first listed', async () => {
    const { rerender } = render(<Explorer {...props()} />)
    await screen.findByText('old.txt')

    rerender(<Explorer {...props({ revealPath: { path: '/root/old.txt', isDir: false } })} />)

    await waitFor(() => {
      expect(document.querySelector('[data-path="/root/old.txt"]')?.className).toContain(
        'node--selected'
      )
    })
  })

  it('reveals a file created after the directory was already listed', async () => {
    const { rerender } = render(<Explorer {...props()} />)
    await screen.findByText('old.txt')

    // The file appears on disk only now — the cached listing has no row for it.
    listings['/root'] = [entry('new.txt'), entry('old.txt')]

    rerender(<Explorer {...props({ revealPath: { path: '/root/new.txt', isDir: false } })} />)

    await waitFor(() => {
      expect(document.querySelector('[data-path="/root/new.txt"]')?.className).toContain(
        'node--selected'
      )
    })
  })

  it('reveals into a subdirectory whose cached listing predates the file', async () => {
    listings['/root'] = [entry('sub', true)]
    listings['/root/sub'] = [entry('a.txt')]

    const { rerender } = render(<Explorer {...props()} />)
    await screen.findByText('sub')

    // Expand `sub` via a reveal so its listing gets cached...
    rerender(<Explorer {...props({ revealPath: { path: '/root/sub/a.txt', isDir: false } })} />)
    await screen.findByText('a.txt')

    // ...then a new file lands in it and is revealed.
    listings['/root/sub'] = [entry('a.txt'), entry('b.txt')]
    rerender(<Explorer {...props({ revealPath: { path: '/root/sub/b.txt', isDir: false } })} />)

    await waitFor(() => {
      expect(document.querySelector('[data-path="/root/sub/b.txt"]')?.className).toContain(
        'node--selected'
      )
    })
  })
})
