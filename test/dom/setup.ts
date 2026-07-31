/**
 * DOM test setup.
 *
 * Node 22+ exposes a built-in `localStorage` global that is inert unless the
 * process was started with `--localstorage-file`, and it takes precedence over
 * the one happy-dom installs. The result is a `window.localStorage` that exists
 * as a name but throws on use, which is a confusing failure to debug from a
 * component test.
 *
 * Installing an explicit in-memory implementation removes the ambiguity and
 * keeps each test isolated — the app's own storage access is already wrapped in
 * try/catch, so this only affects what the tests observe.
 */

class MemoryStorage implements Storage {
  private data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

const storage = new MemoryStorage()

Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  configurable: true,
  writable: true,
})

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}
