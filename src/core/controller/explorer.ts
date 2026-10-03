/**
 * The file explorer's tree without React or IO: the state `Explorer.tsx`
 * keeps (the listings, the expanded set, the selection, the reveal flash, the
 * watched set) and its render walk, turned into the model's `SidebarRow`s.
 * The controller does the reads and the watch sends and feeds the answers
 * back in, so everything here is testable with plain listings.
 */
import { expandChain } from '../../renderer/explorer/chain.js'
import { isIgnoredDir } from '../../renderer/explorer/ignored.js'
import type { FsDirEntry } from '../../shared/ipc.js'
import type { SidebarRow } from './model.js'

/** How long a revealed row stays highlighted (`Explorer.tsx:259`). */
export const FLASH_MS = 2500

/**
 * The file icon's colour chip per extension, copied from `tintFor` in
 * `src/renderer/explorer/icons.tsx:33-63` (that module renders SVG through
 * React, so it is not imported). A Map, so a name like `x.constructor` never
 * finds a prototype key.
 */
export const CHIP_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['ts', '#3178C6'],
  ['tsx', '#3178C6'],
  ['js', '#E5A83C'],
  ['jsx', '#E5A83C'],
  ['mjs', '#E5A83C'],
  ['cjs', '#E5A83C'],
  ['json', '#8A6FD1'],
  ['md', '#5E9CD6'],
  ['markdown', '#5E9CD6'],
  ['css', '#C6538C'],
  ['html', '#E06C3A'],
  ['py', '#3D7EAE'],
  ['sh', '#4EA353'],
  ['zsh', '#4EA353'],
  ['bash', '#4EA353'],
  ['yml', '#7C8794'],
  ['yaml', '#7C8794'],
  ['toml', '#7C8794'],
])

/**
 * Never watched, whatever is expanded: `ALWAYS_HIDDEN_NAMES` in
 * `src/main/fs/gitignore.ts:29`, which main's `isWatchable`
 * (`src/main/fs/watcher-pool.ts:15`) refuses as well. Copied rather than
 * imported so the controller does not pull main's gitignore engine in.
 */
const NEVER_WATCHED: ReadonlySet<string> = new Set(['node_modules', '.git', '.DS_Store'])

export interface DirState {
  entries: FsDirEntry[]
  truncated: boolean
  /** The error code of a listing that failed, e.g. `ENOENT`. */
  error?: string
}

/**
 * What `fs:readDir` answers. A failure is the `Result` envelope
 * (`{ ok: false, code, message }`); `{ ok: false, error }` is accepted too.
 */
export type Listing =
  | { ok: true; entries: FsDirEntry[]; truncated: boolean }
  | { ok: false; code?: string; error?: string; message?: string }

/** `Explorer.tsx:22-25`: the text after the last dot, lower-cased; a leading dot is no extension. */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** `Explorer.tsx:308`. */
export function childPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** Whether two listings draw the same rows: the names, kinds and ignore marks, the truncation and the error. */
function sameRows(a: DirState | undefined, b: DirState): boolean {
  if (!a || a.truncated !== b.truncated || a.error !== b.error || a.entries.length !== b.entries.length) return false
  return a.entries.every((e, i) => {
    const f = b.entries[i]!
    return e.name === f.name && e.isDir === f.isDir && (e.ignored === true) === (f.ignored === true)
  })
}

/** `Explorer.tsx:27-29`. */
export function displayRoot(root: string, home: string): string {
  return root === home ? 'Home' : (root.split('/').filter(Boolean).pop() ?? root)
}

function errorCode(res: Listing | null | undefined): string {
  if (res && res.ok === false) {
    if (typeof res.code === 'string' && res.code !== '') return res.code
    if (typeof res.error === 'string' && res.error !== '') return res.error
  }
  return 'error'
}

export class ExplorerState {
  readonly root: string
  /** Only decides whether the root row reads `Home`. */
  readonly home: string
  /** Listings by directory; no prototype, so any path is a plain key. */
  readonly dirs: Record<string, DirState> = Object.create(null) as Record<string, DirState>
  /** Change it through `toggle` and `expand`, which keep `rows()` current. */
  readonly expanded = new Set<string>()
  /** Directories main has been asked to watch and not yet told to drop. */
  readonly subscribed = new Set<string>()
  /**
   * Subscribed directories main reported lost (`watch:lost`). They stay in
   * `subscribed`, so the diff never asks for them again: the directory just
   * stops auto-refreshing until it is collapsed and re-expanded
   * (`Explorer.tsx:188-202`). They are no longer touched.
   */
  readonly lost = new Set<string>()
  private reads = 0
  /** The newest read applied per directory, so a slow stale read never overwrites a newer one. */
  private readonly applied = new Map<string, number>()
  private selectedPath: string | null = null
  private flashState: { path: string; until: number } | null = null
  /** Bumped by every change that alters `rows()`; the walk is cached against it. */
  private ver = 0
  private cache: { ver: number; rows: SidebarRow[] } | null = null

