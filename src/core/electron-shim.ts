/**
 * The `electron` module as `src/main` sees it inside the core (spec 4.3 of the
 * redesign spec). One virtual window, ipcMain dispatch tables fed by the stdio
 * bridge, and every OS-facing call relayed to the shell as an `invoke`.
 */
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { CORE_PUSH_TO_SHELL, encodeEnvelope, type Envelope } from './protocol.js'

export interface ShimOptions {
  write: (line: string) => void // one envelope line to the shell
  hostPid: number // the shell's Windows pid
  userData: string // Linux path (drvfs) of the userData dir
  version: string
  onPush: (ch: string, p: unknown) => void // pushes NOT in CORE_PUSH_TO_SHELL go here (the controller)
  /** How `app.quit` and `app.exit` end the process. Defaults to `process.exit`. */
  exit?: (code: number) => void
}

export interface IpcEvent {
  sender: { send(ch: string, p: unknown): void }
}
type Handler = (event: IpcEvent, payload: never) => unknown

/** The `before-quit` / `will-quit` event; `preventDefault` stops the default exit. */
export interface QuitEvent {
  preventDefault(): void
  readonly defaultPrevented: boolean
}

export interface AppShim extends EventEmitter {
  readonly isPackaged: boolean
  getPath(name: string): string
  setPath(name: string, value: string): void
  getVersion(): string
  getName(): string
  whenReady(): Promise<void>
  isReady(): boolean
  requestSingleInstanceLock(): boolean
  setAppUserModelId(id: string): void
  quit(): void
  exit(code?: number): void
}

export interface MenuItemShim {
  label?: string
  accelerator?: string
  click?: (...args: unknown[]) => unknown
  submenu?: MenuShimInstance
  [key: string]: unknown
}
export interface MenuShimInstance {
  items: MenuItemShim[]
  popup(): void
}
export interface MenuShim {
  buildFromTemplate(template: ReadonlyArray<Record<string, unknown>>): MenuShimInstance
  setApplicationMenu(menu: MenuShimInstance | null): void
  getApplicationMenu(): MenuShimInstance | null
}

