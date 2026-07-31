import type { SystemMetrics } from '../../shared/ipc.js'
import type { TabState } from '../store.js'

export interface StatusBarProps {
  tab: TabState | undefined
  system: SystemMetrics | null
}

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** Panes idling at a shell use single-digit megabytes; "0.0 GB" tells you nothing. */
function mem(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}

/**
 * Surfaces what the panes are costing.
 *
 * The pane total is a sum of per-process RSS, which double-counts memory shared
 * between processes — so it is shown with a "~" and labelled as a sum, never as
 * an authoritative footprint. The system figures beside it are the ones that
 * actually tell you whether the machine is in trouble.
 */
export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const panes = props.tab ? Object.values(props.tab.panes) : []
  const paneTotal = panes.reduce((acc, p) => acc + (p.metrics?.footprintBytes ?? 0), 0)
  const sys = props.system

  const pressureClass =
    sys?.pressureLevel === 'critical'
      ? 'statusbar__crit'
      : sys?.pressureLevel === 'warn'
        ? 'statusbar__warn'
        : ''

  return (
    <div className="statusbar">
      <span>
        {panes.length} pane{panes.length === 1 ? '' : 's'}
      </span>
      {paneTotal > 0 && (
        <>
          <span className="statusbar__sep">·</span>
          <span title="Sum of per-process RSS across each pane's process tree. Double-counts shared memory, so treat it as an upper bound.">
            ~{mem(paneTotal)} in panes
          </span>
        </>
      )}
      {sys && (
        <>
          <span className="statusbar__sep">·</span>
          <span className={pressureClass}>
            {gb(sys.usedBytes)}/{gb(sys.totalBytes)} used
          </span>
          {sys.compressorBytes > 0 && (
            <>
              <span className="statusbar__sep">·</span>
              <span>compressed {gb(sys.compressorBytes)}</span>
            </>
          )}
          {sys.swapUsedBytes > 0 && (
            <>
              <span className="statusbar__sep">·</span>
              <span className={sys.swapUsedBytes > 2 * 1024 ** 3 ? 'statusbar__warn' : ''}>
                swap {gb(sys.swapUsedBytes)}
              </span>
            </>
          )}
        </>
      )}
      <span className="statusbar__hint">⌘D pane · ⌘T tab · ⌘↩ zoom · ⌘B explorer</span>
    </div>
  )
}
