import type { BrowserWindow } from 'electron'
import { CH, type PaneActivity, type PaneMetrics } from '../../shared/ipc.js'
import type { PtyManager } from '../pty/manager.js'
import { psSweepMemory } from './procsweep.js'
import { parsePsOutput, sumSubtreeRss } from './sweep-parse.js'
import { readSystemMemory } from './system-mem.js'

const TICK_MS = 5000

/**
 * Samples process and system memory and pushes it to the renderer.
 *
 * This exists because the machine SeaShell was built for has 16 GB and a
 * documented history of forgotten agent sessions quietly eating it. Making the
 * cost visible is the whole point; a number nobody can see would be pointless.
 */
export class MetricsMonitor {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly ptys: PtyManager,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return

    const pids = this.ptys.listPids()
    if (pids.length === 0) return

    const [stdout, system] = await Promise.all([psSweepMemory(), readSystemMemory()])
    if (!stdout) return

    const tree = parsePsOutput(stdout)
    const panes: PaneMetrics[] = pids.map(({ paneId, pid }) => {
      const sum = sumSubtreeRss(tree, pid)
      const rows = sum.pids.map((p) => tree.rows.get(p)).filter((r) => r !== undefined)
      const cpu = rows.reduce((acc, r) => acc + r.pcpu, 0)

      // The foreground process is whatever descendant is not the shell itself.
      // It is what tells "sitting at a prompt" apart from "actually working" —
      // output volume cannot, because an animated spinner never stops emitting.
      const shellRow = tree.rows.get(pid)
      const nonShell = rows.filter((r) => r.pid !== pid)
      const foreground = nonShell.length > 0 ? (nonShell[0]?.comm ?? 'zsh') : (shellRow?.comm ?? 'zsh')

      let state: PaneActivity = 'PROMPT'
      if (nonShell.length > 0) state = cpu > 5 ? 'BUSY' : 'WAITING'

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

    win.webContents.send(CH.metricsTick, { panes, system })
  }
}

function basename(comm: string): string {
  const i = comm.lastIndexOf('/')
  return i >= 0 ? comm.slice(i + 1) : comm
}