export interface IpcMainShim {
  handle(ch: string, fn: Handler): void
  removeHandler(ch: string): void
  on(ch: string, fn: Handler): void
  removeListener(ch: string, fn: Handler): void
  removeAllListeners(ch?: string): void
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface DisplayShim {
  id: number
  bounds: Rect
  workArea: Rect
  scaleFactor: number
}
export interface ScreenShim {
  getPrimaryDisplay(): DisplayShim
  getDisplayMatching(rect: Rect): DisplayShim
  getAllDisplays(): DisplayShim[]
  /** Asks the shell for `display:list` and refreshes the cache the sync getters read. */
  refresh(): Promise<DisplayShim[]>
}
export interface ShellShim {
  openPath(p: string): Promise<string>
  openExternal(url: string): Promise<void>
  showItemInFolder(p: string): void
}
export interface ClipboardShim {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
  readImage(): { isEmpty(): boolean; toPNG(): Buffer }
}
export interface DialogShim {
  showOpenDialog(...args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }>
}

/** The one virtual window `src/main` addresses. */
export interface WindowShim {
  webContents: { send(ch: string, p: unknown): void; isDestroyed(): boolean }
  isDestroyed(): boolean
  focus(): void
  getBounds(): Rect
  on(ev: string, fn: (...a: unknown[]) => void): WindowShim
  once(ev: string, fn: (...a: unknown[]) => void): WindowShim
  setTitle(t: string): void
  isMinimized(): boolean
  restore(): void
  show(): void
}

export declare class BrowserWindowShim {
  static getAllWindows(): WindowShim[]
  static getFocusedWindow(): WindowShim | null
}

export interface Shim {
  app: AppShim
  BrowserWindow: typeof BrowserWindowShim
  Menu: MenuShim
  ipcMain: IpcMainShim
  net: { fetch: typeof fetch }
  protocol: { handle(): void; registerSchemesAsPrivileged(): void }
  screen: ScreenShim
  shell: ShellShim
  clipboard: ClipboardShim
  dialog: DialogShim
  /** An envelope that arrived from the shell. */
  dispatch(e: Envelope): Promise<void>
  /** The controller calls main's ipc handlers in process, no pipe. */
  invokeLocal<T = unknown>(ch: string, p: unknown): Promise<T>
  sendLocal(ch: string, p: unknown): void
  /** The core's own invoke toward the shell (clip:write, display:list, ...). */
  invokeShell<T = unknown>(ch: string, p: unknown): Promise<T>
}

/** How long `app.quit` waits on before-quit / will-quit listeners before it exits anyway. */
const QUIT_CAP_MS = 10_000

const FALLBACK_DISPLAY: DisplayShim = {
  id: 0,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
}

function errorText(p: unknown, fallback: string): string {
  if (p && typeof p === 'object') {
    const r = p as Record<string, unknown>
    if (typeof r.message === 'string' && r.message) return r.message
    if (typeof r.code === 'string' && r.code) return r.code
  }
  return fallback
}

function isOk(p: unknown): boolean {
  return Boolean(p && typeof p === 'object' && (p as Record<string, unknown>).ok === true)
}

function toDisplays(p: unknown): DisplayShim[] {
  const list = Array.isArray(p) ? p : p && typeof p === 'object' ? (p as Record<string, unknown>).displays : null
  if (!Array.isArray(list)) return []
  return list.filter((d): d is DisplayShim => {
    if (!d || typeof d !== 'object') return false
    const r = d as Record<string, unknown>
    return typeof r.bounds === 'object' && r.bounds !== null && typeof r.workArea === 'object' && r.workArea !== null
  })
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

export function createShim(opts: ShimOptions): Shim {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const paths: Record<string, string> = {
    userData: opts.userData,
    home: os.homedir(),
    temp: os.tmpdir(),
    exe: process.execPath,
    logs: path.join(opts.userData, 'logs'),
  }
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler[]>()
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1

  // ---- app ----
  const app = new EventEmitter() as AppShim
  let quitting = false
  async function raise(name: string, ev: QuitEvent): Promise<void> {
    const settled = Promise.allSettled(app.listeners(name).map((fn) => Promise.resolve().then(() => fn(ev))))
    let timer: NodeJS.Timeout | undefined
    await Promise.race([settled, new Promise<void>((r) => (timer = setTimeout(r, QUIT_CAP_MS)))])
    if (timer) clearTimeout(timer)
  }
  function quitEvent(): QuitEvent {
    let prevented = false
    return {
      preventDefault: () => {
        prevented = true
      },
      get defaultPrevented() {
        return prevented
      },
    }
  }
  Object.defineProperty(app, 'isPackaged', { value: true, enumerable: true })
  Object.assign(app, {
    getPath(name: string): string {
      const v = paths[name]
      if (v === undefined) throw new Error(`app.getPath: unknown path ${name}`)
      return v
    },
    setPath(name: string, value: string): void {
      if (name === 'userData') {
        paths.userData = value
        paths.logs = path.join(value, 'logs')
      }
    },
    getVersion: () => opts.version,
    getName: () => 'SeaShell',
    whenReady: () => new Promise<void>((r) => setImmediate(r)),
    isReady: () => true,
    requestSingleInstanceLock: () => true,
    setAppUserModelId: () => {},
    quit(): void {
      if (quitting) return
      quitting = true
      void (async () => {
        // main's own before-quit handler prevents the default, drains, then calls
        // app.exit(0); the cap below still ends the core if that drain hangs.
        const cap = setTimeout(() => exit(0), QUIT_CAP_MS * 2)
        cap.unref?.()
        const before = quitEvent()
        await raise('before-quit', before)
        if (before.defaultPrevented) {
          quitting = false
          return
        }
        await raise('will-quit', quitEvent())
        clearTimeout(cap)
        exit(0)
      })()
    },
    exit(code = 0): void {
      exit(code)
    },
  })

  // ---- the virtual window ----
  const webContents = {
    send(ch: string, p: unknown) {
      if (CORE_PUSH_TO_SHELL.includes(ch)) opts.write(encodeEnvelope({ k: 'on', ch, p }))
      else opts.onPush(ch, p)
    },
    isDestroyed: () => false,
  }
  const win: WindowShim = {
    webContents,
    isDestroyed: () => false,
    focus() {},
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    on() {
      return win
    },
    once() {
      return win
    },
    setTitle() {},
    isMinimized: () => false,
    restore() {},
    show() {},
  }
  class BrowserWindowImpl {
    static getAllWindows(): WindowShim[] {
      return [win]
    }
    static getFocusedWindow(): WindowShim | null {
      return win
    }
    constructor() {
      return win as never
    }
  }
  const BrowserWindow = BrowserWindowImpl as unknown as typeof BrowserWindowShim

  // ---- ipcMain ----
  const ipcMain: IpcMainShim = {
    handle(ch, fn) {
      handlers.set(ch, fn)
    },
    removeHandler(ch) {
      handlers.delete(ch)
    },
    on(ch, fn) {
      listeners.set(ch, [...(listeners.get(ch) ?? []), fn])
    },
    removeListener(ch, fn) {
      const rest = (listeners.get(ch) ?? []).filter((f) => f !== fn)
      if (rest.length) listeners.set(ch, rest)
      else listeners.delete(ch)
    },
    removeAllListeners(ch) {
      if (ch === undefined) listeners.clear()
      else listeners.delete(ch)
    },
  }
  const event: IpcEvent = { sender: webContents }

  function invokeShell<T = unknown>(ch: string, p: unknown): Promise<T> {
    const id = nextId++
    const reply = new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }))
    opts.write(encodeEnvelope({ k: 'invoke', ch, id, p }))
    return reply
  }

  async function invokeLocal<T = unknown>(ch: string, p: unknown): Promise<T> {
    const h = handlers.get(ch)
    if (!h) throw new Error(`no handler for ${ch}`)
    return (await h(event, p as never)) as T
  }

  function sendLocal(ch: string, p: unknown): void {
    for (const fn of listeners.get(ch) ?? []) fn(event, p as never)
  }

  async function dispatch(e: Envelope): Promise<void> {
    if (e.k === 'invoke') {
      const id = e.id
      const h = handlers.get(e.ch)
      if (!h) {
        opts.write(encodeEnvelope({ k: 'reply', ch: e.ch, id, p: { ok: false, code: 'ENOHANDLER', message: `no handler for ${e.ch}` } }))
        return
      }
      try {
        opts.write(encodeEnvelope({ k: 'reply', ch: e.ch, id, p: await h(event, e.p as never) }))
      } catch (err) {
        opts.write(encodeEnvelope({ k: 'reply', ch: e.ch, id, p: { ok: false, code: 'EHANDLER', message: String(err) } }))
      }
      return
    }
    if (e.k === 'send') {
      if (e.ch === 'app:secondInstance') {
        app.emit('second-instance', undefined, [], process.cwd())
        return
      }
      if (e.ch === 'app:beforeQuit') {
        app.quit()
        return
      }
      const fns = listeners.get(e.ch)
      if (fns && fns.length) {
        for (const fn of fns) fn(event, e.p as never)
        return
      }
      opts.onPush(e.ch, e.p) // ui:event, ui:command, term:event, shell:geometry, shell:colorization: the controller's
      return
    }
    if (e.k === 'reply') {
      if (e.id === undefined) return
      const w = pending.get(e.id)
      pending.delete(e.id)
      w?.resolve(e.p)
      return
    }
    opts.onPush(e.ch, e.p) // 'on': the shell's own pushes (ui:event, term:event, shell:geometry)
  }

  // ---- Menu ----
  let appMenu: MenuShimInstance | null = null
  function buildMenu(template: ReadonlyArray<Record<string, unknown>>): MenuShimInstance {
    const items = template.map((t) => {
      const item: MenuItemShim = { ...t }
      const sub = t.submenu
      if (Array.isArray(sub)) item.submenu = buildMenu(sub as Array<Record<string, unknown>>)
      return item
    })
    return { items, popup() {} }
  }
  const Menu: MenuShim = {
    buildFromTemplate: buildMenu,
    setApplicationMenu(m) {
      appMenu = m
    },
    getApplicationMenu: () => appMenu,
  }

  // ---- shell, clipboard, dialog ----
  const shell: ShellShim = {
    async openPath(p) {
      const r = await invokeShell('open:withDefaultApp', { path: p })
      return isOk(r) ? '' : errorText(r, 'open failed')
    },
    async openExternal(url) {
      const r = await invokeShell('open:externalHttp', { url })
      if (!isOk(r)) throw new Error(errorText(r, 'openExternal failed'))
    },
    showItemInFolder(p) {
      void invokeShell('open:revealInFinder', { path: p })
    },
  }
  const clipboard: ClipboardShim = {
    async readText() {
      const r = await invokeShell<{ text?: unknown }>('clip:read', {})
      return r && typeof r.text === 'string' ? r.text : ''
    },
    async writeText(text) {
      await invokeShell('clip:write', { text })
    },
    // The shell has no image channel in Phase 1; an empty image makes main's paste fall through.
    readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
  }
  const dialog: DialogShim = {
    async showOpenDialog() {
      const r = await invokeShell<{ ok?: unknown; path?: unknown }>('app:pickFolder', {})
      return r && r.ok === true && typeof r.path === 'string' && r.path
        ? { canceled: false, filePaths: [r.path] }
        : { canceled: true, filePaths: [] }
    },
  }

  // ---- screen: sync getters over a cache that display:list refreshes ----
  let displays: DisplayShim[] = []
  const screen: ScreenShim = {
    async refresh() {
      const got = toDisplays(await invokeShell('display:list', {}))
      if (got.length) displays = got
      return displays
    },
    getAllDisplays() {
      void screen.refresh()
      return displays.length ? displays : [FALLBACK_DISPLAY]
    },
    getPrimaryDisplay() {
      void screen.refresh()
      return displays[0] ?? FALLBACK_DISPLAY
    },
    getDisplayMatching(rect) {
      void screen.refresh()
      let best = displays[0] ?? FALLBACK_DISPLAY
      let bestArea = 0
      for (const d of displays) {
        const a = overlap(d.bounds, rect)
        if (a > bestArea) {
          best = d
          bestArea = a
        }
      }
      return best
    },
  }

  const protocol = { handle() {}, registerSchemesAsPrivileged() {} }

  return {
    app,
    BrowserWindow,
    Menu,
    ipcMain,
    net: { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) },
    protocol,
    screen,
    shell,
    clipboard,
    dialog,
    dispatch,
    invokeLocal,
    sendLocal,
    invokeShell,
  }
}
