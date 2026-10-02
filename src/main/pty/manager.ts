import { app, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import * as pty from 'node-pty'
import {
  CH,
  DRAWER_PTY_PREFIX,
  MAX_TERM_PANES,
  type PtySpawnRequest,
  type PtySpawnResponse,
  type PtyKillResponse,
} from '../../shared/ipc.js'
import { buildEnv } from './env.js'
import { PtyBatcher, ACTIVE_FLUSH_INTERVAL_MS } from './batcher.js'
import { ptyReadGate, type ReadGate } from './flow.js'
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
  /**
   * The pid the process table knows as this pane's shell. The pty's own child
   * everywhere except win32, where that child is wsl.exe and the real shell is
   * a Linux pid learned later from `platform.paneShell`. Null until known; a
   * pane without it is left out of metrics and session lookup rather than
   * rooted at a Windows pid that means something else inside WSL.
   */
  shellPid: number | null
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
  /**
   * The last TAIL_MAX_CHARS of raw output, kept so control/screen-kind.ts can
   * read the pane's current screen from main's own stream at type time. The
   * renderer's xterm buffer lags this by an IPC hop plus a parse.
   */
  tail: string
}

/** Enough to hold several full ink repaints of claude's input area or a
 *  selector; anything older than that cannot be the current screen. */
const TAIL_MAX_CHARS = 8192

/** How often, and how long, to wait for a launcher-hosted shell to report its
 *  pid (win32). A slow login (big .zshrc, cold WSL) gets about 30 s. */
const SHELL_RESOLVE_INTERVAL_MS = 250
const SHELL_RESOLVE_ATTEMPTS = 120

