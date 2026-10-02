import type { SystemMetrics } from '../../shared/ipc.js'

/**
 * One tick's raw samples, taken together but failing apart. [pure]
 *
 * The two samplers answer different questions. The process sweep is what
 * tells each pane what it is running (and so whether a pane is saved as
 * claude); system memory only feeds the status bar. A `Promise.all` over both
 * let the second sink the first: on Linux `/usr/bin/vm_stat` does not exist,
 * every tick rejected, and no pane metrics were ever sent.
 */
export async function sampleTick(
  sweep: () => Promise<string>,
  system: () => Promise<SystemMetrics>
): Promise<{ stdout: string; system: SystemMetrics | null }> {
  const [s, m] = await Promise.allSettled([sweep(), system()])
  return {
    stdout: s.status === 'fulfilled' ? s.value : '',
    system: m.status === 'fulfilled' ? m.value : null,
  }
}
