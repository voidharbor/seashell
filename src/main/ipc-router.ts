import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  CH,
  type AppPaths,
  type Project,
  type SavedTab,
  type FsProbeResponse,
  type OpenPathResponse,
  type LinksEnsureResponse,
} from '../shared/ipc.js'
import type { PtyManager } from './pty/manager.js'
import { readDir } from './fs/tree.js'
import { readTextFile } from './fs/read.js'
import { writeTextFile } from './fs/write.js'
import { statBatch } from './fs/stat-batch.js'
import { findBySuffix } from './fs/find-suffix.js'
import { decideRoute, VIEWER_MAX_BYTES } from './fs/route.js'
import { denyOpenPath, extOf } from './fs/path-guard.js'
import { statForOpen, type OpenTarget } from './fs/open-target.js'
import { ensureNotes } from './links/notes.js'
import { platform } from './platform/index.js'
import {
  MAX_NAME_LENGTH,
  MAX_PROJECTS,
  loadProjects,
  saveProjects,
  upsertProject,
} from './state/store.js'
import { clearLastSession, loadLastSession, saveLastSession } from './state/last-session.js'
import { sessionIdsForPanes } from './state/session-lookup.js'
import { resumeModesForPanes } from './state/resume-mode.js'

/**
 * Every inbound payload is validated here, at the single registration point.
 * Handlers return typed error envelopes rather than throwing, so a malformed
 * message from a compromised renderer cannot crash main.
 */
const PaneId = z.string().min(1).max(128)
const AbsPath = z.string().min(1).max(4096)

const SpawnReq = z.object({
  paneId: PaneId,
  file: z.string().min(1),
  args: z.array(z.string()).max(64),
  cwd: AbsPath,
  cols: z.number().int().min(1).max(2000),
  rows: z.number().int().min(1).max(500),
})

const WriteReq = z.object({ paneId: PaneId, data: z.string().max(1024 * 1024) })
const ResizeReq = z.object({
  paneId: PaneId,
  cols: z.number().int().min(1).max(2000),
  rows: z.number().int().min(1).max(500),
})
const KillReq = z.object({ paneId: PaneId })
const ReadDirReq = z.object({ path: AbsPath, respectGitignore: z.boolean() })
const StatBatchReq = z.object({
  cwd: AbsPath,
  candidates: z.array(z.string().max(4096)).max(512),
})
const FindSuffixReq = z.object({
  root: AbsPath,
  // Segment-anchored by contract, and the walk only ever compares it with
  // endsWith, so a suffix that does not start with '/' is refused rather than
  // quietly matched against the middle of a name.
  suffix: z.string().min(2).max(512).regex(/^\//),
  limit: z.number().int().min(1).max(50),
})
const ProbeReq = z.object({ path: AbsPath })
const ReadTextReq = z.object({
  path: AbsPath,
  maxBytes: z.number().int().min(1).max(64 * 1024 * 1024),
})
const WriteTextReq = z.object({
  path: AbsPath,
  text: z.string().max(8 * 1024 * 1024),
  expectedMtimeMs: z.number(),
})
const OpenReq = z.object({ path: AbsPath })
const LinkReq = z.object({ linkId: z.string().min(1).max(64) })

/**
 * A project arrives from the renderer, so its shape is validated here like any
 * other inbound payload. The layout tree is accepted as opaque — the renderer
 * re-validates and remaps it on restore, and duplicating that structural walk in
 * two places is how the two copies drift apart.
 */
const SavedTabs = z.array(z.unknown()).min(1).max(64)

const ProjectSaveReq = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  tabs: SavedTabs,
})

/** The last-session snapshot is a project without a name, so its tabs are held
 *  to exactly the same rule rather than a second, drifting copy of one. */
const SessionSaveReq = z.object({ tabs: SavedTabs })
const HttpReq = z.object({ url: z.string().max(4096) })

/** Extension -> mime, for the image preview. Fixed table; never sniffed. */
// Keys are dot-prefixed because the lookup uses extOf(), which returns
// path.extname() verbatim. They were dotless once, which made every lookup
// miss and readImageFile refuse every image — invisible until the router
// started sending images here at all.
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // SVG is deliberately absent. It is a script-bearing document, not a picture;
  // previewing one as an image would be handing an untrusted file a rendering
  // context. SVGs fall through to the text path and are shown as source.
}

/** Base64 inflates by 4/3 and the payload crosses IPC as a string, so this
 *  ceiling is about renderer memory, not disk. */
