/**
 * Turn a file drop into text for the shell: every path shell-quoted, space-joined, with a
 * trailing space (the way macOS Terminal and iTerm2 insert dropped files). Nothing is run.
 *
 * WSLg can hand us a drop in three shapes, so all three are accepted:
 *  - real File objects (path via Electron's webUtils, passed in as `paths`)
 *  - a text/uri-list of file:// URIs
 *  - plain text that is itself a path, including a Windows path like C:\Users\josh\a.pdf
 */
export interface DropInput {
  paths: string[]
  uriList?: string
  text?: string
}

/** POSIX single-quote a path so spaces, $, quotes and globs arrive literally. */
export function shellQuote(p: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p)) return p
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/** C:\a\b -> /mnt/c/a/b on Linux (WSL); anything else unchanged. */
export function windowsToWsl(p: string, platform: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (!m || platform !== 'linux') return p
  return `/mnt/${(m[1] ?? "").toLowerCase()}/${(m[2] ?? "").replace(/\\/g, "/")}`
}

function fromUri(u: string): string | null {
  const s = u.trim()
  if (!s || s.startsWith('#')) return null
  if (!s.toLowerCase().startsWith('file://')) return null
  try {
    const url = new URL(s)
    let p = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1) // file:///C:/x -> C:/x
    return p
  } catch {
    return null
  }
}

export function dropText(input: DropInput, platform: string): string {
  let paths = input.paths.filter(Boolean)
  if (paths.length === 0 && input.uriList) {
    paths = input.uriList.split(/\r?\n/).map(fromUri).filter((p): p is string => !!p)
  }
  if (paths.length === 0 && input.text) {
    const lines = input.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.every((l) => l.startsWith('/') || /^[A-Za-z]:[\\/]/.test(l) || l.startsWith('file://'))) {
      paths = lines.map((l) => (l.startsWith('file://') ? fromUri(l) ?? l : l))
    }
  }
  if (paths.length === 0) return ''
  return paths.map((p) => shellQuote(windowsToWsl(p, platform))).join(' ') + ' '
}
