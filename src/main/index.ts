import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { buildMenu } from './menu.js'
import { registerIpc } from './ipc-router.js'
import { PtyManager } from './pty/manager.js'
import { MetricsMonitor } from './monitor/monitor.js'

const isDev = !app.isPackaged
const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The renderer is served from a privileged `app://` scheme rather than
 * `file://`. A file:// origin would make every file on disk same-origin with
 * the renderer, which for an app that displays untrusted terminal bytes is not
 * a risk worth carrying.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
])

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let metrics: MetricsMonitor | null = null

const RENDERER_DIR = path.join(dirname, '../renderer')

/** Resolves an app:// URL to a real file, refusing anything outside the bundle. */
function resolveRendererFile(requestUrl: string): string | null {
  const url = new URL(requestUrl)
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const abs = path.resolve(RENDERER_DIR, rel === '' ? 'index.html' : rel)
  // Path traversal guard: the resolved path must stay under the renderer dir.
  if (abs !== RENDERER_DIR && !abs.startsWith(RENDERER_DIR + path.sep)) return null
  return abs
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d10',
    show: false,
    webPreferences: {
      preload: path.join(dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // Required by the web preview pane. Guests are separate processes and
      // cannot reach the preload surface; `will-attach-webview` below strips
      // any preload or node integration a guest tag tries to request.
      webviewTag: true,
    },
  })

  /**
   * Last word on what a web preview guest is allowed to be.
   *
   * The renderer already sets safe attributes on the tag, but a renderer
   * compromise could set different ones — so the decision is re-made here,
   * where the renderer cannot reach it. Any preload is deleted outright and
   * node integration is forced off regardless of what the tag asked for.
   */
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true

    const src = String(params.src ?? '')
    if (!/^https?:\/\//i.test(src)) {
      // A guest is for previewing a web page. file:// would give it the disk.
      params.src = 'about:blank'
    }
  })

  // A guest must not be able to open windows in the host app either.
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // A terminal prints attacker-influenced text. Nothing in this app should ever
  // open a new window or navigate the renderer away from its own origin.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadURL('app://seashell/index.html')
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * One instance only.
 *
 * Two copies of SeaShell share a single `userData` directory, and both rewrite
 * the ZDOTDIR shim at startup — while the other's panes may be sourcing those
 * exact files. The instances also cannot see each other's PTYs, so the kill
 * ladder and the pane cap are both computed against half the truth.
 *
 * A second launch focuses the window that already exists instead, which is what
 * double-clicking the app in the Dock should do anyway.
 *
 * Known failure mode, and the reason this comment is here: the lock lives in
 * `Singleton{Lock,Socket,Cookie}` under userData. Chromium normally reclaims it
 * when the recorded pid is gone, but after an abnormal termination that leaves
 * orphaned `SeaShell Helper` processes behind, it can stay held — and the
 * symptom is that the app exits instantly with no window and nothing printed,
 * which looks like a crash rather than a lock. If SeaShell ever refuses to
 * start after a force-quit: kill any stray `SeaShell Helper` processes and
 * delete the three `Singleton*` entries in
 * ~/Library/Application Support/seashell/.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const file = resolveRendererFile(req.url)
    if (!file) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })

  ptyManager = new PtyManager(() => mainWindow)
  metrics = new MetricsMonitor(ptyManager, () => mainWindow)
  registerIpc(ptyManager)

  createWindow()
  buildMenu(() => mainWindow)
  metrics.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

/**
 * Quit must not race the kill ladder.
 *
 * `killAll()` is async — it signals, waits for processes to actually die, and
 * escalates. Firing it from a quit handler without holding the quit open lets
 * Electron tear the process down mid-ladder, so nothing past the first SIGHUP
 * ever runs.
 *
 * Closing the PTY master does make the kernel SIGHUP each pane's foreground
 * process group, which cleans up an idle shell on its own. That rescue is what
 * hid this: it covers the common case and none of the cases the ladder exists
 * for. Anything that survives SIGHUP — a `nohup`'d job, a `disown`ed background
 * process, a program that traps HUP — is precisely the orphaned-agent process
 * this app was built to prevent, and it leaked out on every quit.
 *
 * The timeout is a deadlock guard: a wedged `ps` sweep must never make the app
 * unquittable. Losing the ladder is bad; an app you cannot quit is worse.
 */
const QUIT_DRAIN_TIMEOUT_MS = 8000
let draining = false

app.on('before-quit', (e) => {
  if (draining) return // second pass, after the drain — let it through
  e.preventDefault()
  draining = true
  metrics?.stop()

  void (async () => {
    try {
      await Promise.race([
        ptyManager?.killAll() ?? Promise.resolve(),
        new Promise<void>((r) => setTimeout(r, QUIT_DRAIN_TIMEOUT_MS)),
      ])
    } catch {
      /* a failed reap must still not block quit */
    }
    app.exit(0)
  })()
})
