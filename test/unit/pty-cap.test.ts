import { describe, expect, it, vi } from 'vitest'
import { DRAWER_PTY_PREFIX, MAX_TERM_PANES } from '../../src/shared/ipc.js'

/**
 * The global pane cap in PtyManager.spawn: live terminal panes across every
 * tab, with drawer shells on a budget of their own and exited panes counting
 * against neither.
 */

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
    killPaneTree: async () => ({ survivors: 0 }),
    installShellIntegration: () => null,
    loginShell: () => ({ file: '/bin/zsh', args: ['-l'] }),
  },
}))

vi.mock('node:fs', () => ({
  default: { statSync: () => ({ isDirectory: () => true }) },
}))

const { PtyManager } = await import('../../src/main/pty/manager.js')

type Mgr = InstanceType<typeof PtyManager>

function spawn(mgr: Mgr, paneId: string) {
  return mgr.spawn({ paneId, file: '/bin/zsh', args: ['-l'], cwd: '/tmp', cols: 80, rows: 24 })
}

function fill(mgr: Mgr, n: number, prefix = 'p') {
  for (let i = 0; i < n; i++) expect(spawn(mgr, `${prefix}${i}`).ok).toBe(true)
}

function exit(mgr: Mgr, paneId: string) {
  const panes = (mgr as unknown as { panes: Map<string, { proc: { __exit(): void } }> }).panes
  panes.get(paneId)!.proc.__exit()
}

describe('PtyManager global pane cap', () => {
  it('is well past the old 24', () => {
    expect(MAX_TERM_PANES).toBe(64)
  })

  it('spawns up to the cap and refuses the next one', () => {
    const mgr = new PtyManager(() => null)
    fill(mgr, MAX_TERM_PANES)
    const res = spawn(mgr, 'one-too-many')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('ELIMIT')
      expect(res.message).toBe(`at most ${MAX_TERM_PANES} panes`)
    }
  })

  it('does not count an exited pane', () => {
    const mgr = new PtyManager(() => null)
    fill(mgr, MAX_TERM_PANES)
    exit(mgr, 'p0')
    expect(spawn(mgr, 'replacement').ok).toBe(true)
  })

  it('does not charge drawer shells to the pane budget', () => {
    const mgr = new PtyManager(() => null)
    fill(mgr, MAX_TERM_PANES)
    expect(spawn(mgr, `${DRAWER_PTY_PREFIX}p0`).ok).toBe(true)
  })

  it('does not let drawers use up the pane budget', () => {
    const mgr = new PtyManager(() => null)
    fill(mgr, MAX_TERM_PANES, DRAWER_PTY_PREFIX)
    expect(spawn(mgr, 'p0').ok).toBe(true)
  })

  it('still caps drawer shells on their own budget', () => {
    const mgr = new PtyManager(() => null)
    fill(mgr, MAX_TERM_PANES, DRAWER_PTY_PREFIX)
    const res = spawn(mgr, `${DRAWER_PTY_PREFIX}extra`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toBe(`at most ${MAX_TERM_PANES} drawer shells`)
  })
})
