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
    },
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

app.on('will-quit', () => {
  metrics?.stop()
  void ptyManager?.killAll()
})
