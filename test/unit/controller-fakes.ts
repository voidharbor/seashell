/**
 * Fake controller deps shared by the controller tests. Kept out of the
 * `*.test.ts` files so importing it never re-registers another file's tests.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import type { ControllerDeps } from '../../src/core/controller/controller.js'
import type { GridCmd, UiModel } from '../../src/core/controller/model.js'

/**
 * A userData of each fake's own, seeded with a `ui-state.json` that says the
 * tutorial was seen, so boot opens no first-run tutorial (plan Task 14) and
 * every test sees the window it always saw. The controller's saves land here
 * and nowhere else; the directory goes when the test that made it finishes.
 * controller-tutorial.test.ts points `app:getPaths` at a fresh, unseeded one.
 */
function seededUserData(): string {
  const ud = mkdtempSync(join(tmpdir(), 'ss-fake-ud-'))
  writeFileSync(join(ud, 'ui-state.json'), JSON.stringify({ tutorialSeen: true }))
  try {
    onTestFinished(() => rmSync(ud, { recursive: true, force: true }))
  } catch {
    /* made outside a test: left in the temp directory */
  }
  return ud
}

/** `home` is what `app:getPaths` answers, which boot takes as home and the explorer's root. */
export function fakeDeps(home = '/Users/joshwald') {
  const sent: Array<[string, unknown]> = []
  const shellOut: Array<[string, unknown]> = []
  const userData = seededUserData()
  const handlers: Record<string, (p: unknown) => unknown> = {
    'app:getPaths': () => ({ home, hostname: 'jarvis', userData, defaultShell: '/usr/bin/zsh', cwdOfLaunch: home, platform: 'win32', host: 'native' }),
    'session:load': () => null,
    'pty:spawn': () => ({ ok: true, pid: 100 }),
    'pty:kill': () => ({ ok: true, survivors: 0 }),
    'session:save': () => undefined,
    'session:clear': () => undefined,
  }
  const timers: Array<{ fn: () => void; at: number }> = []
  let t = 1000
  const deps: ControllerDeps = {
    invoke: async <T = unknown>(ch: string, p: unknown): Promise<T> => { sent.push([ch, p]); const h = handlers[ch]; if (!h) throw new Error(`no fake for ${ch}`); return h(p) as T },
    send: (ch: string, p: unknown) => { sent.push([ch, p]) },
    toShell: (ch: string, p: unknown) => { shellOut.push([ch, p]) },
    invokeShell: async <T = unknown>(): Promise<T> => ({ ok: true }) as T,
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const e = { fn, at: t + ms }; timers.push(e); return () => { const i = timers.indexOf(e); if (i >= 0) timers.splice(i, 1) } },
    platform: 'win32',
  }
  const advance = (ms: number) => { t += ms; for (const e of [...timers]) if (e.at <= t) { timers.splice(timers.indexOf(e), 1); e.fn() } }
  const models = () => shellOut.filter(([ch]) => ch === 'ui:model').map(([, p]) => p as UiModel)
  const grid = () => shellOut.filter(([ch]) => ch === 'grid:cmd').map(([, p]) => p as GridCmd)
  return { deps, sent, shellOut, handlers, advance, models, grid }
}

export const GEO = { clientW: 1440, clientH: 900, dpi: 96, cellW: 7.8, cellH: 15 }
