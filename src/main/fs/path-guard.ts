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
 * [pure]: imports only 'node:path' and the pure shared path translator.
 */

import path from 'node:path'
import { windowsToLinux } from '../../shared/wsl-path.js'

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
  // Windows programs and launchers. Under WSL a Windows drive is mounted with
  // every file reporting the exec bit, and binfmt interop can run these, so
  // they are denied by type rather than trusted to a mode bit.
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.ps1',
  '.vbs',
  '.vbe',
  '.hta',
  '.wsf',
  '.scr',
  '.lnk',
  '.reg',
  '.cpl',
  '.msc',
  '.pif',
  // More things ShellExecute runs, installs or mounts as code rather than
  // opening as a document.
  '.jse',
  '.wsc',
  '.wsh',
  '.sct',
  '.shb',
  '.shs',
  '.scf',
  '.msp',
  '.mst',
  '.appref-ms',
  '.application',
  '.gadget',
  '.settingcontent-ms',
  '.psm1',
  '.psd1',
  '.ps1xml',
  '.diagcab',
  '.appx',
  '.appxbundle',
  '.msix',
  '.msixbundle',
  '.xbap',
  '.xll',
  '.jnlp',
  '.chm',
  '.website',
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
  // Everyday data formats. On a WSL Windows drive every file carries the exec
  // bit, so without these an ordinary .doc or .webp was refused as executable.
  '.doc',
  '.xls',
  '.ppt',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.webp',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff',
  '.wav',
  '.flac',
  '.ogg',
  '.aac',
  '.mkv',
  '.webm',
  '.avi',
  '.7z',
  '.rar',
  '.eml',
  '.msg',
  '.dwg',
])

/**
 * Windows-only additions for `shell.openPath`, kept out of DENY_EXTENSIONS
 * because they are also everyday source files the in-app viewer shows on
 * every platform. On Windows the default handler for these is Windows Script
 * Host, so "open in default app" on one runs it.
 */
export const WIN32_SHELL_DENY_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.ws', '.vb'])

/**
 * The guard reasons about one path shape. The Windows build hands it either
 * form of the same file (`C:\x\setup.exe` or `/mnt/c/x/setup.exe`,
 * `\\wsl.localhost\<distro>\dev\sda` or `/dev/sda`), so a Windows-shaped
 * path is first put back into its Linux form; every rule below then sees the
 * same thing either way. Windows also drops trailing dots and spaces from a
 * name when it opens it, so `evil.exe.` and `evil.exe ` launch as `evil.exe`;
 * the extension is read the way Windows will read it.
 */
function guardPath(resolvedPath: string): { linux: string; ext: string; basename: string } {
  const linux = windowsToLinux(resolvedPath)
  const basename = path.posix.basename(linux)
  return { linux, ext: extOf(basename.replace(/[. ]+$/, '')), basename }
}

/** The Windows-only half of the open guard, for the win32 open handler: true
 *  when the default app for this type is a script host. */
export function denyShellOpenOnWindows(resolvedPath: string): boolean {
  return WIN32_SHELL_DENY_EXTENSIONS.has(guardPath(resolvedPath).ext)
}

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
  const { linux, ext, basename } = guardPath(input.resolvedPath)
  if (isUnderDev(linux)) return true

  if (DENY_EXTENSIONS.has(ext)) return true
  // A name that ends in a dot or a space is opened by Windows under a
  // different name than the one shown; there is no honest answer for it.
  if (/[. ]$/.test(basename)) return true

  if (input.isExecutable) {
    const knownSafe = VIEWER_EXTENSIONS.has(ext) || VIEWER_BASENAMES.has(basename) || DOCUMENT_EXTENSIONS.has(ext)
    if (!knownSafe) return true
  }

  return false
}
