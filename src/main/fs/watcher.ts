import fs from 'node:fs'
import { isWatchable, pickEvictions } from './watcher-pool.js'
import { toHostPath } from './host-path.js'

export interface DirWatcherDeps {
  emit: (dir: string) => void
  lost: (dir: string) => void
  max?: number
  debounceMs?: number
  now?: () => number
}

interface Entry {
  watcher: fs.FSWatcher
  lastTouch: number
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * One non-recursive fs.watch per expanded directory, capped, debounced.
 *
 * macOS delivers these through FSEvents via libuv; a handle per directory is
 * cheap but not free, so the pool evicts the least recently rendered when it
 * is full. A dropped watch is reported, never silently absent, so the explorer
 * can fall back to click-to-refresh for that directory.
 */
export class DirWatcher {
  private readonly entries = new Map<string, Entry>()
  private readonly max: number
  private readonly debounceMs: number
  private readonly now: () => number

  constructor(private readonly d: DirWatcherDeps) {
    this.max = d.max ?? 64
    this.debounceMs = d.debounceMs ?? 250
    this.now = d.now ?? Date.now
  }

  subscribe(dir: string): void {
    if (this.entries.has(dir) || !isWatchable(dir)) return
    let watcher: fs.FSWatcher
    try {
      // Keyed and reported by the renderer's own (Linux) path; only the watch
      // itself goes through the Windows form on win32. Windows refuses to
      // watch a WSL share today, which lands in `lost` below, and the
      // explorer falls back to click-to-refresh for that directory.
      watcher = fs.watch(toHostPath(dir), { persistent: false })
    } catch {
      this.d.lost(dir)
      return
    }
    const entry: Entry = { watcher, lastTouch: this.now(), timer: null }
    watcher.on('change', () => this.schedule(dir, entry))
    watcher.on('error', () => {
      this.drop(dir)
      this.d.lost(dir)
    })
    this.entries.set(dir, entry)
    for (const victim of pickEvictions([...this.entries].map(([k, v]) => ({ dir: k, lastTouch: v.lastTouch })), this.max)) {
      this.drop(victim)
      this.d.lost(victim)
    }
  }

  unsubscribe(dir: string): void {
    this.drop(dir)
  }

  touch(dir: string): void {
    const e = this.entries.get(dir)
    if (e) e.lastTouch = this.now()
  }

  has(dir: string): boolean {
    return this.entries.has(dir)
  }

  size(): number {
    return this.entries.size
  }

  close(): void {
    for (const dir of [...this.entries.keys()]) this.drop(dir)
  }

  private schedule(dir: string, e: Entry): void {
    if (e.timer) return
    e.timer = setTimeout(() => {
      e.timer = null
      if (this.entries.has(dir)) this.d.emit(dir)
    }, this.debounceMs)
  }

  private drop(dir: string): void {
    const e = this.entries.get(dir)
    if (!e) return
    if (e.timer) clearTimeout(e.timer)
    e.watcher.close()
    this.entries.delete(dir)
  }
}
