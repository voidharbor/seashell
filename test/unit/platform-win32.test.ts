import { describe, expect, it } from 'vitest'
import { win32 } from '../../src/main/platform/win32.js'

/**
 * The Windows platform has never been executed — it was written on a Mac and
 * macOS cannot run it. What *can* be checked here, and is worth checking, is
 * that its gaps are declared rather than silently papered over: a build that
 * launches and quietly leaks every process it started is worse than no build.
 *
 * Only `win32.ts` is exercised. `darwin.ts` reaches Electron through the
 * ZDOTDIR shim and cannot be imported into a bare node test.
 */
describe('the win32 platform states its own limits', () => {
  it('does not claim a kill it cannot verify', () => {
    // Windows has no signals and no process groups; the equivalent is a Job
    // Object, which node-pty does not expose. Claiming otherwise would hide
    // exactly the orphaned-agent failure SeaShell exists to prevent.
    expect(win32.capabilities.verifiedKill).toBe(false)
  })

  it('claims metrics and cwd reporting, which now come from inside WSL', () => {
    // The sweep is `wsl.exe -e ps` and the shim reports OSC 7 from the Linux
    // shell; win32-sweep.test.ts covers both.
    expect(win32.capabilities.processMetrics).toBe(true)
    expect(win32.capabilities.cwdReporting).toBe(true)
  })

  it('roots a pane at wsl.exe running the Linux login shell, never PowerShell', () => {
    const shell = win32.loginShell()
    expect(shell.file.toLowerCase()).toContain('wsl.exe')
    expect(shell.file.toLowerCase()).not.toContain('powershell')
    // An argv array, never a command line.
    expect(Array.isArray(shell.args)).toBe(true)
    // A login shell, so the user's own configuration puts their tools on PATH.
    expect(shell.args[shell.args.length - 1]).toBe('-l')
  })

  it('reports no sample rather than inventing numbers', async () => {
    // The monitor already treats an empty sweep as "no data this tick", so
    // panes keep working and the figures are simply absent.
    await expect(win32.sweepMemory()).resolves.toBe('')
  })

  it('refuses the process-group sweep loudly instead of reaping nothing', async () => {
    // Returning [] would look like "no processes to clean up".
    await expect(win32.sweepForKill()).rejects.toThrow(/not supported on win32/)
  })

  it('has no terminal font to offer', () => {
    // Terminal.app's private face is a macOS path; the renderer falls back.
    expect(win32.terminalFontPath()).toBeNull()
  })

  it('still closes the pseudoconsole when a pane is killed', async () => {
    let closed = false
    const res = await win32.killPaneTree({
      shellPid: 1234,
      ttyName: null,
      killPty: () => {
        closed = true
      },
    })
    expect(closed).toBe(true)
    // Zero counted, which is not the same as zero existing — see verifiedKill.
    expect(res.survivors).toBe(0)
  })

  it('does not let a failing pty kill take the close path down', async () => {
    await expect(
      win32.killPaneTree({
        shellPid: 1,
        ttyName: null,
        killPty: () => {
          throw new Error('already gone')
        },
      })
    ).resolves.toEqual({ survivors: 0 })
  })
})
