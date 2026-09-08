import { describe, expect, it } from 'vitest'
import { openPath, type OpenDeps } from '../../src/renderer/explorer/open.js'

function deps(route: string, over: Partial<OpenDeps> = {}): OpenDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    probe: async () => ({ exists: true, isDir: false, size: 1, ext: '.ts', route: route as never }),
    withDefaultApp: async () => {
      calls.push('os')
      return { ok: true }
    },
    revealInFinder: async () => {
      calls.push('finder')
      return { ok: true }
    },
    onOpenInViewer: (p) => calls.push(`viewer:${p}`),
    onToast: (m) => calls.push(`toast:${m}`),
    ...over,
  }
}

describe('openPath', () => {
  it('routes viewer files to the in-app viewer', async () => {
    const d = deps('viewer')
    await openPath('/a/b.ts', d)
    expect(d.calls).toEqual(['viewer:/a/b.ts'])
  })
  it('routes os files to the default app and toasts a refused executable', async () => {
    const d = deps('os', { withDefaultApp: async () => ({ ok: false, error: 'refused-executable' }) })
    await openPath('/a/run', d)
    expect(d.calls).toEqual(['toast:That file is executable, revealed in Finder instead'])
  })
  it('forces the OS route when asked', async () => {
    const d = deps('viewer')
    await openPath('/a/b.ts', d, 'os')
    expect(d.calls).toEqual(['os'])
  })
})
