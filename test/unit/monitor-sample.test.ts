import { describe, expect, it } from 'vitest'
import { sampleTick } from '../../src/main/monitor/sample.js'
import type { SystemMetrics } from '../../src/shared/ipc.js'

const SYS: SystemMetrics = {
  usedBytes: 1,
  totalBytes: 2,
  compressorBytes: 0,
  swapUsedBytes: 0,
  swapTotalBytes: 0,
  pressureLevel: 'normal',
}

describe('sampleTick', () => {
  it('still returns the process sweep when system memory cannot be read', async () => {
    // Linux has no /usr/bin/vm_stat. That rejection used to sink the whole
    // tick, so no pane ever learned it was running claude and every pane where
    // claude was typed by hand was saved as a plain shell.
    const out = await sampleTick(
      () => Promise.resolve('  PID  PPID\n'),
      () => Promise.reject(new Error('spawn /usr/bin/vm_stat ENOENT'))
    )
    expect(out).toEqual({ stdout: '  PID  PPID\n', system: null })
  })

  it('passes both through when both work', async () => {
    const out = await sampleTick(
      () => Promise.resolve('x'),
      () => Promise.resolve(SYS)
    )
    expect(out).toEqual({ stdout: 'x', system: SYS })
  })

  it('a failed sweep is an empty sample, not a throw', async () => {
    const out = await sampleTick(
      () => Promise.reject(new Error('ps')),
      () => Promise.resolve(SYS)
    )
    expect(out.stdout).toBe('')
  })
})
