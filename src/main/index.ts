import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CH } from '../shared/ipc.js'
import { Updater } from './update/updater.js'
import { buildMenu } from './menu.js'
import { awaitSnapshot, registerIpc } from './ipc-router.js'
import { PtyManager } from './pty/manager.js'
import { DirWatcher } from './fs/watcher.js'
import { MetricsMonitor } from './monitor/monitor.js'
import { startControlServer, type ControlServer } from './control/server.js'
import { checkTtyForeground } from './control/foreground-check.js'
import { screenKindOf } from './control/screen-kind.js'

/**
 * A second instance for development and smoke tests. The single-instance lock
 * is keyed on userData, so pointing it elsewhere is what lets a test build run
 * beside the installed app instead of exiting on the lock. Never set in
 * production launches.
 */
if (process.env.SEASHELL_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.SEASHELL_USER_DATA))
}

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
let controlServer: ControlServer | null = null
let watcher: DirWatcher | null = null

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
    // Parsed, not regexed. A string test on the raw URL is fragment-blind:
    // file:///secret.html#x.pdf ends in ".pdf" and would have sailed through,
    // loading arbitrary local HTML in the guest. URL() splits hash and query
    // off before the suffix check, so only a genuine *.pdf pathname qualifies.
    let isPdfFile = false
    try {
      const u = new URL(src)
      isPdfFile = u.protocol === 'file:' && /\.pdf$/i.test(decodeURIComponent(u.pathname))
    } catch {
      /* not a URL at all — falls through to about:blank */
    }
    if (!/^https?:\/\//i.test(src) && !isPdfFile) {
      // A guest is for previewing a web page — or, the one file:// exception,
      // a PDF for the in-pane viewer. General file:// would hand the guest the
      // disk; a .pdf path hands PDFium a document to parse in its sandbox,
      // which is the same exposure as opening it in Chrome. Anything else
      // pretending to be a guest gets a blank page.
      params.src = 'about:blank'
    }
  })

  // A guest must not be able to open windows in the host app either, and once
  // attached it may only ever *navigate* to the web. The initial file://*.pdf
  // load arrives via the src attribute, which will-navigate does not cover —
  // so this cannot break the PDF preview, but it does stop a crafted PDF's
  // link (or a compromised web page) walking the frame onto another file://
  // and turning the viewer into a local file browser.
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    guest.on('will-navigate', (e, url) => {
      if (!/^https?:\/\//i.test(url)) e.preventDefault()
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
 * What the last install script had to say, if it did not finish.
 *
 * The swap runs after this process is gone, so a failure has nowhere to be
 * reported when it happens. The log is read once on the next launch: unless it
 * ends in success its last line goes to the renderer as an ordinary toast, and
 * the log is deleted first so nobody is told the same thing twice.
 */
async function reportLastInstall(): Promise<void> {
  const logPath = path.join(app.getPath('userData'), 'updates', 'install.log')
  let last = ''
  try {
    const text = await fsp.readFile(logPath, 'utf8')
    const lines = text.trimEnd().split('\n')
    last = lines[lines.length - 1] ?? ''
  } catch {
    return // no log at all is the ordinary case
  }
  if (last === '' || last.includes('install done')) return
  await fsp.rm(logPath, { force: true })
  const win = mainWindow
  if (!win) return
  // A grace period after the load event: the renderer subscribes to this
  // channel on its first render, which lands a beat later.
  const send = (): void => {
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.send(CH.appToast, { message: `Update did not install: ${last}` })
      }
    }, 800)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
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

  /**
   * Pane-delivery control socket for /c-assistant — see
   * docs/superpowers/specs/2026-07-31-pane-delivery-design.md. A failure to
   * start it degrades to the old copy-paste world; it must never take the
   * terminal down with it.
   */
  const pm = ptyManager

  /** Main's own screen read for a pane, from its raw output tail. */
  const paneScreenKind = (paneId: string): 'input' | 'selector' | null => {
    const tail = pm.tailOf(paneId)
    return tail === null ? null : screenKindOf(tail)
  }

  watcher = new DirWatcher({
    emit: (dir) => mainWindow?.webContents.send(CH.watchChanged, { dir }),
    lost: (dir) => mainWindow?.webContents.send(CH.watchLost, { dir }),
  })

  registerIpc(ptyManager, { watcher })

  void startControlServer({
    socketPath: path.join(app.getPath('userData'), 'control.sock'),
    writeToPane: (paneId, text) => pm.writeIfLive(paneId, text),
    paneTty: (paneId) => pm.paneTty(paneId),
    checkForeground: checkTtyForeground,
    screenKind: paneScreenKind,
  }).then(
    (server) => {
      controlServer = server
    },
    () => {
      controlServer = null
    }
  )

  createWindow()
  buildMenu(() => mainWindow)
  metrics.start()

  /**
   * The updater.
   *
   * Nothing here installs anything on its own: it checks once, five seconds in
   * so the check never competes with the first paint, and everything after
   * that is a click in the banner.
   *
   * SEASHELL_FAKE_VERSION makes an unpackaged dev instance believe it is old,
   * for smoke-testing the banner. Documented in the README dev note, along
   * with the three SEASHELL_UPDATE_* overrides updater.ts reads.
   */
  const updater = new Updater({
    currentVersion: process.env.SEASHELL_FAKE_VERSION ?? app.getVersion(),
    isPackaged: app.isPackaged || Boolean(process.env.SEASHELL_FAKE_VERSION),
    exePath: app.getPath('exe'),
    userData: app.getPath('userData'),
    platform: process.platform,
    pid: process.pid,
    send: (s) => mainWindow?.webContents.send(CH.updateState, s),
    quit: () => app.quit(),
  })
  ipcMain.on(CH.updateDownload, () => void updater.download())
  ipcMain.on(CH.updateInstall, () => void updater.install())
  setTimeout(() => void updater.start(), 5000)
  void reportLastInstall()

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

/** How long quit will wait for the renderer's parting snapshot of the layout. */
const SNAPSHOT_TIMEOUT_MS = 1000

let draining = false

app.on('before-quit', (e) => {
  if (draining) return // second pass, after the drain — let it through
  e.preventDefault()
  draining = true
  metrics?.stop()

  void (async () => {
    // The last thing asked of the renderer, and the first thing done here:
    // once killAll starts, panes begin dying and the layout being snapshotted
    // is no longer the one the user quit. One second is a generous ceiling for
    // a JSON.stringify and a single file write, and it is capped rather than
    // awaited outright because quit is not allowed to depend on the renderer.
    try {
      if (mainWindow) await awaitSnapshot(mainWindow, SNAPSHOT_TIMEOUT_MS)
    } catch {
      /* no snapshot is a lost nicety, never a reason to stay open */
    }

    try {
      await Promise.race([
        Promise.all([
          ptyManager?.killAll() ?? Promise.resolve(),
          controlServer?.close() ?? Promise.resolve(),
          // close() is synchronous; wrapped so a throw here cannot block quit.
          (async () => {
            try {
              watcher?.close()
            } catch {
              /* a stuck fs watch must not delay quit */
            }
          })(),
        ]),
        new Promise<void>((r) => setTimeout(r, QUIT_DRAIN_TIMEOUT_MS)),
      ])
    } catch {
      /* a failed reap must still not block quit */
    }
    app.exit(0)
  })()
})
