import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PtyManager.kill() on a pane whose shell has ALREADY exited.
 *
 * The kill ladder does not target a process — it targets a process *tree*, and
 * on macOS it finds that tree partly by controlling tty: every process group
 * whose `ps -o tty` matches the pane's recorded ttys number gets
 * SIGHUP → SIGTERM → SIGKILL (platform/darwin.ts, `paneProcessGroups`).
 *
 * A pane's record deliberately outlives its shell, so that tty name is still
 * sitting there after the shell is gone. But the kernel hands `/dev/ttysNNN`
 * slots straight back out once they are free, and the next thing to take that
 * slot is very often the next pane the user opens in this same window. Closing
 * the dead pane then aims the whole ladder at a LIVE pane's process groups —
 * a running agent, killed by tidying up a pane that had already exited.
 *
 * Every other method on PtyManager guards on `rec.exited`. kill() checked only
 * that the record existed.
 */

const killPaneTree = vi.fn(async () => ({ survivors: 0 }))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp' },
}))

vi.mock('node-pty', () => ({
  spawn: () => {
    let onExit: ((e: { exitCode: number; signal?: number }) => void) | null = null
    return {
      pid: 4242,
      ptsName: '/dev/ttys004',
      onData: () => {},
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
        onExit = cb
      },
      write: () => {},
      resize: () => {},
      kill: () => {},
      /** Test hook: run the exit handler the manager registered. */
      __exit: () => onExit?.({ exitCode: 0 }),
    }
  },
}))

vi.mock('../../src/main/platform/index.js', () => ({
  platform: {
    killPaneTree,
    installShellIntegration: () => null,
    loginShell: () => ({ file: '/bin/zsh', args: ['-l'] }),
  },
}))

vi.mock('node:fs', () => ({
  default: { statSync: () => ({ isDirectory: () => true }) },
}))

const { PtyManager } = await import('../../src/main/pty/manager.js')

function spawnPane(mgr: InstanceType<typeof PtyManager>, paneId: string) {
  const res = mgr.spawn({ paneId, file: '/bin/zsh', args: ['-l'], cwd: '/tmp', cols: 80, rows: 24 })
  expect(res.ok).toBe(true)
  // Reach the fake IPty the manager is holding, to drive its exit handler.
  const panes = (mgr as unknown as { panes: Map<string, { proc: { __exit(): void } }> }).panes
  return panes.get(paneId)!.proc
}

describe('PtyManager.kill', () => {
  beforeEach(() => {
    killPaneTree.mockClear()
  })

  it('runs the kill ladder for a live pane', async () => {
    const mgr = new PtyManager(() => null)
    spawnPane(mgr, 'p1')
    const res = await mgr.kill('p1')
    expect(res.ok).toBe(true)
    expect(killPaneTree).toHaveBeenCalledTimes(1)
  })

  it('does not signal anything for a pane whose shell already exited', async () => {
    const mgr = new PtyManager(() => null)
    const proc = spawnPane(mgr, 'p1')
    proc.__exit() // the user typed `exit`; the ttys slot is now free to reuse

    const res = await mgr.kill('p1')

    expect(res.ok).toBe(true)
    // Nothing to kill: the shell is gone, and the recorded pid and tty may
    // both belong to something else by now.
    expect(killPaneTree).not.toHaveBeenCalled()
  })

  it('still forgets the record, so the pane id is reusable', async () => {
    const mgr = new PtyManager(() => null)
    const proc = spawnPane(mgr, 'p1')
    proc.__exit()
    await mgr.kill('p1')
    const panes = (mgr as unknown as { panes: Map<string, unknown> }).panes
    expect(panes.has('p1')).toBe(false)
  })

  it('killAll skips exited panes but still reaps the live ones', async () => {
    const mgr = new PtyManager(() => null)
    const dead = spawnPane(mgr, 'p1')
    spawnPane(mgr, 'p2')
    dead.__exit()
    await mgr.killAll()
    expect(killPaneTree).toHaveBeenCalledTimes(1)
  })
})
