/**
 * The ONLY file in the repo permitted to import ipcRenderer.
 *
 * Everything the renderer can do is enumerated here. Note what is deliberately
 * absent: no `fs`, no `path`, no `child_process`, no `process.env`, no generic
 * `invoke(channel, ...)`, and no write/delete/rename/mkdir of any kind. A
 * renderer compromise gets exactly this surface and nothing more.
 *
 * No function here takes a channel name as an argument. That is the property
 * that makes the surface enumerable.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CH,
  type AppPaths,
  type FsProbeRequest,
  type FsProbeResponse,
  type FsReadDirRequest,
  type FsReadDirResponse,
  type FsReadTextFileRequest,
  type FsReadTextFileResponse,
  type FsStatBatchRequest,
  type FsStatBatchResponse,
  type MetricsTickEvent,
  type OpenExternalHttpRequest,
  type OpenPathRequest,
  type OpenPathResponse,
  type PtyDataEvent,
  type PtyExitEvent,
  type PtyKillRequest,
  type PtyKillResponse,
  type PtyResizeRequest,
  type PtySpawnRequest,
  type PtySpawnResponse,
  type PtyWriteRequest,
  type SeashellApi,
  type UiCommandEvent,
} from '../shared/ipc.js'

/**
 * Wraps an event subscription so the renderer gets an unsubscribe function and
 * never sees the raw IpcRendererEvent (which carries a `sender` handle).
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: SeashellApi = {
  pty: {
    spawn: (req: PtySpawnRequest): Promise<PtySpawnResponse> =>
      ipcRenderer.invoke(CH.ptySpawn, req),
    kill: (req: PtyKillRequest): Promise<PtyKillResponse> => ipcRenderer.invoke(CH.ptyKill, req),
    write: (req: PtyWriteRequest): void => ipcRenderer.send(CH.ptyWrite, req),
    resize: (req: PtyResizeRequest): void => ipcRenderer.send(CH.ptyResize, req),
    onData: (cb: (e: PtyDataEvent) => void) => subscribe<PtyDataEvent>(CH.ptyData, cb),
    onExit: (cb: (e: PtyExitEvent) => void) => subscribe<PtyExitEvent>(CH.ptyExit, cb),
  },
  fs: {
    readDir: (req: FsReadDirRequest): Promise<FsReadDirResponse> =>
      ipcRenderer.invoke(CH.fsReadDir, req),
    statBatch: (req: FsStatBatchRequest): Promise<FsStatBatchResponse> =>
      ipcRenderer.invoke(CH.fsStatBatch, req),
    probe: (req: FsProbeRequest): Promise<FsProbeResponse> => ipcRenderer.invoke(CH.fsProbe, req),
    readTextFile: (req: FsReadTextFileRequest): Promise<FsReadTextFileResponse> =>
      ipcRenderer.invoke(CH.fsReadTextFile, req),
  },
  open: {
    withDefaultApp: (req: OpenPathRequest): Promise<OpenPathResponse> =>
      ipcRenderer.invoke(CH.openWithDefaultApp, req),
    revealInFinder: (req: OpenPathRequest): Promise<OpenPathResponse> =>
      ipcRenderer.invoke(CH.openRevealInFinder, req),
    externalHttp: (req: OpenExternalHttpRequest): Promise<OpenPathResponse> =>
      ipcRenderer.invoke(CH.openExternalHttp, req),
  },
  metrics: {
    onTick: (cb: (e: MetricsTickEvent) => void) => subscribe<MetricsTickEvent>(CH.metricsTick, cb),
  },
  app: {
    getPaths: (): Promise<AppPaths> => ipcRenderer.invoke(CH.appGetPaths),
    getTerminalFont: (): Promise<ArrayBuffer | null> =>
      ipcRenderer.invoke(CH.appGetTerminalFont),
    onCommand: (cb: (e: UiCommandEvent) => void) => subscribe<UiCommandEvent>(CH.uiCommand, cb),
  },
}

contextBridge.exposeInMainWorld('seashell', Object.freeze(api))
