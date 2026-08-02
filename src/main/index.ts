import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { buildMenu } from './menu.js'
import { registerIpc } from './ipc-router.js'
import { PtyManager } from './pty/manager.js'
import { MetricsMonitor } from './monitor/monitor.js'
import { startControlServer, type ControlServer } from './control/server.js'
import { checkTtyForeground } from './control/foreground-check.js'
import { CardStore } from './lookout/card-store.js'
import { approveCard } from './lookout/approve.js'
import { lookoutPluginInstalled } from './lookout/plugin-detect.js'
import { screenKindOf } from './lookout/screen-kind.js'
import { CH } from '../shared/ipc.js'

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

  /**
   * The sweep timer exists only while a card does — same reasoning and shape
   * as the pty flush loop's ensureFlushLoop/stopFlushLoop in pty/manager.ts:
   * a wakeup every 2s for the app's whole life would cost far more than the
   * staleness check it buys while the card stack is empty, which is most of
   * the time.
   *
   * Declared as functions (hoisted), not const arrows, so the CardStore emit
   * dep just below can call ensureSweepLoop regardless of declaration order.
   */
  const LOOKOUT_SWEEP_INTERVAL_MS = 2000
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  function ensureSweepLoop(): void {
    if (sweepTimer) return
    sweepTimer = setInterval(() => {
      cardStore.sweep()
      if (cardStore.cards().length === 0) stopSweepLoop()
    }, LOOKOUT_SWEEP_INTERVAL_MS)
  }
  function stopSweepLoop(): void {
    if (sweepTimer) clearInterval(sweepTimer)
    sweepTimer = null
  }

  /**
   * Lookout card store — see
   * docs/superpowers/specs/2026-08-01-lookout-approval-cards-design.md. Fed
   * by both pushed cards from the control socket and the renderer's
   * detector lane.
   *
   * emit is the one choke point every store mutation that can leave active
   * cards behind runs through (createFromPush, createFromDetector, sweep,
   * dismiss, ...), so arming the sweep loop here — rather than at each
   * call site — is what actually covers the detector lane. Arming it only
   * from postCard (the push path) missed the detector lane entirely: cards
   * never greyed on new output and exited panes left immortal cards. See
   * the whole-branch review.
   */
  const cardStore = new CardStore({
    bytesOut: (paneId) => pm.bytesOutOf(paneId),
    emit: (cards) => {
      mainWindow?.webContents.send(CH.lookoutCards, { cards })
      if (cards.length > 0) ensureSweepLoop()
    },
    now: Date.now,
  })

  /** Main's own screen read for a pane, from its raw output tail. */
  const paneScreenKind = (paneId: string): 'input' | 'selector' | null => {
    const tail = pm.tailOf(paneId)
    return tail === null ? null : screenKindOf(tail)
  }

  // Registered once pm and cardStore both exist: the approve closure needs both.
  registerIpc(ptyManager, {
    store: cardStore,
    approve: (r) =>
      approveCard(
        {
          store: cardStore,
          paneTty: (id) => pm.paneTty(id),
          checkForeground: checkTtyForeground,
          writeIfLive: (id, d) => pm.writeIfLive(id, d),
          screenKind: paneScreenKind,
        },
        r
      ),
    pluginInstalled: lookoutPluginInstalled,
  })

  void startControlServer({
    socketPath: path.join(app.getPath('userData'), 'control.sock'),
    writeToPane: (paneId, text) => pm.writeIfLive(paneId, text),
    paneTty: (paneId) => pm.paneTty(paneId),
    checkForeground: checkTtyForeground,
    screenKind: paneScreenKind,
    postCard: (req) => {
      const created = cardStore.createFromPush(req.paneId, req.question, req.draft)
      // No ensureSweepLoop call here: createFromPush always emits on
      // success, so the CardStore emit dep above already arms the loop.
      return created ? null : 'lookout disabled or pane not eligible'
    },
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
        Promise.all([
          ptyManager?.killAll() ?? Promise.resolve(),
          controlServer?.close() ?? Promise.resolve(),
        ]),
        new Promise<void>((r) => setTimeout(r, QUIT_DRAIN_TIMEOUT_MS)),
      ])
    } catch {
      /* a failed reap must still not block quit */
    }
    app.exit(0)
  })()
})
