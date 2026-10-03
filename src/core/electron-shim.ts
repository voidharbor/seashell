/**
 * The `electron` module as `src/main` sees it inside the core (spec 4.3 of the
 * redesign spec). One virtual window, ipcMain dispatch tables fed by the stdio
 * bridge, and every OS-facing call relayed to the shell as an `invoke`.
 */
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { CORE_PUSH_TO_SHELL, encodeEnvelope, type Envelope } from './protocol.js'
import type { MenuItemModel, ShellCmd } from './controller/model.js'

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

/** The window's webContents: sends reach the pipe or the controller; its events never fire. */
export interface WebContentsShim {
  send(ch: string, p: unknown): void
  isDestroyed(): boolean
  isLoading(): boolean
  on(ev: string, fn: (...a: never[]) => unknown): WebContentsShim
  once(ev: string, fn: (...a: never[]) => unknown): WebContentsShim
  off(ev: string, fn: (...a: never[]) => unknown): WebContentsShim
  setWindowOpenHandler(fn: (...a: never[]) => unknown): void
}

/**
 * The one virtual window `src/main` addresses. The shell owns the real window,
 * so its state reads as a plain visible, unmaximized window and the actions
 * (maximize, loadURL, ...) do nothing here. `minimize` and `close` are the
 * application menu's Window items (menu.ts), so they reach the shell's own
 * `window:minimize` and `window:close`.
 */
export interface WindowShim {
  webContents: WebContentsShim
  isDestroyed(): boolean
  focus(): void
  getBounds(): Rect
  getNormalBounds(): Rect
  on(ev: string, fn: (...a: never[]) => unknown): WindowShim
  once(ev: string, fn: (...a: never[]) => unknown): WindowShim
  off(ev: string, fn: (...a: never[]) => unknown): WindowShim
  setTitle(t: string): void
  isMinimized(): boolean
  isMaximized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  maximize(): void
  unmaximize(): void
  minimize(): void
  close(): void
  loadURL(url: string): Promise<void>
}