export class PtyManager {
  private panes = new Map<string, PaneProc>()
  private batcher = new PtyBatcher()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private zdotdir: string | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly gate: ReadGate = ptyReadGate
  ) {
    // The core's stdout is full (flow.ts): stop reading every pty until it drains.
    gate.onChange((held) => {
      for (const rec of this.panes.values()) {
        if (rec.exited) continue
        if (held) rec.proc.pause()
        else rec.proc.resume()
      }
    })
  }

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

    // Panes and drawers are budgeted separately, so an open drawer never costs
    // a pane its shell.
    const isDrawer = req.paneId.startsWith(DRAWER_PTY_PREFIX)
    const liveCount = [...this.panes.values()].filter(
      (p) => !p.exited && p.paneId.startsWith(DRAWER_PTY_PREFIX) === isDrawer
    ).length
    if (liveCount >= MAX_TERM_PANES) {
      const what = isDrawer ? 'drawer shells' : 'panes'
      return { ok: false, code: 'ELIMIT', message: `at most ${MAX_TERM_PANES} ${what}` }
    }

    // Restart: drop the dead record so the pane id is free to be re-spawned.
    if (existing) {
      this.panes.delete(req.paneId)
      this.batcher.removePane(req.paneId)
    }

    const cwd = req.cwd
    // A platform with its own spawn (win32: wsl.exe) validates the cwd itself,
    // because the cwd is a Linux path the Windows side cannot stat directly.
    if (!platform.paneSpawn) {
      try {
        if (!fs.statSync(cwd).isDirectory()) throw new Error('not a dir')
      } catch {
        // Refuse rather than silently landing somewhere unexpected.
        return { ok: false, code: 'ECWD', message: `not a directory: ${cwd}` }
      }
    }

    if (this.zdotdir === null) this.zdotdir = platform.installShellIntegration()

    const env = buildEnv({
      baseEnv: process.env,
      paneId: req.paneId,
      appVersion: app.getVersion(),
      zdotdirShimPath: this.zdotdir ?? '',
    })
    for (const [k, v] of platform.paneEnvExtras?.(req.paneId) ?? []) env[k] = v

    let file: string
    let args: string[]
    let spawnCwd = cwd
    let spawnEnv = env
    if (platform.paneSpawn) {
      const spec = platform.paneSpawn({
        paneId: req.paneId,
        cwd,
        appVersion: app.getVersion(),
        shellIntegration: this.zdotdir,
        env,
      })
      if (!spec.ok) return { ok: false, code: 'ECWD', message: spec.message }
      file = spec.file
      args = spec.args
      spawnCwd = spec.cwd
      spawnEnv = spec.env
    } else {
      const shell = platform.loginShell()
      file = shell.file
      args = shell.args
    }

    let proc: pty.IPty
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cwd: spawnCwd,
        cols: req.cols,
        rows: req.rows,
        env: spawnEnv as Record<string, string>,
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
      shellPid: platform.paneShell ? null : proc.pid,
      exited: false,
      bytesOut: 0,
      tail: '',
    }
    this.panes.set(req.paneId, rec)
    if (this.gate.held) proc.pause()
    if (platform.paneShell) this.resolvePaneShell(rec)
    this.batcher.setPaneActive(req.paneId, true)

    proc.onData((chunk: string | Buffer) => {
      const text =
        typeof chunk === 'string' ? chunk : rec.decoder.write(chunk)
      if (text) {
        rec.bytesOut += text.length
        rec.tail = (rec.tail + text).slice(-TAIL_MAX_CHARS)
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

  /** A live pane's raw output tail, or null — same liveness semantics as
   * paneTty. Input to control/screen-kind.ts. */
  tailOf(paneId: string): string | null {
    const rec = this.panes.get(paneId)
    return rec && !rec.exited ? rec.tail : null
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

  /** Live panes, with the monotonic output counter the monitor diffs. The
   *  pid is the shell as the process sweep sees it (see `shellPid`). */
  listPids(): Array<{ paneId: string; pid: number; bytesOut: number }> {
    const out: Array<{ paneId: string; pid: number; bytesOut: number }> = []
    for (const r of this.panes.values()) {
      if (!r.exited && r.shellPid !== null) out.push({ paneId: r.paneId, pid: r.shellPid, bytesOut: r.bytesOut })
    }
    return out
  }

  /**
   * Polls `platform.paneShell` until the pane's shell has reported its pid and
   * tty (the WSL shim writes them as zsh starts), or the pane goes away, or
   * the shell never reports (bash ignores the shim): then the pane simply has
   * no metrics and its control-socket writes are refused, as for any pane
   * whose tty is unknown.
   */
  private resolvePaneShell(rec: PaneProc, attempt = 0): void {
    const lookup = platform.paneShell
    if (!lookup || rec.exited || this.panes.get(rec.paneId) !== rec) return
    if (attempt >= SHELL_RESOLVE_ATTEMPTS) return
    setTimeout(() => {
      if (rec.exited || this.panes.get(rec.paneId) !== rec) return
      lookup(rec.paneId).then(
        (found) => {
          if (found) {
            rec.shellPid = found.pid
            rec.ttyName = found.tty
          } else {
            this.resolvePaneShell(rec, attempt + 1)
          }
        },
        () => this.resolvePaneShell(rec, attempt + 1)
      )
    }, SHELL_RESOLVE_INTERVAL_MS)
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

    /**
     * A pane whose shell has already exited gets no ladder — only cleanup.
     *
     * The ladder does not target a process, it targets a process TREE, and it
     * finds part of that tree by controlling tty: on macOS every process group
     * whose tty matches the pane's recorded ttys number is signalled (see
     * platform/darwin.ts, `paneProcessGroups`). A pane's record deliberately
     * outlives its shell — spawn() explains why — so that tty name is still
     * here after the shell is gone.
     *
     * But the kernel hands `/dev/ttysNNN` slots back out as soon as they are
     * free, and the next taker is very often the next pane opened in this same
     * window. Closing an already-exited pane would then aim SIGHUP → SIGTERM →
     * SIGKILL at a LIVE pane's process groups: a running agent killed by
     * tidying up a pane that had already quit. The recorded pid is recyclable
     * for the same reason.
     *
     * Nothing is lost by skipping it. The kernel SIGHUPs the foreground group
     * when the controlling terminal's last descriptor closes, so the ordinary
     * children are already gone; what survives that is something the user
     * explicitly detached, which was never this function's to kill — and it
     * can no longer be identified, only guessed at from two recycled numbers.
     */
    if (rec.exited) {
      this.panes.delete(paneId)
      this.batcher.removePane(paneId)
      if (this.panes.size === 0) this.stopFlushLoop()
      return { ok: true, survivors: 0 }
    }

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
