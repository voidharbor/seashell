/**
 * The status bar's strings, formatted as `src/renderer/status/StatusBar.tsx`
 * draws them. The functions there live inside a React component module that
 * reads `window` through `platform.ts`, so they are copied here; the chord
 * spelling comes from `src/shared/keys.ts` with the platform passed in.
 */
import type { SystemMetrics } from '../../shared/ipc.js'
import { chordLabel, keyPlatform, zoomLabel } from '../../shared/keys.js'
import type { TabState } from '../../renderer/store.js'
import type { UiModel } from './model.js'

export type StatusModel = UiModel['status']

/** `StatusBar.tsx` gb(). */
export function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** `StatusBar.tsx` mem(), also `PaneView.tsx:571-574` formatBytes(): small figures in MB. */
export function mem(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}

/** Swap past this is shown as a warning (`StatusBar.tsx`). */
const SWAP_WARN_BYTES = 2 * 1024 ** 3

/** The shortcut hint at the right of the bar, in this platform's spelling. */
export function statusHint(platform: string): string {
  if (keyPlatform(platform) === 'darwin') {
    return '⌘D pane · ⌘T tab · ⌘=/- zoom · ⌘+/_ pane zoom · ⌘↩ full screen'
  }
  const k = (mac: string): string => chordLabel(mac, platform)
  // `platform.ts` paneZoomIn for every platform but the Mac.
  const paneZoomIn = 'Ctrl+Shift+='
  return `${k('Cmd+D')} pane · ${k('Cmd+T')} tab · ${zoomLabel('=', platform)}/- zoom · ${paneZoomIn}/- pane zoom · ${k('Cmd+Return')} full screen`
}

/**
 * The bar for the active tab. The pane total is a sum of per-process RSS and
 * double-counts shared memory, so it carries a "~" exactly as the renderer's.
 */
export function statusModel(tab: TabState | undefined, sys: SystemMetrics | null, platform: string): StatusModel {
  const panes = tab ? Object.values(tab.panes) : []
  const paneTotal = panes.reduce((acc, p) => acc + (p.metrics?.footprintBytes ?? 0), 0)
  return {
    panes: `${panes.length} pane${panes.length === 1 ? '' : 's'}`,
    inPanes: paneTotal > 0 ? `~${mem(paneTotal)} in panes` : '',
    used: sys ? `${gb(sys.usedBytes)}/${gb(sys.totalBytes)} used` : '',
    usedLevel: sys?.pressureLevel === 'critical' ? 'crit' : sys?.pressureLevel === 'warn' ? 'warn' : 'ok',
    compressed: sys && sys.compressorBytes > 0 ? `compressed ${gb(sys.compressorBytes)}` : null,
    swap: sys && sys.swapUsedBytes > 0 ? `swap ${gb(sys.swapUsedBytes)}` : null,
    swapWarn: sys !== null && sys.swapUsedBytes > SWAP_WARN_BYTES,
    hint: statusHint(platform),
  }
}
