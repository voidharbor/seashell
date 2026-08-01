import { app, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import * as pty from 'node-pty'
import { CH, type PtySpawnRequest, type PtySpawnResponse, type PtyKillResponse } from '../../shared/ipc.js'
import { buildEnv } from './env.js'
import { PtyBatcher, ACTIVE_FLUSH_INTERVAL_MS } from './batcher.js'
import { platform } from '../platform/index.js'

interface PaneProc {
  paneId: string
  proc: pty.IPty
  /**
   * Decodes across chunk boundaries. A naive Buffer.toString('utf8') per chunk
   * would mangle any multi-byte character split across two reads, which shows
   * up as replacement characters in the middle of box-drawing borders.
   */
  decoder: StringDecoder
  spawnedAt: number
  /**
   * The pane's controlling terminal, e.g. `ttys004`. Used at kill time to find
   * double-forked descendants that the parent-pid walk cannot reach.
   */
  ttyName: string | null
  exited: boolean
  /**
   * Bytes this pane has written to its terminal since it spawned, monotonic.
   *
   * Read by the monitor, which diffs it between sweeps to tell a pane that has
   * genuinely gone still from one that is quietly animating a spinner. CPU
   * alone cannot separate those, and that confusion is what made every idle
   * agent pane glow. See monitor/activity.ts.
   */
  bytesOut: number
}

const MAX_PANES = 24

export class PtyManager {
  private panes = new Map<string, PaneProc>()
  private batcher = new PtyBatcher()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private zdotdir: string | null = null

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /**
   * The flush loop exists only while there is something to flush.
   *
   * It used to be armed by the first spawn and cleared only by the last close,
   * which meant an 8ms interval — 125 wakeups a second — ran in the main
   * process for the entire life of the app, whether or not any pane had
   * produced a byte. A terminal doing nothing should cost nothing, so the loop
   * is now started by arriving data and stops itself the moment the buffers are
   * empty. Latency is unchanged: a chunk still waits at most one interval.
   */
  private ensureFlushLoop(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => {
      if (this.batcher.shouldFlush(Date.now())) {
        const event = this.batcher.flush()
        if (event && event.batches.length > 0) {
          this.getWindow()?.webContents.send(CH.ptyData, event)
        }
      }
      if (!this.batcher.hasPending()) this.stopFlushLoop()
    }, ACTIVE_FLUSH_INTERVAL_MS)
  }

  private stopFlushLoop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
  }

  /**
   * Every pane is rooted at `/bin/zsh -l`, never at the target program.
   *
   * That uniformity buys a lot: the shell is a session leader, the user's
   * dotfiles are sourced (which is how tools get on PATH), history works, and
   * when the program exits you are left at a live shell instead of a dead pane.
   * The "+" menu's `claude` entry just types `claude\r` into stdin.
   */
  spawn(req: PtySpawnRequest): PtySpawnResponse {
    /**
     * An exited pane still holds its record — deliberately, because `kill()`
     * needs the recorded tty name to find descendants that outlived the shell.
     * But it must not count against the cap or block a restart, or a session
     * that opens and exits panes slowly runs out of panes that do not exist.
     */
    const existing = this.panes.get(req.paneId)
    if (existing && !existing.exited) {
      return { ok: false, code: 'ELIMIT', message: 'pane already has a pty' }
    }

    const liveCount = [...this.panes.values()].filter((p) => !p.exited).length
    if (liveCount >= MAX_PANES) {
      return { ok: false, code: 'ELIMIT', message: `at most ${MAX_PANES} panes` }
    }

    // Restart: drop the dead record so the pane id is free to be re-spawned.
    if (existing) {
      this.panes.delete(req.paneId)
      this.batcher.removePane(req.paneId)
    }

    let cwd = req.cwd
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a dir')
    } catch {
      // Refuse rather than silently landing somewhere unexpected.
      return { ok: false, code: 'ECWD', message: `not a directory: ${cwd}` }
    }

    if (this.zdotdir === null) this.zdotdir = platform.installShellIntegration()

    const env = buildEnv({
      baseEnv: process.env,
      paneId: req.paneId,
      appVersion: app.getVersion(),
      zdotdirShimPath: this.zdotdir ?? '',
    })

    const shell = platform.loginShell()
    let proc: pty.IPty
    try {
      proc = pty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cwd,
        cols: req.cols,
        rows: req.rows,
        env: env as Record<string, string>,
        handleFlowControl: false,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = /EACCES/.test(msg) ? 'EACCES' : 'ENOENT'
      return { ok: false, code, message: msg }
    }

    // e.g. "/dev/ttys004" -> "ttys004", which is the form `ps -o tty` prints.
    let ttyName: string | null = null
    const ptsName = (proc as unknown as { ptsName?: string }).ptsName
    if (typeof ptsName === 'string' && ptsName.length > 0) {
      ttyName = ptsName.replace(/^\/dev\//, '')
    }

    const rec: PaneProc = {
      paneId: req.paneId,
      proc,
      decoder: new StringDecoder('utf8'),
      spawnedAt: Date.now(),
      ttyName,
      exited: false,
      bytesOut: 0,
    }
    this.panes.set(req.paneId, rec)
    this.batcher.setPaneActive(req.paneId, true)

    proc.onData((chunk: string | Buffer) => {
      const text =
        typeof chunk === 'string' ? chunk : rec.decoder.write(chunk)
      if (text) {
        rec.bytesOut += text.length
        this.batcher.push(req.paneId, text, Date.now())
        this.ensureFlushLoop()
      }
    })

    proc.onExit(({ exitCode, signal }) => {
      rec.exited = true
      // Flush whatever the program printed on its way out before reporting exit.
      const pending = this.batcher.flush()
      if (pending && pending.batches.length) {
        this.getWindow()?.webContents.send(CH.ptyData, pending)
      }
      this.getWindow()?.webContents.send(CH.ptyExit, {
        paneId: req.paneId,
        exitCode,
        signal: signal ?? null,
        ranMs: Date.now() - rec.spawnedAt,
      })
    })

    return { ok: true, pid: proc.pid }
  }

  write(paneId: string, data: string): void {
    const rec = this.panes.get(paneId)
    if (rec && !rec.exited) rec.proc.write(data)
  }

  /** Like write(), but reports whether the pane was live — the control socket
   * must refuse loudly rather than drop text on the floor. */
  writeIfLive(paneId: string, data: string): boolean {
    const rec = this.panes.get(paneId)
    if (!rec || rec.exited) return false
    rec.proc.write(data)
    return true
  }

  /** A live pane's controlling tty, or null. A pane whose tty was never
   * resolved also returns null: the control socket cannot run its foreground
   * check there, and unverifiable must mean refused. */
  paneTty(paneId: string): string | null {
    const rec = this.panes.get(paneId)
    return rec && !rec.exited ? rec.ttyName : null
  }

  /** A live pane's monotonic output-byte counter, or null. Lets CardStore
   * tell "gone" from "quiet" the same way the monitor does — see bytesOut. */
  bytesOutOf(paneId: string): number | null {
    const rec = this.panes.get(paneId)
    return rec && !rec.exited ? rec.bytesOut : null
  }

  resize(paneId: string, cols: number, rows: number): void {
    const rec = this.panes.get(paneId)
    if (!rec || rec.exited) return
    try {
      rec.proc.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      /* pty already gone */
    }
  }

  /** Live panes, with the monotonic output counter the monitor diffs. */
  listPids(): Array<{ paneId: string; pid: number; bytesOut: number }> {
    return [...this.panes.values()]
      .filter((r) => !r.exited)
      .map((r) => ({ paneId: r.paneId, pid: r.proc.pid, bytesOut: r.bytesOut }))
  }

  /**
   * Ends a pane and everything it started.
   *
   * The ladder itself belongs to the platform — on macOS it is an escalating
   * SIGHUP → SIGTERM → SIGKILL across every process group the pane touched,
   * because `IPty.kill()` signals the positive pid only and leaves disowned
   * grandchildren alive reparented to launchd. None of that exists on Windows.
   * See `platform/darwin.ts` and the warnings in `platform/win32.ts`.
   */
  async kill(paneId: string): Promise<PtyKillResponse> {
    const rec = this.panes.get(paneId)
    if (!rec) return { ok: true, survivors: 0 }

    const { survivors } = await platform.killPaneTree({
      shellPid: rec.proc.pid,
      ttyName: rec.ttyName,
      killPty: () => rec.proc.kill(),
    })

    this.panes.delete(paneId)
    this.batcher.removePane(paneId)
    if (this.panes.size === 0) this.stopFlushLoop()

    // Never pretend the pane is clean when it isn't.
    return { ok: survivors === 0, survivors }
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.panes.keys()].map((id) => this.kill(id)))
  }
}
