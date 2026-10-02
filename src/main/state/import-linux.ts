import fsp from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_WSL_DISTRO, linuxToUnc, wslDistro } from '../../shared/wsl-path.js'
import { win32 } from '../platform/win32.js'

/**
 * First-run import of the Linux (WSLg) SeaShell state into the Windows build.
 *
 * Someone moving from the AppImage under WSLg to the native exe should not lose
 * their saved projects or the last window's layout. On the first Windows launch
 * (no projects.json and no last-session.json in userData, and no marker from an
 * earlier import) the two files are copied across from
 * \\wsl.localhost\<distro>\<home>\.config\seashell.
 *
 * Deliberately left behind:
 *  - window.json: its bounds were measured under WSLg's X screen, which does not
 *    match Windows' own monitor coordinates.
 *  - links/: per-machine link state, not worth carrying over.
 *
 * The Linux side is only ever read. Nothing here writes, renames or removes a
 * file under the source directory. On the target side a file that already
 * exists is never overwritten (writes use the exclusive flag), and a marker,
 * imported-from-linux.json, records the source paths and the time so the
 * import happens once and is explainable afterwards.
 */

export const IMPORT_FILES = ['projects.json', 'last-session.json'] as const
export const MARKER_FILE = 'imported-from-linux.json'

export interface ImportInput {
  platform: NodeJS.Platform
  /** The resolved userData directory to import into. */
  targetDir: string
  /** Names from IMPORT_FILES plus MARKER_FILE that already exist in targetDir. */
  targetHas: ReadonlySet<string>
  /** The Linux state directory as a Windows UNC path, or null if unresolved. */
  sourceDir: string | null
  /** Names from IMPORT_FILES that exist in sourceDir. */
  sourceHas: ReadonlySet<string>
}

export type ImportPlan =
  | { action: 'skip'; reason: string }
  | { action: 'copy'; copies: { from: string; to: string }[]; markerPath: string }

/** True when the target has nothing to protect and no earlier import ran. */
export function needsImport(platform: NodeJS.Platform, targetHas: ReadonlySet<string>): boolean {
  if (platform !== 'win32') return false
  if (targetHas.has(MARKER_FILE)) return false
  return !IMPORT_FILES.some((f) => targetHas.has(f))
}

/** The pure decision: what to copy, or why nothing is copied. */
export function planLinuxImport(input: ImportInput): ImportPlan {
  if (input.platform !== 'win32') return { action: 'skip', reason: 'not win32' }
  if (input.targetHas.has(MARKER_FILE)) return { action: 'skip', reason: 'already imported' }
  if (IMPORT_FILES.some((f) => input.targetHas.has(f))) {
    return { action: 'skip', reason: 'userData already has state' }
  }
  if (!input.sourceDir) return { action: 'skip', reason: 'linux home not resolved' }
  const present = IMPORT_FILES.filter((f) => input.sourceHas.has(f))
  if (present.length === 0) return { action: 'skip', reason: 'no linux state found' }
  const src = input.sourceDir
  return {
    action: 'copy',
    copies: present.map((f) => ({ from: path.win32.join(src, f), to: path.join(input.targetDir, f) })),
    markerPath: path.join(input.targetDir, MARKER_FILE),
  }
}

/** The distro name when the platform probe has none: env override, else the
 *  build default (wsl-path.ts owns both). */
export function resolveDistro(env: NodeJS.ProcessEnv): string {
  return wslDistro(env)
}

/**
 * \\wsl.localhost\<distro>\<home>\.config\seashell. Returns null for a home
 * that is not an absolute POSIX path, so a garbled wsl.exe reply can never be
 * turned into a path somewhere unexpected.
 */
export function wslStateDir(distro: string, home: string): string | null {
  const h = home.trim()
  if (!distro || !h.startsWith('/') || h.includes('\\') || h.split('/').includes('..')) return null
  return path.win32.join(linuxToUnc(distro, h), '.config', 'seashell')
}

/** The filesystem surface the import needs, injectable for tests. */
export interface ImportFs {
  exists(p: string): Promise<boolean>
  readFile(p: string): Promise<Buffer>
  /** Must fail when the file exists rather than overwrite it, and must never
   *  leave a partial file at `p`: a torn projects.json would block every later
   *  import and read as empty. */
  writeNew(p: string, data: Buffer | string): Promise<void>
  mkdirp(p: string): Promise<void>
}

