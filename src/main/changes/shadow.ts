import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import ignoreFactory from 'ignore'

/**
 * A shadow git repository per agent session, kept under SeaShell's own user
 * data, that snapshots the session's working directory without ever touching
 * the user's own repository: every command runs with GIT_DIR and
 * GIT_WORK_TREE pointing at the shadow and the cwd, so the cwd's `.git` (if
 * any) is never read or written. `add -A` then `write-tree` is a snapshot;
 * two snapshots' `diff-tree` is every file created, edited or deleted between
 * them, whatever tool did it. (opencode does the same for its own undo.)
 *
 * The worktree's .gitignore files are honoured as git honours them, and the
 * shadow's own exclude file adds the directories nobody wants watched.
 */

/** Directories never snapshotted, whatever .gitignore says. */
export const SKIP_DIRS: readonly string[] = [
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.parcel-cache', '.turbo', 'coverage', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache',
  '.pytest_cache', '.gradle', '.idea', '.DS_Store', 'Pods', 'DerivedData',
]

/** The most files and bytes a watched directory may hold. */
export const MAX_FILES = 20_000
export const MAX_BYTES = 200 * 1024 * 1024

export type SnapshotRefusal = 'home' | 'root' | 'too-big' | 'missing' | 'no-git'

/**
 * Why `cwd` must not be snapshotted, or null when it may be: the home
 * directory, a filesystem root or a directory directly under one (`/home`,
 * `/Users`, `/mnt/c`). Size is checked separately (`measureTree`). [pure]
 */
export function refuseDir(cwd: string, home: string): SnapshotRefusal | null {
  const norm = cwd.replace(/\/+$/, '') || '/'
  const h = home.replace(/\/+$/, '')
  if (norm === h) return 'home'
  if (norm === '/' || /^\/[^/]+$/.test(norm) || /^\/mnt\/[a-z]$/i.test(norm)) return 'root'
  if (h !== '' && h.startsWith(`${norm}/`)) return 'home'
  return null
}

/**
 * Counts the files under `dir` that a snapshot would take, skipping
 * `SKIP_DIRS` and the root .gitignore, and stops as soon as either cap is
 * passed. `over` says it was passed.
 */
export async function measureTree(dir: string, maxFiles = MAX_FILES, maxBytes = MAX_BYTES): Promise<{ files: number; bytes: number; over: boolean }> {
  const ig = ignoreFactory()
  try {
    ig.add(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'))
  } catch {
    /* none */
  }
  const skip = new Set(SKIP_DIRS)
  let files = 0
  let bytes = 0
  const stack: string[] = ['']
  while (stack.length > 0) {
    const rel = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!ig.ignores(`${r}/`)) stack.push(r)
        continue
      }
      if (!e.isFile() || ig.ignores(r)) continue
      files += 1
      try {
        bytes += (await fs.lstat(path.join(dir, r))).size
      } catch {
        /* vanished */
      }
      if (files > maxFiles || bytes > maxBytes) return { files, bytes, over: true }
    }
  }
  return { files, bytes, over: false }
}

/** git's environment for one shadow: nothing inherited that could point it elsewhere. */
function gitEnv(gitDir: string, workTree: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  return {
    ...env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: path.join(gitDir, 'index'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  }
}

/** Flags that keep the user's hooks, fsmonitor and line-ending rules out of it. */
const GIT_FLAGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.quotepath=off',
  '-c', 'advice.addEmbeddedRepo=false',
  '-c', 'gc.auto=0',
]

export function runGit(
  gitDir: string,
  workTree: string,
  args: string[],
  opts: { encoding?: 'buffer'; timeoutMs?: number } = {}
): Promise<{ ok: boolean; stdout: Buffer }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_FLAGS, ...args],
      {
        cwd: workTree,
        env: gitEnv(gitDir, workTree),
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 60_000,
        windowsHide: true,
      },
      (err, stdout) => resolve({ ok: !err, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')) })
    )
  })
}

/** Creates the shadow repository once, with its exclude file. */
export async function ensureShadow(gitDir: string, workTree: string): Promise<boolean> {
  try {
    await fs.access(path.join(gitDir, 'HEAD'))
    return true
  } catch {
    /* create it */
  }
  await fs.mkdir(gitDir, { recursive: true })
  const init = await runGit(gitDir, workTree, ['init', '-q'])
  if (!init.ok) return false
  await fs.mkdir(path.join(gitDir, 'info'), { recursive: true })
  await fs.writeFile(path.join(gitDir, 'info', 'exclude'), SKIP_DIRS.map((d) => `${d}/\n${d}\n`).join(''))
  return true
}

/** One snapshot of the worktree: the tree id, or null when git failed. */
export async function snapshot(gitDir: string, workTree: string): Promise<string | null> {
  if (!(await ensureShadow(gitDir, workTree))) return null
  // --ignore-errors: a file that cannot be read (a socket, a permission
  // error) must not cost the whole snapshot.
  const add = await runGit(gitDir, workTree, ['add', '-A', '--ignore-errors', '--', '.'])
  // `add` exits 1 after --ignore-errors skipped something; write-tree decides.
  void add
  const tree = await runGit(gitDir, workTree, ['write-tree'])
  const sha = tree.stdout.toString('utf8').trim()
  return tree.ok && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

export interface TreeChange {
  /** Relative to the worktree, `/`-separated. */
  rel: string
  status: 'A' | 'M' | 'D'
  added: number
  removed: number
  binary: boolean
}

/** `diff-tree -z` with --name-status and --numstat merged. [pure] */
export function parseDiffTree(nameStatus: string, numstat: string): TreeChange[] {
  const out = new Map<string, TreeChange>()
  const ns = nameStatus.split('\0')
  for (let i = 0; i + 1 < ns.length; i += 2) {
    const status = ns[i]!.charAt(0)
    const rel = ns[i + 1]!
    if (!rel) continue
    // A type change (T) counts as an edit; anything else unusual is skipped.
    const s = status === 'A' || status === 'D' ? status : status === 'M' || status === 'T' ? 'M' : null
    if (s) out.set(rel, { rel, status: s, added: 0, removed: 0, binary: false })
  }
  // --numstat -z: "added\tremoved\tpath\0" per file.
  for (const rec of numstat.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec.replace(/^\n/, ''))
    if (!m) continue
    const hit = out.get(m[3]!)
    if (!hit) continue
    hit.binary = m[1] === '-'
    hit.added = m[1] === '-' ? 0 : Number(m[1])
    hit.removed = m[2] === '-' ? 0 : Number(m[2])
  }
  return [...out.values()]
}

/** Every file created, edited or deleted between two snapshots. */
export async function diffTrees(gitDir: string, workTree: string, from: string, to: string): Promise<TreeChange[] | null> {
  if (from === to) return []
  const [ns, num] = await Promise.all([
    runGit(gitDir, workTree, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to]),
    runGit(gitDir, workTree, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', from, to]),
  ])
  if (!ns.ok || !num.ok) return null
  return parseDiffTree(ns.stdout.toString('utf8'), num.stdout.toString('utf8'))
}

/** A file's content in a snapshot, or null when it is not there. */
export async function blobAt(gitDir: string, workTree: string, tree: string, rel: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{40,64}$/.test(tree) || rel.startsWith('-')) return null
  const r = await runGit(gitDir, workTree, ['cat-file', 'blob', `${tree}:${rel}`])
  return r.ok ? r.stdout : null
}
