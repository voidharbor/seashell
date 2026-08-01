import path from 'node:path'
import type { KillRow } from '../monitor/procsweep.js'
import { notSupported, type KillRequest, type KillResult, type Platform, type ShellSpec } from './types.js'

/**
 * Windows.
 *
 * READ THIS BEFORE TRUSTING ANY OF IT: **not one line of this file has ever
 * been executed.** It was written on a Mac, against a seam extracted the same
 * night, and macOS cannot run it. Typecheck is the only gate that has been
 * applied. Treat every behaviour here as a claim, not a result.
 *
 * What is genuinely settled:
 *  - node-pty ships `win32-x64` and `win32-arm64` prebuilds, so the PTY layer
 *    needs no Windows toolchain and ConPTY is reached through the same API.
 *  - PowerShell is a real login-ish shell at a known path.
 *
 * What is honestly missing, and is why `capabilities` says so out loud rather
 * than letting the app assume parity:
 *
 *  - **The kill ladder does not exist here.** macOS escalates SIGHUP → SIGTERM
 *    → SIGKILL across every process group the pane touched, then re-sweeps and
 *    reports what survived. Windows has neither signals nor process groups; the
 *    equivalent is a Job Object, which node-pty does not expose. Closing the
 *    pseudoconsole does terminate ordinary children, but a detached process
 *    survives and nothing here can count it. `verifiedKill: false` is the
 *    truthful statement of that, and orphaned agent processes are precisely the
 *    failure SeaShell exists to prevent — so this is the gap that matters most.
 *
 *  - **No process metrics.** The monitor's parser is fed `ps` output. Windows
 *    has no `ps`; `tasklist` reports no parent pid and no CPU, and the richer
 *    sources are a WMI/CIM query whose output would have to be reshaped into
 *    the same columns. Returning an empty sweep degrades cleanly — the monitor
 *    already treats an empty sample as "no data this tick" — so panes work and
 *    the memory figures are simply absent, rather than wrong.
 *
 *  - **No working-directory reporting.** The cwd hook is a ZDOTDIR shim, which
 *    is a zsh concept. The PowerShell equivalent is a prompt function emitting
 *    the same OSC 7, and it is not written. Double-clicking a relative path in
 *    terminal output resolves against the pane's spawn directory rather than
 *    where the shell actually is.
 *
 *  - **No terminal font.** The face is read out of Terminal.app's bundle.
 */

function powershell(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export const win32: Platform = {
  id: 'win32',

  capabilities: {
    verifiedKill: false,
    processMetrics: false,
    cwdReporting: false,
  },

  /**
   * `-NoLogo` only. Deliberately not `-NoProfile`: the macOS side spawns a
   * *login* shell precisely so the user's own configuration runs and their
   * tools are on PATH, and skipping the profile here would quietly break the
   * same thing for the same reason.
   */
  loginShell(): ShellSpec {
    return { file: powershell(), args: ['-NoLogo'] }
  },

  installShellIntegration(): string | null {
    return null
  },

  sweepMemory(): Promise<string> {
    // Empty is the honest answer, and the monitor already handles it as "no
    // sample". Inventing plausible numbers would be worse than showing none.
    return Promise.resolve('')
  },

  sweepForKill(): Promise<KillRow[]> {
    // Nothing calls this on Windows — killPaneTree cannot use a process-group
    // walk. It throws rather than returning [] so that a future caller finds
    // out immediately instead of silently reaping nothing.
    return Promise.reject(notSupported('process-group sweeping', 'win32'))
  },

  /**
   * Closes the pseudoconsole and hopes. See the header: this is not a ladder
   * and it cannot verify itself.
   *
   * `survivors: 0` here means "none counted", not "none exist" — the count is
   * unavailable, which `capabilities.verifiedKill: false` is the flag for.
   */
  async killPaneTree(req: KillRequest): Promise<KillResult> {
    try {
      req.killPty()
    } catch {
      /* already gone */
    }
    return Promise.resolve({ survivors: 0 })
  },

  terminalFontPath(): string | null {
    return null
  },
}