  constructor(root: string, home: string = root) {
    this.root = root
    this.home = home
  }

  /** Changes whenever `rows()` would return different rows. */
  get version(): number {
    return this.ver
  }

  get selected(): string | null {
    return this.selectedPath
  }

  /** The reveal flash; only a change of its path changes the rows. */
  get flash(): { path: string; until: number } | null {
    return this.flashState
  }

  set flash(v: { path: string; until: number } | null) {
    if ((v?.path ?? null) !== (this.flashState?.path ?? null)) this.ver++
    this.flashState = v
  }

  /** A ticket for a read about to start; pass it back to `applyListing`. */
  nextRead(): number {
    return ++this.reads
  }

  /**
   * Stores a listing (`Explorer.tsx:86-94`). Returns false and changes
   * nothing when a newer read of the same directory already landed.
   */
  applyListing(path: string, res: Listing, seq: number = this.nextRead()): boolean {
    if (seq <= (this.applied.get(path) ?? 0)) return false
    this.applied.set(path, seq)
    const next: DirState =
      res && res.ok === true && Array.isArray(res.entries)
        ? { entries: res.entries, truncated: res.truncated === true }
        : { entries: [], truncated: false, error: errorCode(res) }
    // A re-read that lists the same entries (a watch event, a refresh) leaves the rows, and so the model's, alone.
    if (!sameRows(this.dirs[path], next)) this.ver++
    this.dirs[path] = next
    return true
  }

  /** Flips a directory open or shut; true when it is now open. */
  toggle(path: string): boolean {
    this.ver++
    if (this.expanded.delete(path)) return false
    this.expanded.add(path)
    return true
  }

  expand(path: string): void {
    if (this.expanded.has(path)) return
    this.expanded.add(path)
    this.ver++
  }

  select(path: string): void {
    if (this.selectedPath === path) return
    this.selectedPath = path
    this.ver++
  }

  markLost(path: string): void {
    if (this.subscribed.has(path)) this.lost.add(path)
  }

  /** The directories a reveal re-reads and expands, root first (`chain.ts` expandChain). */
  revealChain(path: string, isDir: boolean, root: string = this.root): string[] {
    return expandChain(path, root, isDir)
  }

  /**
   * Expanded directories worth a watch, sorted: not gitignored by their
   * parent's listing (`ignored.ts`) and never under `node_modules` or `.git`.
   */
  watchable(): string[] {
    return [...this.expanded]
      .filter((dir) => !dir.split('/').some((seg) => NEVER_WATCHED.has(seg)) && !isIgnoredDir(this.dirs, dir))
      .sort()
  }

  /** What to subscribe and unsubscribe to go from `prev` to `watchable()` (`Explorer.tsx:151-178`). */
  watchDiff(prev: ReadonlySet<string>): { subscribe: string[]; unsubscribe: string[] } {
    const want = this.watchable()
    const keep = new Set(want)
    return {
      subscribe: want.filter((dir) => !prev.has(dir)),
      unsubscribe: [...prev].filter((dir) => !keep.has(dir)).sort(),
    }
  }

  /**
   * The rows the shell draws, in order: the root first, then a depth-first
   * walk of every expanded directory (`Explorer.tsx:295-403`). A directory
   * that failed to list carries its `(CODE)` on its own row while it is open;
   * a truncated listing flags the last row of its subtree, which the
   * `… too many entries to list` line follows. Cached until the next change,
   * so the array is shared: read it, never change it.
   */
  rows(): SidebarRow[] {
    if (this.cache?.ver === this.ver) return this.cache.rows
    const out: SidebarRow[] = []
    const open = this.expanded.has(this.root)
    out.push(this.row(this.root, displayRoot(this.root, this.home), 0, true, open, false))
    if (open) this.walk(this.root, 1, out)
    this.cache = { ver: this.ver, rows: out }
    return out
  }

  private walk(dir: string, depth: number, out: SidebarRow[]): void {
    const state = this.dirs[dir]
    if (!state || state.error !== undefined) return
    for (const e of state.entries) {
      const full = childPath(dir, e.name)
      const open = e.isDir && this.expanded.has(full)
      out.push(this.row(full, e.name, depth, e.isDir, open, e.ignored === true))
      if (open) this.walk(full, depth + 1, out)
    }
    const last = out[out.length - 1]
    if (state.truncated && last) last.truncatedAfter = true
  }

  private row(path: string, name: string, depth: number, isDir: boolean, expanded: boolean, ignored: boolean): SidebarRow {
    const err = isDir && expanded ? this.dirs[path]?.error : undefined
    return {
      id: `row:${path}`,
      path,
      name,
      depth,
      isDir,
      expanded,
      selected: this.selectedPath === path,
      ignored,
      flashing: this.flashState !== null && this.flashState.path === path,
      chip: isDir ? null : (CHIP_BY_EXT.get(extOf(name)) ?? null),
      error: err !== undefined ? `(${err})` : null,
      truncatedAfter: false,
    }
  }
}
