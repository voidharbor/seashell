import { psSweep, psSweepMemory, type KillRow } from '../monitor/procsweep.js'
import { ensureZdotdirShim } from '../pty/zdotdir.js'
import type { KillRequest, KillResult, Platform, ShellSpec } from './types.js'

/**
 * macOS. The behaviour SeaShell was built against, moved behind the seam
 * unchanged — this file is a relocation, not a rewrite.
 */

const KILL_GRACE_MS = 1500

const TERMINAL_FONT =
  '/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts/SFMono-Terminal.ttf'

export const darwin: Platform = {
  id: 'darwin',

  capabilities: {
    verifiedKill: true,
    processMetrics: true,
    cwdReporting: true,
  },

  /**
   * Every pane is rooted at `/bin/zsh -l`, never at the target program.
   *
   * That uniformity buys a lot: the shell is a session leader, the user's
   * dotfiles are sourced (which is how tools get on PATH), history works, and
   * when the program exits you are left at a live shell instead of a dead pane.
   */
  loginShell(): ShellSpec {
    return { file: '/bin/zsh', args: ['-l'] }
  },

  installShellIntegration(): string | null {
    return ensureZdotdirShim()
  },

  sweepMemory(): Promise<string> {
    return psSweepMemory()
  },

  sweepForKill(): Promise<KillRow[]> {
    return psSweep()
  },

  /**
   * The escalating kill ladder.
   *
   * `IPty.kill()` is NOT the shutdown path: it signals the positive pid only,
   * and leaves disowned grandchildren alive reparented to launchd. Interactive
   * zsh also ignores SIGTERM, and zsh job control puts each foreground job in
   * its own process group — so signalling only the shell's group misses the job.
   *
   * Orphaned agent processes are exactly the failure this app exists to make
   * visible, so leaving one behind on close would be self-defeating.
   */
  async killPaneTree(req: KillRequest): Promise<KillResult> {
    const { shellPid, ttyName } = req
    const groups = await paneProcessGroups(shellPid, ttyName)

    // 1. SIGHUP the shell: zsh HUPs its own job table and programs can save state.
    trySignal(shellPid, 'SIGHUP')
    await delay(KILL_GRACE_MS)

    // 2. SIGTERM every process group the pane touched.
    if (await anyAlive(shellPid, ttyName)) {
      for (const pgid of groups) trySignal(-pgid, 'SIGTERM')
      await delay(KILL_GRACE_MS)
    }

    // 3. SIGKILL the groups, then re-sweep for stragglers.
    let survivors = 0
    if (await anyAlive(shellPid, ttyName)) {
      for (const pgid of groups) trySignal(-pgid, 'SIGKILL')
      await delay(300)
      const left = await paneProcessGroups(shellPid, ttyName)
      for (const pgid of left) trySignal(-pgid, 'SIGKILL')
      await delay(200)
      survivors = (await paneProcessGroups(shellPid, ttyName)).length
    }

    try {
      req.killPty()
    } catch {
      /* already gone */
    }

    return { survivors }
  },

  terminalFontPath(): string | null {
    return TERMINAL_FONT
  },
}

/**
 * Process groups belonging to a pane: the ppid subtree rooted at the shell,
 * plus anything sharing the pane's controlling tty. The tty arm is
 * load-bearing — it catches double-forked descendants the ppid walk misses.
 */
async function paneProcessGroups(shellPid: number, ttyName: string | null): Promise<number[]> {
  const rows = await psSweep()
  const groups = new Set<number>()

  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const children = new Map<number, number[]>()
  for (const r of rows) {
    const list = children.get(r.ppid) ?? []
    list.push(r.pid)
    children.set(r.ppid, list)
  }

  const seen = new Set<number>()
  const walk = (pid: number): void => {
    if (seen.has(pid)) return // defensive: a cycle must not hang shutdown
    seen.add(pid)
    const row = byPid.get(pid)
    if (row) groups.add(row.pgid)
    for (const c of children.get(pid) ?? []) walk(c)
  }
  walk(shellPid)

  // The tty arm catches double-forked descendants the ppid walk misses.
  // A process that ALSO detaches its controlling terminal stays unreachable —
  // that residual gap is reported as survivors rather than hidden.
  if (ttyName) {
    for (const r of rows) if (r.tty === ttyName) groups.add(r.pgid)
  }

  groups.delete(0)
  return [...groups]
}

async function anyAlive(shellPid: number, ttyName: string | null): Promise<boolean> {
  if (isAlive(shellPid)) return true
  return (await paneProcessGroups(shellPid, ttyName)).length > 0
}

function trySignal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {
    /* already dead, or not ours */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
