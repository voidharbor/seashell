import { app, ipcMain, shell } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  CH,
  type AppPaths,
  type Project,
  type FsProbeResponse,
  type OpenPathResponse,
} from '../shared/ipc.js'
import type { PtyManager } from './pty/manager.js'
import { readDir } from './fs/tree.js'
import { readTextFile } from './fs/read.js'
import { statBatch } from './fs/stat-batch.js'
import { decideRoute, VIEWER_MAX_BYTES } from './fs/route.js'
import { denyOpenPath, extOf } from './fs/path-guard.js'
import {
  MAX_NAME_LENGTH,
  MAX_PROJECTS,
  loadProjects,
  saveProjects,
  upsertProject,
} from './state/store.js'

const TERMINAL_FONT =
  '/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts/SFMono-Terminal.ttf'

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
const ProbeReq = z.object({ path: AbsPath })
const ReadTextReq = z.object({
  path: AbsPath,
  maxBytes: z.number().int().min(1).max(64 * 1024 * 1024),
})
const OpenReq = z.object({ path: AbsPath })

/**
 * A project arrives from the renderer, so its shape is validated here like any
 * other inbound payload. The layout tree is accepted as opaque — the renderer
 * re-validates and remaps it on restore, and duplicating that structural walk in
 * two places is how the two copies drift apart.
 */
const ProjectSaveReq = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  tabs: z.array(z.unknown()).min(1).max(64),
})
const HttpReq = z.object({ url: z.string().max(4096) })

/** Extension -> mime, for the image preview. Fixed table; never sniffed. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  // SVG is deliberately absent. It is a script-bearing document, not a picture;
  // previewing one as an image would be handing an untrusted file a rendering
  // context. SVGs fall through to the text path and are shown as source.
}

/** Base64 inflates by 4/3 and the payload crosses IPC as a string, so this
 *  ceiling is about renderer memory, not disk. */
const IMAGE_MAX_BYTES = 16 * 1024 * 1024

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
      const st = await fs.lstat(abs)
      const isDir = st.isDirectory()
      const ext = extOf(path.basename(abs))
      const execBit = (st.mode & 0o111) !== 0 && st.isFile()
      const route = decideRoute({
        resolvedPath: abs,
        isDir,
        size: st.size,
        isExecutable: execBit,
      })
      return { exists: true, isDir, size: st.size, ext, route }
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
    try {
      const st = await fs.lstat(abs)
      const execBit = (st.mode & 0o111) !== 0 && st.isFile()
      if (denyOpenPath({ resolvedPath: abs, isExecutable: execBit, isDir: st.isDirectory() })) {
        shell.showItemInFolder(abs)
        return { ok: false, error: 'refused-executable' }
      }
    } catch {
      return { ok: false, error: 'not found' }
    }
    // openPath goes through NSWorkspace with the path as a single argument.
    // No shell is involved, so a filename containing `;` or `$(...)` is inert.
    const err = await shell.openPath(abs)
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

  ipcMain.handle(CH.appGetPaths, (): AppPaths => {
    return {
      home: os.homedir(),
      userData: app.getPath('userData'),
      defaultShell: '/bin/zsh',
      cwdOfLaunch: os.homedir(),
    }
  })

  ipcMain.handle(CH.appGetTerminalFont, async (): Promise<ArrayBuffer | null> => {
    try {
      const buf = await fs.readFile(TERMINAL_FONT)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    } catch {
      // Falls back to Menlo at a larger size; the app still works.
      return null
    }
  })
}