export declare class BrowserWindowShim {
  static getAllWindows(): WindowShim[]
  static getFocusedWindow(): WindowShim | null
  static fromWebContents(wc: unknown): WindowShim | null
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

/**
 * Electron's own labels (win32) for the roles main's template leaves
 * unlabelled: `{ role: 'about' }`, `{ role: 'togglefullscreen' }` and the
 * top-level `{ role: 'help' }`.
 */
const ROLE_LABELS: Readonly<Record<string, string>> = {
  about: 'About SeaShell',
  quit: 'Exit',
  togglefullscreen: 'Toggle Full Screen',
  toggleDevTools: 'Toggle Developer Tools',
  help: 'Help',
  windowMenu: 'Window',
  minimize: 'Minimize',
  close: 'Close Window',
  hide: 'Hide SeaShell',
  hideOthers: 'Hide Others',
  unhide: 'Show All',
}

/** An item's submenu items, whether the template held an array or a built menu. */
function subItems(item: MenuItemShim): ReadonlyArray<MenuItemShim> | null {
  const sub = item.submenu as unknown
  if (Array.isArray(sub)) return sub as MenuItemShim[]
  if (sub && typeof sub === 'object' && Array.isArray((sub as MenuShimInstance).items)) return (sub as MenuShimInstance).items
  return null
}

/**
 * [pure] A built menu as the shell takes it in `shell:cmd { op: 'menu' }`:
 * labels, accelerators, roles and each item's path; clicks stay in the core.
 */
export function menuItemsForShell(items: ReadonlyArray<MenuItemShim>, parent: number[] = []): MenuItemModel[] {
  return items.map((item, i) => {
    const path = [...parent, i]
    const role = typeof item.role === 'string' ? item.role : null
    const sub = subItems(item)
    const type: MenuItemModel['type'] = item.type === 'separator' ? 'separator' : sub ? 'submenu' : 'normal'
    const label = typeof item.label === 'string' ? item.label : role ? (ROLE_LABELS[role] ?? role) : ''
    return {
      label,
      accelerator: typeof item.accelerator === 'string' ? item.accelerator : null,
      role,
      type,
      enabled: item.enabled !== false,
      path,
      submenu: sub ? menuItemsForShell(sub, path) : null,
    }
  })
}

/** [pure] The item at `path` in a built menu, or null when the path does not resolve. */
export function menuItemAt(menu: MenuShimInstance | null, path: unknown): MenuItemShim | null {
  if (!menu || !Array.isArray(path) || path.length === 0) return null
  let items: ReadonlyArray<MenuItemShim> | null = menu.items
  let item: MenuItemShim | null = null
  for (const i of path) {
    if (!items || typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= items.length) return null
    item = items[i] ?? null
    if (!item) return null
    items = subItems(item)
  }
  return item
}

/**
 * Pane bytes cross the pipe as base64 (design spec 4.2): the batcher hands over
 * decoded UTF-8 text, the shell feeds raw bytes to its grids.
 */
export function ptyDataForPipe(p: unknown): unknown {
  if (!p || typeof p !== 'object') return p
  const batches = (p as { batches?: unknown }).batches
  if (!Array.isArray(batches)) return p
  return {
    ...p,
    batches: batches.map((b: unknown) => {
      if (!b || typeof b !== 'object') return b
      const data = (b as { data?: unknown }).data
      return typeof data === 'string' ? { ...b, data: Buffer.from(data, 'utf8').toString('base64') } : b
    }),
  }
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
  const webContents: WebContentsShim = {
    send(ch: string, p: unknown) {
      if (ch === 'pty:data') opts.write(encodeEnvelope({ k: 'on', ch, p: ptyDataForPipe(p) }))
      else if (CORE_PUSH_TO_SHELL.includes(ch)) opts.write(encodeEnvelope({ k: 'on', ch, p }))
      else opts.onPush(ch, p)
    },
    isDestroyed: () => false,
    isLoading: () => false,
    on: () => webContents,
    once: () => webContents,
    off: () => webContents,
    setWindowOpenHandler() {},
  }
  const win: WindowShim = {
    webContents,
    isDestroyed: () => false,
    focus() {},
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    getNormalBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    on: () => win,
    once: () => win,
    off: () => win,
    setTitle() {},
    isMinimized: () => false,
    isMaximized: () => false,
    isVisible: () => true,
    restore() {},
    show() {},
    maximize() {},
    unmaximize() {},
    minimize() {
      void invokeShell('window:minimize', {})
    },
    close() {
      void invokeShell('window:close', {})
    },
    loadURL: () => Promise.resolve(),
  }
  class BrowserWindowImpl {
    static getAllWindows(): WindowShim[] {
      return [win]
    }
    static getFocusedWindow(): WindowShim | null {
      return win
    }
    static fromWebContents(wc: unknown): WindowShim | null {
      return wc === webContents ? win : null
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
      if (e.ch === 'menu:click') {
        clickMenu(e.p)
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
  // setApplicationMenu sends the shell the menu to pop (`shell:cmd { op: 'menu' }`);
  // the shell's pick comes back as `menu:click { path }` and runs the item here.
  let appMenu: MenuShimInstance | null = null
  function clickMenu(p: unknown): void {
    const path = p && typeof p === 'object' ? (p as { path?: unknown }).path : undefined
    const item = menuItemAt(appMenu, path)
    if (!item || item.enabled === false || item.type === 'separator' || subItems(item)) return
    try {
      if (typeof item.click === 'function') item.click(item, win, {})
      else if (item.role === 'quit') app.quit()
    } catch (err) {
      process.stderr.write(`[core] menu:click ${JSON.stringify(path)} failed: ${String(err)}\n`)
    }
  }
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
      const cmd: ShellCmd = { op: 'menu', items: m ? menuItemsForShell(m.items) : [] }
      opts.write(encodeEnvelope({ k: 'on', ch: 'shell:cmd', p: cmd }))
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
