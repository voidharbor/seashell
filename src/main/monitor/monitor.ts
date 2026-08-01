import type { BrowserWindow } from 'electron'
import { CH, type PaneMetrics } from '../../shared/ipc.js'
import type { PtyManager } from '../pty/manager.js'
import { psSweepMemory } from './procsweep.js'
import { parsePsOutput, sumSubtreeRss } from './sweep-parse.js'
import { readSystemMemory } from './system-mem.js'
import { classifyActivity } from './activity.js'

/** Sweep cadence while the window is on screen. */
export const VISIBLE_TICK_MS = 5000

/**
 * Sweep cadence while the window is hidden or minimised.
 *
 * A sweep is two subprocess spawns and a parse of the machine's whole process
 * table. Doing that every five seconds forever for a window nobody is looking
 * at is pure waste (§19.3 anticipated dropping the cadence). The numbers are
 * only ever read by an on-screen UI, so nothing is lost by sampling them more
 * coarsely — and the moment the window comes back, a sweep runs immediately
 * rather than leaving stale figures on screen for half a minute.
 */
export const HIDDEN_TICK_MS = 30_000

interface PaneSample {
  bytesOut: number
  at: number
}

/**
 * Samples process and system memory and pushes it to the renderer.
 *
 * This exists because the machine SeaShell was built for has 16 GB and a
 * documented history of forgotten agent sessions quietly eating it. Making the
 * cost visible is the whole point; a number nobody can see would be pointless.
 */
export class MetricsMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** Set while parked on the long interval, so a wake event knows to cut it short. */
  private sleeping = false
  private watching: BrowserWindow | null = null
  /** Previous output counter per pane, for the per-sweep rate. */
  private readonly lastSample = new Map<string, PaneSample>()

  constructor(
    private readonly ptys: PtyManager,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.watchWindow()
    void this.run()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.sleeping = false
    this.unwatchWindow()
    this.lastSample.clear()
  }

  /**
   * A hidden window's long sleep must not survive being shown again. Without
   * this, coming back to SeaShell would show numbers up to half a minute stale
   * and no obvious reason why.
   */
  private readonly onWake = (): void => {
    if (!this.running || !this.sleeping) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.run()
  }

  private watchWindow(): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed() || this.watching === win) return
    this.unwatchWindow()
    win.on('show', this.onWake)
    win.on('restore', this.onWake)
    win.on('focus', this.onWake)
    this.watching = win
  }

  private unwatchWindow(): void {
    const win = this.watching
    this.watching = null
    if (!win || win.isDestroyed()) return
    win.off('show', this.onWake)
    win.off('restore', this.onWake)
    win.off('focus', this.onWake)
  }

  private visible(): boolean {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return false
    return win.isVisible() && !win.isMinimized()
  }

  private schedule(): void {
    if (!this.running) return
    const onScreen = this.visible()
    this.sleeping = !onScreen
    this.timer = setTimeout(
      () => void this.run(),
      onScreen ? VISIBLE_TICK_MS : HIDDEN_TICK_MS
    )
  }

  private async run(): Promise<void> {
    this.sleeping = false
    try {
      await this.tick()
    } finally {
      // The window is created before the monitor starts, but re-attaching is
      // cheap and covers a window replaced under a long-lived monitor.
      this.watchWindow()
      this.schedule()
    }
  }

  private async tick(): Promise<void> {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return

    const live = this.ptys.listPids()
    if (live.length === 0) {
      this.lastSample.clear()
      return
    }

    const [stdout, system] = await Promise.all([psSweepMemory(), readSystemMemory()])
    if (!stdout) return

    const now = Date.now()
    const tree = parsePsOutput(stdout)
    const panes: PaneMetrics[] = live.map(({ paneId, pid, bytesOut }) => {
      const sum = sumSubtreeRss(tree, pid)
      const rows = sum.pids.map((p) => tree.rows.get(p)).filter((r) => r !== undefined)
      const cpu = rows.reduce((acc, r) => acc + r.pcpu, 0)

      // The foreground process is whatever descendant is not the shell itself.
      const shellRow = tree.rows.get(pid)
      const nonShell = rows.filter((r) => r.pid !== pid)
      const foreground = nonShell.length > 0 ? (nonShell[0]?.comm ?? 'zsh') : (shellRow?.comm ?? 'zsh')

      /**
       * How much the pane has painted since the last sweep, and over how long.
       *
       * A pane seen for the first time has no baseline, so everything it has
       * ever written counts as this interval's output and it reads as busy.
       * That is the right way round: a pane that just spawned is starting up,
       * not waiting on anyone.
       */
      const previous = this.lastSample.get(paneId)
      const outputBytes = previous ? Math.max(0, bytesOut - previous.bytesOut) : bytesOut
      const elapsedMs = previous ? now - previous.at : 0
      this.lastSample.set(paneId, { bytesOut, at: now })

      const state = classifyActivity({
        nonShellCount: nonShell.length,
        cpuPercent: cpu,
        outputBytes,
        elapsedMs,
      })

      return {
        paneId,
        // Named footprintBytes in the contract, but derived from summed RSS,
        // which double-counts shared pages. The UI shows it with a "~".
        footprintBytes: sum.rssSumKb * 1024,
        cpuFrac: cpu / 100,
        state,
        foregroundProcess: basename(foreground),
        procCount: sum.pids.length,
        cwd: '',
      }
    })

    // Panes that have gone away must not hold a baseline forever.
    if (this.lastSample.size > live.length) {
      const alive = new Set(live.map((p) => p.paneId))
      for (const id of [...this.lastSample.keys()]) {
        if (!alive.has(id)) this.lastSample.delete(id)
      }
    }

    win.webContents.send(CH.metricsTick, { panes, system })
  }
}

function basename(comm: string): string {
  const i = comm.lastIndexOf('/')
  return i >= 0 ? comm.slice(i + 1) : comm
}
