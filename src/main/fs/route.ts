/**
 * File-type routing for double-click-opened paths (spec §8.6).
 *
 * Routing is decided in main (here), never in the renderer — the renderer's
 * stat cache is an optimization, never an authority (spec §13.7). This
 * module does the *decision*; the one stat/lstat/sniff-read that supplies
 * its input is done by the (non-pure) fs layer that calls it.
 *
 * [pure] — imports only 'node:path' (via path-guard.ts) and the shared
 * OpenRoute type. No 'fs': the caller passes in whatever it already read.
 */

import type { OpenRoute } from '../../shared/ipc.js'
import { denyOpenPath, extOf, VIEWER_BASENAMES, VIEWER_EXTENSIONS, type SpecialFileType } from './path-guard.js'
import path from 'node:path'

/**
 * Hard refuse boundary for the in-app viewer (spec §9: "size > 8 MiB" ->
 * Refuse, offer Open in default app / Reveal in Finder). Exported so the
 * (non-pure) fs layer can skip reading/sniffing bytes for files already
 * known to be over this size.
 */
export const VIEWER_MAX_BYTES = 8 * 1024 * 1024

/** Image extensions the in-pane preview renders. Must stay in step with
 *  IMAGE_MIME (ipc-router.ts) and IMAGE_EXTS (FilePreview.tsx). */
// Dot-prefixed to match extOf(), which returns path.extname() verbatim.
export const VIEWER_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'])

/** Matches IMAGE_MAX_BYTES in ipc-router.ts — past it the read would be
 *  refused anyway, so the router hands the file to the OS up front. */
export const VIEWER_IMAGE_MAX_BYTES = 16 * 1024 * 1024

/** Result of sniffing an extensionless file's first 8192 bytes (spec §8.6). */
export type SniffResult = 'binary' | 'text'

export interface RouteInput {
  /** `fs.promises.realpath()`'d absolute path — basename/extension are
   *  derived from this the same way path-guard.ts derives them. */
  resolvedPath: string
  /** True for a directory. See the doc comment on the `isDir` branch below
   *  for why `decideRoute` still accepts it instead of requiring callers
   *  to never call this for one. */
  isDir: boolean
  size: number
  /** Whether the REALPATH-resolved target's POSIX mode has any execute bit set. */
  isExecutable: boolean
  specialType?: SpecialFileType
  /**
   * Sniff result for an extensionless file. Only consulted when the file
   * has no extension and isn't one of the known extensionless viewer
   * basenames; ignored otherwise. Undefined means "not sniffed" (e.g. the
   * caller short-circuited because size already exceeded VIEWER_MAX_BYTES,
   * or sniffing simply hasn't run yet).
   */
  sniff?: SniffResult
}

/**
 * Picks the OpenRoute for a path. `OpenRoute` (shared/ipc.ts) has no
 * directory member by design: `FsProbeResponse` carries `isDir` as its own
 * field precisely so the renderer short-circuits to the file-explorer
 * behavior (spec §8.6's Directory row — "File explorer, never Finder")
 * without ever consulting `OpenRoute` for a directory. `isDir` is still
 * accepted and checked here, defensively, so a caller that (by bug or by a
 * code path this module doesn't control) invokes this for a directory gets
 * `'reveal'` — refused, not silently handed to `shell.openPath`, which would
 * open a Finder window on it and violate "never Finder".
 */
export function decideRoute(input: RouteInput): OpenRoute {
  if (
    denyOpenPath({
      resolvedPath: input.resolvedPath,
      isDir: input.isDir,
      isExecutable: input.isExecutable,
      specialType: input.specialType,
    })
  ) {
    return 'reveal'
  }

  const ext = extOf(input.resolvedPath)

  if (ext === '') {
    if (VIEWER_BASENAMES.has(path.basename(input.resolvedPath))) {
      return input.size > VIEWER_MAX_BYTES ? 'too-large' : 'viewer'
    }
    // Extensionless sniff (spec §8.6): binary magic numbers, any 0x00 byte,
    // or >30% non-printable-and-not-valid-UTF-8 all sniff 'binary'; anything
    // else sniffs 'text'. Not sniffed at all (sniff undefined) also falls
    // through to 'binary' per the spec's default: "extensionless files are
    // 'binary' unless sniffed as text."
    if (input.sniff === 'text') {
      return input.size > VIEWER_MAX_BYTES ? 'too-large' : 'viewer'
    }
    return 'binary'
  }

  if (VIEWER_EXTENSIONS.has(ext)) {
    return input.size > VIEWER_MAX_BYTES ? 'too-large' : 'viewer'
  }

  // Images preview in-pane: the preview already renders them (readImageFile,
  // fixed mime table) and opening Preview.app for a glance at a screenshot was
  // the single most jarring hand-off in the app. The right-click menu is the
  // explicit way out to the default app. Oversized ones still go to the OS —
  // the ceiling matches IMAGE_MAX_BYTES in ipc-router.ts, and the extension
  // list must stay in step with IMAGE_MIME there and IMAGE_EXTS in
  // FilePreview.tsx. SVG stays out on purpose: script-bearing document, shown
  // as source instead.
  if (VIEWER_IMAGE_EXTENSIONS.has(ext)) {
    return input.size > VIEWER_IMAGE_MAX_BYTES ? 'os' : 'viewer'
  }

  // PDFs render in-pane through Chromium's own PDFium viewer — the same
  // sandboxed renderer Chrome uses, in a guest process. Josh produces PDFs
  // constantly (quotes, contracts), which is what promoted this from
  // "hand it to Preview.app" to a first-class preview. No size gate: PDFium
  // streams large documents better than the image path ever could.
  if (ext === '.pdf') return 'viewer'

  // Everything else: documents needing a heavy native app (pdf, xlsx, docx,
  // images, archives, ...) and anything unrecognized. No size guard here —
  // the guard is specific to the in-app viewer (spec §9); shell.openPath
  // hands large media/documents to an app built to handle them.
  return 'os'
}