const IMAGE_MAX_BYTES = 16 * 1024 * 1024

/**
 * The one thing quit waits on before it starts reaping.
 *
 * Only the renderer knows the current layout, so main cannot write the
 * last-session file itself; it has to ask and then wait. The slot below is the
 * resolver for that wait, and it is deliberately a single slot: there is one
 * window and one quit, and a queue of pending snapshot requests would only ever
 * describe a bug.
 */
let pendingSnapshot: (() => void) | null = null

/**
 * Asks the renderer for a snapshot and resolves when it answers, or when
 * `timeoutMs` passes, whichever comes first. The timeout is the load-bearing
 * half: a renderer that is wedged, crashed or mid-reload must never be able to
 * make the app unquittable.
 */
export function awaitSnapshot(win: BrowserWindow, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      if (pendingSnapshot === finish) pendingSnapshot = null
      if (timer) clearTimeout(timer)
      resolve()
    }

    pendingSnapshot = finish
    timer = setTimeout(finish, timeoutMs)

    try {
      if (win.isDestroyed()) finish()
      else win.webContents.send(CH.sessionRequestSnapshot)
    } catch {
      finish() // nobody to ask; quit proceeds
    }
  })
}

export function registerIpc(ptyManager: PtyManager): void {
  ipcMain.handle(CH.ptySpawn, (_e, raw) => {
    const parsed = SpawnReq.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, code: 'ENOENT', message: 'invalid spawn request' }
    }
    return ptyManager.spawn(parsed.data)
  })

  ipcMain.on(CH.ptyWrite, (_e, raw) => {
    const parsed = WriteReq.safeParse(raw)
    if (parsed.success) ptyManager.write(parsed.data.paneId, parsed.data.data)
  })

  ipcMain.on(CH.ptyResize, (_e, raw) => {
    const parsed = ResizeReq.safeParse(raw)
    if (parsed.success) ptyManager.resize(parsed.data.paneId, parsed.data.cols, parsed.data.rows)
  })

  ipcMain.handle(CH.ptyKill, async (_e, raw) => {
    const parsed = KillReq.safeParse(raw)
    if (!parsed.success) return { ok: false, survivors: 0 }
    return ptyManager.kill(parsed.data.paneId)
  })

  ipcMain.handle(CH.fsReadDir, async (_e, raw) => {
    const parsed = ReadDirReq.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, code: 'ENOENT', message: 'invalid readDir request' }
    }
    return readDir(parsed.data)
  })

  ipcMain.handle(CH.fsStatBatch, async (_e, raw) => {
    const parsed = StatBatchReq.safeParse(raw)
    if (!parsed.success) return { results: [] }
    return statBatch(parsed.data)
  })

  ipcMain.handle(CH.fsFindBySuffix, async (_e, raw) => {
    const parsed = FindSuffixReq.safeParse(raw)
    if (!parsed.success) return { paths: [], truncated: false }
    return findBySuffix(parsed.data)
  })

  ipcMain.handle(CH.fsProbe, async (_e, raw): Promise<FsProbeResponse> => {
    const parsed = ProbeReq.safeParse(raw)
    const miss: FsProbeResponse = {
      exists: false,
      isDir: false,
      size: 0,
      ext: '',
      route: 'reveal',
    }
    if (!parsed.success) return miss

    // The renderer is never an authority on paths: resolve and stat here.
    const abs = path.resolve(parsed.data.path)
    try {
      // Routed on the target for the same reason the open handler guards it —
      // decideRoute calls denyOpenPath, whose whole contract is that it is
      // handed a realpath. `ext` stays the name the user sees in the tree;
      // only the safety decision follows the link. `size` follows it too, so
      // the viewer's size ceiling is measured against the bytes it would
      // actually read.
      const target = await statForOpen(abs)
      const ext = extOf(path.basename(abs))
      const route = decideRoute({
        resolvedPath: target.real,
        isDir: target.isDir,
        size: target.size,
        isExecutable: target.isExecutable,
      })
      return { exists: true, isDir: target.isDir, size: target.size, ext, route }
    } catch {
      return miss
    }
  })

  ipcMain.handle(CH.fsReadTextFile, async (_e, raw) => {
    const parsed = ReadTextReq.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, code: 'ENOENT', message: 'invalid read request' }
    }
    return readTextFile({
      path: parsed.data.path,
      maxBytes: Math.min(parsed.data.maxBytes, VIEWER_MAX_BYTES),
    })
  })

  /** The editable preview's save. Scoped to the home directory — the same
   *  root the explorer shows — with every other guard in fs/write.ts. */
  ipcMain.handle(CH.fsWriteTextFile, async (_e, raw) => {
    const parsed = WriteTextReq.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, code: 'ENOENT', message: 'invalid write request' }
    }
    return writeTextFile(parsed.data, os.homedir())
  })

  /**
   * Images for the preview pane.
   *
   * The mime type comes from this fixed table keyed on extension — it is never
   * sniffed from the file and never derived from anything the file contains. A
   * mime string taken from untrusted bytes would be interpolated straight into
   * a `data:` URL, which is a content-type confusion bug waiting to happen. An
   * unrecognized extension is refused rather than guessed.
   */
  ipcMain.handle(CH.fsReadImageFile, async (_e, raw) => {
    const parsed = OpenReq.safeParse(raw)
    if (!parsed.success) return { ok: false, code: 'ENOENT', message: 'invalid path' }

    const abs = path.resolve(parsed.data.path)
    const mime = IMAGE_MIME[extOf(path.basename(abs))]
    if (!mime) {
      return { ok: false, code: 'EUNSUPPORTED', message: 'not a previewable image' }
    }

    try {
      const st = await fs.lstat(abs)
      if (!st.isFile()) return { ok: false, code: 'ENOENT', message: 'not a file' }
      if (st.size > IMAGE_MAX_BYTES) {
        return { ok: false, code: 'ETOOBIG', message: `image larger than ${IMAGE_MAX_BYTES} bytes` }
      }
      const buf = await fs.readFile(abs)
      return { ok: true, base64: buf.toString('base64'), mime, size: st.size }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code === 'EACCES' ? 'EACCES' : 'ENOENT'
      return { ok: false, code, message: 'could not read image' }
    }
  })

  /**
   * shell.openPath EXECUTES .app/.command/.pkg bundles and anything with the
   * execute bit, via LaunchServices. Terminal output is attacker-influenced —
   * a filename in a cloned repo, a branch name in a log line. So a guarded
   * refusal is not paranoia, it is the difference between "opens a document"
   * and "runs a stranger's script".
   */
  ipcMain.handle(CH.openWithDefaultApp, async (_e, raw): Promise<OpenPathResponse> => {
    const parsed = OpenReq.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'invalid path' }
    const abs = path.resolve(parsed.data.path)
    let target: OpenTarget
    try {
      // Guard the target, not the link — see statForOpen. LaunchServices
      // follows the link either way, so anything less was inspecting one file
      // and opening another.
      target = await statForOpen(abs)
      if (
        denyOpenPath({
          resolvedPath: target.real,
          isExecutable: target.isExecutable,
          isDir: target.isDir,
        })
      ) {
        // Reveal the path the user actually clicked, not its target: that is
        // the row they can see.
        shell.showItemInFolder(abs)
        return { ok: false, error: 'refused-executable' }
      }
    } catch {
      return { ok: false, error: 'not found' }
    }
    // openPath goes through NSWorkspace with the path as a single argument.
    // No shell is involved, so a filename containing `;` or `$(...)` is inert.
    const err = await shell.openPath(target.real)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle(CH.openRevealInFinder, async (_e, raw): Promise<OpenPathResponse> => {
    const parsed = OpenReq.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'invalid path' }
    shell.showItemInFolder(path.resolve(parsed.data.path))
    return { ok: true }
  })

  ipcMain.handle(CH.openExternalHttp, async (_e, raw): Promise<OpenPathResponse> => {
    const parsed = HttpReq.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'invalid url' }
    // Scheme allowlist, not a blocklist. file:, javascript: and custom schemes
    // are all rejected by omission.
    if (!/^https?:\/\//i.test(parsed.data.url)) return { ok: false, error: 'scheme not allowed' }
    await shell.openExternal(parsed.data.url)
    return { ok: true }
  })

  // ------------------------------------------------------------- projects
  ipcMain.handle(CH.projectsList, async () => ({ projects: await loadProjects() }))

  ipcMain.handle(CH.projectsSessionIds, async (_e, raw) => {
    const parsed = z
      .object({
        panes: z.array(z.object({ paneId: PaneId, cwd: z.string().max(4096) })).max(64),
      })
      .safeParse(raw)
    if (!parsed.success) return { ids: {} }
    return { ids: await sessionIdsForPanes(parsed.data.panes) }
  })

  ipcMain.handle(CH.projectsResumeModes, async (_e, raw) => {
    const parsed = z
      .object({
        panes: z
          .array(
            z.object({
              paneId: PaneId,
              cwd: z.string().max(4096),
              sid: z
                .string()
                .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
            })
          )
          .max(64),
      })
      .safeParse(raw)
    if (!parsed.success) return { modes: {} }
    return { modes: await resumeModesForPanes(parsed.data.panes) }
  })

  /**
   * The shared notes file for a link group.
   *
   * Idempotent, and never destructive: a second pane joining an existing link
   * gets the same path and the notes already in it. The renderer supplies only
   * an id, and `notesPathFor` refuses anything that is not a plain id, so a
   * path can never be composed from the other side of the boundary.
   */
  ipcMain.handle(CH.linksEnsure, async (_e, raw): Promise<LinksEnsureResponse> => {
    const parsed = LinkReq.safeParse(raw)
    if (!parsed.success) return { path: null }
    return { path: await ensureNotes(parsed.data.linkId) }
  })

  ipcMain.handle(CH.projectsSave, async (_e, raw) => {
    const parsed = ProjectSaveReq.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, code: 'EINVALID', message: 'invalid project' }
    }

    const existing = await loadProjects()
    const isNew = !existing.some(
      (p) => p.id === parsed.data.id || p.name.toLowerCase() === parsed.data.name.toLowerCase()
    )
    if (isNew && existing.length >= MAX_PROJECTS) {
      return { ok: false, code: 'ELIMIT', message: `at most ${MAX_PROJECTS} projects` }
    }

    const project = {
      id: parsed.data.id ?? `proj-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      name: parsed.data.name.trim(),
      savedAt: new Date().toISOString(),
      tabs: parsed.data.tabs as unknown as Project['tabs'],
    }

    try {
      await saveProjects(upsertProject(existing, project))
    } catch {
      return { ok: false, code: 'EWRITE', message: 'could not write projects file' }
    }
    return { ok: true, project }
  })

  ipcMain.handle(CH.projectsDelete, async (_e, raw) => {
    const parsed = z.object({ id: z.string().min(1).max(128) }).safeParse(raw)
    if (!parsed.success) return { ok: false }
    const existing = await loadProjects()
    try {
      await saveProjects(existing.filter((p) => p.id !== parsed.data.id))
    } catch {
      return { ok: false }
    }
    return { ok: true }
  })

  // ------------------------------------------------------- last session
  /**
   * A failed snapshot write is never reported to the renderer. This runs on the
   * quit path, and there is no useful thing a user can do about a full disk in
   * the half-second before the window closes; losing the offer to restore is
   * strictly better than delaying or blocking the quit to say so.
   */
  ipcMain.handle(CH.sessionSave, async (_e, raw) => {
    const parsed = SessionSaveReq.safeParse(raw)
    if (parsed.success) {
      try {
        await saveLastSession(parsed.data.tabs as SavedTab[], app.getPath('userData'))
      } catch {
        /* the snapshot is a nicety; quit must not hang on it */
      }
    }
    pendingSnapshot?.()
  })

  ipcMain.handle(CH.sessionLoad, () => loadLastSession(app.getPath('userData')))

  ipcMain.handle(CH.sessionClear, async () => {
    try {
      await clearLastSession(app.getPath('userData'))
    } catch {
      /* an unremovable snapshot is re-validated on load anyway */
    }
    // A clear is as much an answer to a snapshot request as a save is: the
    // renderer looked and decided there was nothing worth keeping. Waiting out
    // the full timeout for that would put a visible pause on every quit of a
    // window holding one plain shell.
    pendingSnapshot?.()
  })

  ipcMain.handle(CH.appGetPaths, (): AppPaths => {
    return {
      home: os.homedir(),
      hostname: os.hostname(),
      userData: app.getPath('userData'),
      defaultShell: platform.loginShell().file,
      cwdOfLaunch: os.homedir(),
    }
  })

  ipcMain.handle(CH.appGetTerminalFont, async (): Promise<ArrayBuffer | null> => {
    const font = platform.terminalFontPath()
    if (!font) return null
    try {
      const buf = await fs.readFile(font)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    } catch {
      // Falls back to Menlo at a larger size; the app still works.
      return null
    }
  })
}
