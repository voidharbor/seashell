import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { net } from 'electron'
import type { UpdateState } from '../../shared/ipc.js'
import { isNewer, parseRelease, RELEASE_ORIGIN, type ReleaseInfo } from './check.js'
import { buildInstallScript } from './install-script.js'
import { shouldEmitProgress, type ProgressPoint } from './progress.js'

export interface UpdaterDeps {
  currentVersion: string
  isPackaged: boolean
  /** app.getPath('exe') */
  exePath: string
  userData: string
  platform: NodeJS.Platform
  send: (state: UpdateState) => void
  /** The app's own pid, for the install script's wait. */
  pid: number
  quit: () => void
  /**
   * Injected only by the tests. Production leaves it unset and gets Electron's
   * `net.fetch`, which goes through the app's own network stack, proxy
   * settings and certificate store rather than Node's.
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

/**
 * Three overrides, for smoke tests only: a local release JSON, the origin its
 * zip may come from, and a scratch copy of the bundle to swap. With none of
 * them set this talks to GitHub and swaps /Applications/SeaShell.app, which is
 * the only thing that ever happens in a real launch.
 */
const API =
  process.env.SEASHELL_UPDATE_API || 'https://api.github.com/repos/voidharbor/seashell/releases/latest'
const ORIGIN = process.env.SEASHELL_UPDATE_ORIGIN || RELEASE_ORIGIN
const INSTALLED_APP = process.env.SEASHELL_UPDATE_APP_PATH || '/Applications/SeaShell.app'
const TIMEOUT_MS = 5000

export class Updater {
  private release: ReleaseInfo | null = null
  private zipPath: string | null = null
  private state: UpdateState = { phase: 'idle' }

  constructor(private readonly d: UpdaterDeps) {}

  private set(s: UpdateState): void {
    this.state = s
    this.d.send(s)
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    return this.d.fetch ? this.d.fetch(url, init) : net.fetch(url, init)
  }

  /** One check per launch. Silent on every failure: an updater must never nag. */
  async start(): Promise<void> {
    if (!this.d.isPackaged || process.env.SEASHELL_NO_UPDATE_CHECK) return
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
      const res = await this.fetch(API, {
        headers: { accept: 'application/vnd.github+json' },
        signal: ctl.signal,
      })
      clearTimeout(t)
      if (!res.ok) return
      const info = parseRelease(await res.json(), ORIGIN)
      if (!info || !isNewer(info.version, this.d.currentVersion)) return
      this.release = info
      // The swap script only knows how to replace INSTALLED_APP, so a copy
      // running from anywhere else is offered the release page instead. The
      // check is skipped when a test has pointed the swap at a scratch bundle.
      const inPlace =
        Boolean(process.env.SEASHELL_UPDATE_APP_PATH) ||
        this.d.exePath.startsWith(INSTALLED_APP + '/')
      const canInstall = this.d.platform === 'darwin' && inPlace
      this.set({ phase: 'available', version: info.version, pageUrl: info.pageUrl, canInstall })
    } catch {
      /* offline, rate-limited, whatever: say nothing */
    }
  }

  /** From `available`, and from `error` again: a download that failed on a
   *  blip is worth another click, not the loss of the release. */
  async download(): Promise<void> {
    const info = this.release
    if (!info || (this.state.phase !== 'available' && this.state.phase !== 'error')) return
    // Claimed before the first await, so two fast clicks cannot both pass the
    // guard above and write the same file at once.
    this.set({ phase: 'downloading', version: info.version, received: 0, total: info.zipBytes })
    const dir = path.join(this.d.userData, 'updates')
    const target = path.join(dir, `SeaShell-${info.version}-universal.zip`)
    try {
      await fsp.mkdir(dir, { recursive: true })
      const res = await this.fetch(info.zipUrl)
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
      const out = fs.createWriteStream(target)
      const reader = res.body.getReader()
      let received = 0
      // The state above is the first point on the curve, so the throttle is
      // measured from it rather than from the first chunk.
      let sent: ProgressPoint = { received: 0, total: info.zipBytes, at: Date.now() }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        const point: ProgressPoint = { received, total: info.zipBytes, at: Date.now() }
        if (shouldEmitProgress(sent, point)) {
          sent = point
          this.set({ phase: 'downloading', version: info.version, received, total: info.zipBytes })
        }
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
      // The size the release advertised is the only thing this can check
      // without a signing key, so a short or padded download stops here.
      const size = (await fsp.stat(target)).size
      if (size !== info.zipBytes) {
        throw new Error(`size mismatch: got ${size}, expected ${info.zipBytes}`)
      }
      this.zipPath = target
      this.set({ phase: 'ready', version: info.version })
    } catch (e) {
      await fsp.rm(target, { force: true })
      this.set({
        phase: 'error',
        version: info.version,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  async install(): Promise<void> {
    const info = this.release
    if (!info || !this.zipPath || this.state.phase !== 'ready') return
    const dir = path.join(this.d.userData, 'updates')
    const script = path.join(dir, 'install.sh')
    try {
      await fsp.writeFile(
        script,
        buildInstallScript({
          pid: this.d.pid,
          zipPath: this.zipPath,
          stagingDir: path.join(dir, 'staging'),
          appPath: INSTALLED_APP,
          expectedVersion: info.version,
          logPath: path.join(dir, 'install.log'),
        }),
        { mode: 0o755 }
      )
      // Detached and unref'd on purpose: it has to outlive this process, since
      // the first thing it does is wait for this pid to go away.
      const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' })
      child.unref()
    } catch (e) {
      // Nothing has been swapped at this point, so the app stays where it is
      // and the banner says why rather than quitting into nothing.
      this.set({
        phase: 'error',
        version: info.version,
        message: e instanceof Error ? e.message : String(e),
      })
      return
    }
    this.d.quit()
  }
}
