/**
 * SECURITY CRITICAL — the DENY rules for `shell.openPath` (spec §8.6, §13.2).
 *
 * `shell.openPath` hands its argument to LaunchServices, which *executes*
 * `.app` / `.command` / `.jar` / `.pkg` / `.dmg` / `.scpt` / `.webloc` /
 * `.terminal` bundles and any file with the execute bit set. Terminal output
 * is attacker-influenced — a git branch name, a log line from a remote
 * service, a filename in a cloned repo — so a hostile repo containing
 * `pwn.command` that gets printed and double-clicked must never reach
 * `shell.openPath`. This module decides that boundary; route.ts and the
 * (non-pure) open handler both defer to it rather than re-deriving it.
 *
 * [pure] — imports only 'node:path', explicitly permitted.
 */

import path from 'node:path'

export type SpecialFileType = 'fifo' | 'socket' | 'char-device' | 'block-device'

export interface OpenGuardInput {
  /** `fs.promises.realpath()`'d absolute path — the basename and extension
   *  are derived from this, and it's also used for the `/dev` rule. Every
   *  path must be `realpath`ed before reaching this guard (spec §13.7). */
  resolvedPath: string
  /** True for a directory. `shell.openPath` on a directory opens it in
   *  Finder, which spec §8.6 forbids ("Directory -> File explorer, never
   *  Finder") — the normal path never reaches here because the renderer
   *  intercepts directories before ever calling the open IPC, but a
   *  security-critical guard must still refuse defensively rather than
   *  trust that upstream check. */
  isDir: boolean
  /** Whether the REALPATH-resolved target's POSIX mode has any execute bit
   *  set (`mode & 0o111`). Computed by the caller from `lstat`. */
  isExecutable: boolean
  /** Set when `lstat` identifies a FIFO/socket/device node; undefined for a
   *  plain regular file or directory. */
  specialType?: SpecialFileType
}

/** Case-insensitive extension including the leading dot, or '' when there is
 *  none. `path.extname` already looks only at the final path segment, so a
 *  full path or a bare basename both work. Exported so route.ts and callers
 *  derive extensions the same way this module does. */
export function extOf(name: string): string {
  return path.extname(name).toLowerCase()
}

/**
 * Bundles and script/app wrappers that LaunchServices will run outright,
 * regardless of the execute bit — `shell.openPath` on any of these is
 * itself the dangerous act. Matched case-insensitively.
 */
export const DENY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.app',
  '.command',
  '.workflow',
  '.scpt',
  '.scptd',
  '.terminal',
  '.webloc',
  '.url',
  '.inetloc',
  '.desktop',
  '.pkg',
  '.mpkg',
  '.dmg',
  '.jar',
  '.action',
  '.prefpane',
  '.qlgenerator',
  '.saver',
  '.plugin',
  '.bundle',
  '.osax',
  '.kext',
  '.appex',
])

/** The in-app viewer's extension list (spec §8.6 "Viewer" row). Shared with
 *  route.ts, and doubles here as the "known safe to run with +x" carve-out
 *  — a `.sh` script is routinely chmod +x and must not be force-revealed. */
export const VIEWER_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt',
  '.text',
  '.log',
  '.md',
  '.markdown',
  '.mdx',
  '.rst',
  '.adoc',
  '.json',
  '.jsonc',
  '.json5',
  '.jsonl',
  '.ndjson',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.properties',
  '.xml',
  '.csv',
  '.tsv',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.py',
  '.pyi',
  '.rb',
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.hh',
  '.m',
  '.mm',
  '.swift',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.cs',
  '.php',
  '.pl',
  '.lua',
  '.r',
  '.jl',
  '.dart',
  '.zig',
  '.nim',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.clj',
  '.cljs',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.vim',
  '.el',
  '.gradle',
  '.cmake',
  '.mk',
  '.bzl',
  '.tf',
  '.tfvars',
  '.hcl',
  '.patch',
  '.diff',
  '.lock',
])

/** Extensionless basenames and dotfiles the viewer opens (spec §8.6). Node's
 *  `path.extname` returns '' for a leading-dot-only name like `.gitignore`,
 *  so these are matched by exact basename, not extension. Case-sensitive,
 *  matching the spec's literal casing (`Makefile`, `README`, ...). */
export const VIEWER_BASENAMES: ReadonlySet<string> = new Set([
  'Makefile',
  'Dockerfile',
  'Justfile',
  'Rakefile',
  'Gemfile',
  'Brewfile',
  'Procfile',
  'LICENSE',
  'README',
  'CHANGELOG',
  'NOTICE',
  'AUTHORS',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
  '.zshrc',
  '.bashrc',
  '.profile',
])

/** The explicit subset of "default app" document extensions the spec names
 *  (§8.6's table row is itself non-exhaustive, "…"). Used only as the other
 *  half of the exec-bit carve-out below — an image or office document with
 *  the execute bit set is still safe to hand to its default app. Extensions
 *  outside both this set and VIEWER_EXTENSIONS are treated conservatively:
 *  exec bit + unrecognized extension is denied, per this module's mandate
 *  to err toward safety rather than convenience. */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.xlsx',
  '.docx',
  '.pptx',
  '.pages',
  '.numbers',
  '.key',
  '.png',
  '.jpg',
  '.jpeg',
  '.heic',
  '.gif',
  '.svg',
  '.mp4',
  '.mov',
  '.m4a',
  '.mp3',
  '.zip',
  '.tar',
  '.gz',
])

/** True when `resolvedPath` is `/dev` or lives under it — device nodes that
 *  happen to carry a misleading extension must still never be opened. */
export function isUnderDev(resolvedPath: string): boolean {
  return resolvedPath === '/dev' || resolvedPath.startsWith('/dev/')
}

/**
 * The DENY decision: true means "never `shell.openPath` this — reveal in
 * Finder instead" (spec §8.6's DENY row, §13.2). Deliberately conservative:
 * an execute-bit file with an extension this module doesn't recognize as
 * safe is denied even though the spec's document list is non-exhaustive,
 * because the cost of a false deny (an extra click through Finder) is far
 * lower than the cost of a false allow (arbitrary code execution).
 */
export function denyOpenPath(input: OpenGuardInput): boolean {
  if (input.isDir) return true
  if (input.specialType !== undefined) return true
  if (isUnderDev(input.resolvedPath)) return true

  const ext = extOf(input.resolvedPath)
  if (DENY_EXTENSIONS.has(ext)) return true

  if (input.isExecutable) {
    const basename = path.basename(input.resolvedPath)
    const knownSafe = VIEWER_EXTENSIONS.has(ext) || VIEWER_BASENAMES.has(basename) || DOCUMENT_EXTENSIONS.has(ext)
    if (!knownSafe) return true
  }

  return false
}
