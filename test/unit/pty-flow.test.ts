import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ReadGate, gatedWriter } from '../../src/main/pty/flow.js'

/**
 * Review Focus 2: when the core's stdout stops taking bytes, every pty's reads
 * pause until 'drain', so a flooding pane blocks in the kernel instead of
 * growing the core.
 */

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp' },
}))

const procs: Array<{ paused: boolean; pauses: number; resumes: number }> = []
vi.mock('node-pty', () => ({
  spawn: () => {
    const p = {
      pid: 4242,
      ptsName: '/dev/pts/4',
      paused: false,
      pauses: 0,
      resumes: 0,
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
      pause() {
        p.paused = true
        p.pauses++
      },
      resume() {
        p.paused = false
        p.resumes++
      },
    }
    procs.push(p)
    return p
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

/** A pipe whose write returns false while `full`, and emits 'drain' on demand. */
class FakePipe extends EventEmitter {
  full = false
  lines: string[] = []
  write(chunk: string): boolean {
    this.lines.push(chunk)
    return !this.full
  }
}

describe('gatedWriter', () => {
  it('holds the gate when a write returns false and releases it on drain, without dropping a line', () => {
    const gate = new ReadGate()
    const seen: boolean[] = []
    gate.onChange((h) => seen.push(h))
    const pipe = new FakePipe()
    const write = gatedWriter(pipe, gate)
    write('a\n')
    expect(gate.held).toBe(false)
    pipe.full = true
    write('b\n')
    write('c\n')
    expect(gate.held).toBe(true)
    expect(pipe.listenerCount('drain')).toBe(1)
    pipe.full = false
    pipe.emit('drain')
    expect(gate.held).toBe(false)
    expect(seen).toEqual([true, false])
    expect(pipe.lines).toEqual(['a\n', 'b\n', 'c\n'])
    expect(pipe.listenerCount('drain')).toBe(0)
  })
})

describe('PtyManager under pipe backpressure', () => {
  it('pauses every live pty while the gate is held, resumes them on release, and starts a new pty paused', () => {
    procs.length = 0
    const gate = new ReadGate()
    const mgr = new PtyManager(() => null, gate)
    const req = (paneId: string) => ({ paneId, file: '/bin/zsh', args: ['-l'], cwd: '/tmp', cols: 80, rows: 24 })
    expect(mgr.spawn(req('a')).ok).toBe(true)
    expect(mgr.spawn(req('b')).ok).toBe(true)
    gate.hold()
    expect(procs.map((p) => p.paused)).toEqual([true, true])
    expect(mgr.spawn(req('c')).ok).toBe(true)
    expect(procs[2]!.paused).toBe(true)
    gate.release()
    expect(procs.map((p) => p.paused)).toEqual([false, false, false])
    expect(procs.map((p) => p.pauses)).toEqual([1, 1, 1])
  })
})
