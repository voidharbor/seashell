import type { FsProbeResponse, OpenPathResponse } from '../../shared/ipc.js'

export interface OpenDeps {
  probe: (req: { path: string }) => Promise<FsProbeResponse>
  withDefaultApp: (req: { path: string }) => Promise<OpenPathResponse>
  revealInFinder: (req: { path: string }) => Promise<OpenPathResponse>
  onOpenInViewer: (path: string) => void
  onToast: (message: string) => void
}

/**
 * Opens a file the way the explorer does: main decides the route, the
 * renderer obeys it. `force: 'os'` skips the route and hands the file to the
 * default app (Cmd+Opt+double-click on a path).
 */
export async function openPath(fullPath: string, deps: OpenDeps, force?: 'os'): Promise<void> {
  const probe = await deps.probe({ path: fullPath })
  if (!probe.exists) {
    deps.onToast('File no longer exists')
    return
  }
  if (probe.isDir) return
  const route = force ?? probe.route
  switch (route) {
    case 'viewer':
      deps.onOpenInViewer(fullPath)
      return
    case 'os': {
      const res = await deps.withDefaultApp({ path: fullPath })
      if (!res.ok && res.error === 'refused-executable') {
        deps.onToast('That file is executable, revealed in Finder instead')
      } else if (!res.ok) {
        deps.onToast(`Could not open: ${res.error ?? 'unknown error'}`)
      }
      return
    }
    case 'too-large':
      deps.onToast('Too large to preview, opening with the default app')
      await deps.withDefaultApp({ path: fullPath })
      return
    case 'binary':
    case 'reveal':
      await deps.revealInFinder({ path: fullPath })
      return
  }
}