export interface ImportDeps {
  platform: NodeJS.Platform
  userData: string
  env: NodeJS.ProcessEnv
  /** The distro the panes run in (the win32 platform probe), when known. */
  distro?: () => string | null | Promise<string | null>
  fs: ImportFs
  /** The Linux $HOME inside the distro, or null when it cannot be read. */
  linuxHome: (distro: string) => Promise<string | null>
  now: () => Date
}

export interface ImportResult {
  imported: string[]
  reason: string
}

async function presentIn(fs: ImportFs, dir: string, names: readonly string[], join: (a: string, b: string) => string): Promise<Set<string>> {
  const out = new Set<string>()
  for (const n of names) {
    if (await fs.exists(join(dir, n))) out.add(n)
  }
  return out
}

/**
 * Runs the import. Never throws: a failed import must not stop the app from
 * starting, it only means the user starts empty, as they would have anyway.
 */
export async function runLinuxImport(d: ImportDeps): Promise<ImportResult> {
  try {
    const targetHas = await presentIn(d.fs, d.userData, [...IMPORT_FILES, MARKER_FILE], path.join)
    // Decide before spawning wsl.exe, so every later launch costs two stats.
    if (!needsImport(d.platform, targetHas)) {
      if (d.platform !== 'win32') return { imported: [], reason: 'not win32' }
      return { imported: [], reason: targetHas.has(MARKER_FILE) ? 'already imported' : 'userData already has state' }
    }
    const distro = (await d.distro?.()) ?? resolveDistro(d.env)
    const home = await d.linuxHome(distro)
    const sourceDir = home ? wslStateDir(distro, home) : null
    const sourceHas = sourceDir ? await presentIn(d.fs, sourceDir, IMPORT_FILES, path.win32.join) : new Set<string>()
    const plan = planLinuxImport({ platform: d.platform, targetDir: d.userData, targetHas, sourceDir, sourceHas })
    if (plan.action === 'skip') return { imported: [], reason: plan.reason }

    await d.fs.mkdirp(d.userData)
    const imported: string[] = []
    for (const c of plan.copies) {
      try {
        await d.fs.writeNew(c.to, await d.fs.readFile(c.from))
        imported.push(c.from)
      } catch {
        /* one unreadable file must not cost the other */
      }
    }
    if (imported.length === 0) return { imported, reason: 'copy failed' }
    const marker = { importedAt: d.now().toISOString(), distro, linuxHome: home, sourceDir, files: imported }
    try {
      await d.fs.writeNew(plan.markerPath, JSON.stringify(marker, null, 2))
    } catch {
      /* the copies themselves already stop a second import */
    }
    return { imported, reason: 'imported' }
  } catch {
    return { imported: [], reason: 'error' }
  }
}

/**
 * Exclusive and atomic: the bytes go to a temp file first, which is then
 * hard-linked into place. link() fails with EEXIST when the target exists, so
 * nothing is overwritten, and the target only ever appears whole. A crash
 * mid-copy leaves at most a stray temp file, never a torn target. Where the
 * filesystem has no hard links, a rename after a fresh existence check (only
 * this process writes userData at this point of startup).
 */
export async function writeNewAtomic(p: string, data: Buffer | string): Promise<void> {
  const tmp = `${p}.${process.pid}.import-tmp`
  await fsp.writeFile(tmp, data, { flag: 'w' })
  try {
    try {
      await fsp.link(tmp, p)
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code === 'EEXIST') throw err
      if (await fsp.stat(p).then(() => true, () => false)) {
        throw Object.assign(new Error(`already exists: ${p}`), { code: 'EEXIST' })
      }
      await fsp.rename(tmp, p)
    }
  } finally {
    await fsp.rm(tmp, { force: true })
  }
}

const nodeFs: ImportFs = {
  exists: (p) => fsp.stat(p).then(() => true, () => false),
  readFile: (p) => fsp.readFile(p),
  writeNew: writeNewAtomic,
  mkdirp: (p) => fsp.mkdir(p, { recursive: true }).then(() => undefined),
}

/**
 * The IO wrapper main calls once, before anything reads userData. The distro
 * and the WSL home come from the win32 platform's startup probe, the same one
 * the panes use, so the import reads from the distro the panes will run in.
 * The probe is awaited only when an import is actually needed, and through
 * the async warm-up, so a cold WSL delays the first launch instead of failing
 * the import for good.
 */
export function importLinuxState(userData: string): Promise<ImportResult> {
  return runLinuxImport({
    platform: process.platform,
    userData,
    env: process.env,
    distro: async () => {
      await win32.warmUp()
      return win32.info().distro
    },
    fs: nodeFs,
    linuxHome: async () => {
      await win32.warmUp()
      return win32.info().home
    },
    now: () => new Date(),
  })
}
