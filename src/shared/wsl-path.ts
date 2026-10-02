/**
 * Linux <-> Windows path translation for the Windows build, which runs as a
 * Windows process while every shell, file and path the user sees lives inside
 * a WSL distro.
 *
 * The renderer only ever speaks Linux paths (`/Users/joshwald/x`). On win32 the
 * main process turns them into something Windows can open before any fs or
 * shell call, and turns whatever Windows hands back into Linux form again:
 *
 *   /mnt/c/Users/josh/x     <->  C:\Users\josh\x
 *   /Users/joshwald/x       <->  \\wsl.localhost\Ubuntu-24.04\Users\joshwald\x
 *
 * A path under a drive mount goes to the drive letter rather than through the
 * distro's 9P share: it is the same file, and the drive form is what Explorer
 * and every Windows app expect.
 *
 * Every Linux path is normalized (`.`, `..`, duplicate and trailing slashes)
 * BEFORE it is mapped, so `/mnt/c/../../etc` can never come out as
 * `C:\..\..\etc`; it is `/etc` and goes to the distro share.
 *
 * [pure]: no imports, so the renderer can use it too.
 */

/** The distro the Windows build was set up against. */
export const DEFAULT_WSL_DISTRO = 'Ubuntu-24.04'

/** The UNC host Windows 11 serves WSL distros on. `wsl$` is the older alias. */
const UNC_HOST = 'wsl.localhost'

/**
 * The distro name, from one place. `SEASHELL_WSL_DISTRO` overrides it; the
 * fallback is the distro this build was made for. Reads `process.env` only when
 * there is one, so the renderer gets the fallback instead of a crash.
 */
export function wslDistro(env?: Record<string, string | undefined>): string {
  const source =
    env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const v = source?.['SEASHELL_WSL_DISTRO']?.trim()
  // A distro name is one path segment. Anything that is not is ignored rather
  // than spliced into a UNC path.
  return v && /^[^\\/:*?"<>|]+$/.test(v) ? v : DEFAULT_WSL_DISTRO
}

/** `C:\x`, `c:/x`, `C:` and every UNC (`\\host\share`, `//host/share`). */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || /^[\\/]{2}[^\\/]/.test(p)
}

/** An absolute POSIX path: starts with one `/` and is not a `//` UNC. */
export function isLinuxPath(p: string): boolean {
  return p.startsWith('/') && !isWindowsPath(p)
}

/** POSIX normalization of an absolute path: `/`-joined, no `.`/`..`/empty
 *  segments, no trailing slash. `..` at the root stays at the root. */
function linuxSegments(p: string): string[] {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out
}

/** Same as linuxSegments for the tail of a Windows path, either separator. */
function windowsSegments(p: string): string[] {
  const out: string[] = []
  for (const seg of p.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out
}

/**
 * `/mnt/c/Users/josh/x` -> `C:\Users\josh\x`, any drive letter; `/mnt/d` ->
 * `D:\`. Null for anything that is not under a single-letter drive mount
 * (`/mnt/wsl`, `/mnt/cdrom` and the rest belong to the distro).
 */
export function mntToWindows(p: string): string | null {
  if (!isLinuxPath(p)) return null
  const segs = linuxSegments(p)
  if (segs.length < 2 || segs[0] !== 'mnt' || !/^[A-Za-z]$/.test(segs[1]!)) return null
  return `${segs[1]!.toUpperCase()}:\\${segs.slice(2).join('\\')}`
}

/** `C:\Users\josh\x` (either separator) -> `/mnt/c/Users/josh/x`; `C:\` ->
 *  `/mnt/c`. Null for anything that is not drive-letter shaped. */
export function windowsToMnt(p: string): string | null {
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(p)
  if (!m) return null
  const rest = windowsSegments(m[2] ?? '')
  return `/mnt/${m[1]!.toLowerCase()}${rest.length ? '/' + rest.join('/') : ''}`
}

/** `/Users/joshwald/x` -> `\\wsl.localhost\<distro>\Users\joshwald\x`; `/`
 *  -> `\\wsl.localhost\<distro>\`. The path is normalized first. */
export function linuxToUnc(distro: string, p: string): string {
  return `\\\\${UNC_HOST}\\${distro}\\${linuxSegments(p).join('\\')}`
}

/**
 * The reverse of linuxToUnc: `\\wsl.localhost\<distro>\a\b` (or `\\wsl$\`,
 * either separator, any case of host, with or without a `\\?\UNC\` prefix) ->
 * `{ distro, path: '/a/b' }`. Null for any other UNC or non-UNC path.
 */
export function uncToLinux(p: string): { distro: string; path: string } | null {
  const stripped = p.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, '\\\\')
  const m = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(stripped)
  if (!m) return null
  return { distro: m[2]!, path: '/' + windowsSegments(m[3] ?? '').join('/') }
}

/**
 * The form Windows opens: drive form under `/mnt/<letter>`, the distro share
 * for everything else. A path that is already Windows-shaped, or not absolute
 * at all, is returned untouched.
 */
export function linuxToWindows(p: string, distro: string): string {
  if (!isLinuxPath(p)) return p
  return mntToWindows(p) ?? linuxToUnc(distro, p)
}

/**
 * The form the renderer sees: a drive path becomes `/mnt/<letter>/...`, a WSL
 * share path becomes the Linux path inside the distro. Anything else (a Linux
 * path already, a relative path, a non-WSL network share) is returned
 * untouched.
 */
export function windowsToLinux(p: string): string {
  const drive = windowsToMnt(p)
  if (drive !== null) return drive
  const unc = uncToLinux(p)
  if (unc !== null) return unc.path
  return p
}
