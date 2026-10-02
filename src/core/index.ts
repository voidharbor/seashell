/**
 * The core's entry (spec 4.1): `src/main` running against the Electron shim,
 * with the headless controller in front of it. Envelopes in on stdin, out on
 * stdout; stderr is the log.
 */
import { createShim } from './electron-shim.js'
import { startStdio } from './stdio-bridge.js'
import { Controller } from './controller/controller.js'
import { chordTableFromMenu } from './controller/chords.js'
import { encodeEnvelope } from './protocol.js'
import { gatedWriter } from '../main/pty/flow.js'

const hostPid = Number(process.env.SEASHELL_HOST_PID) || process.ppid
const userData = process.env.SEASHELL_USER_DATA
if (!userData || !userData.startsWith('/')) {
  process.stderr.write('[core] SEASHELL_USER_DATA must be an absolute Linux path\n')
  process.exit(2)
}
const version = process.env.SEASHELL_CORE_VERSION ?? '0.0.0'
/** False once the shell's end of the pipe is gone; later writes are dropped. */
let pipeOpen = true
/** Holds the pty reads while stdout is over its high-water mark (Review Focus 2). */
const toPipe = gatedWriter(process.stdout)
const write = (line: string): void => {
  if (pipeOpen) toPipe(line + '\n')
}

// Electron's main process logs an unhandled rejection and keeps going; src/main
// was written against that, so the core does the same rather than dying.
process.on('unhandledRejection', (err: unknown) => {
  process.stderr.write(`[core] unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
})

let controller: Controller | null = null
let booted = false
const queued: Array<[string, unknown]> = []
const shim = createShim({
  write,
  hostPid,
  userData,
  version,
  onPush: (ch, p) => {
    if (controller) route(ch, p)
    else queued.push([ch, p])
  },
})
// Must be set before any src/main module evaluates: electron-shim-default.ts reads it then.
;(globalThis as Record<string, unknown>).__seashellCore = shim
startStdio(shim)

/**
 * The shell owns the core: once its pipe closes (the shell exited or crashed)
 * nobody can draw these panes, so quit through main's drain, which snapshots
 * the session and reaps every pane, instead of lingering beside the next core.
 * A termination signal takes the same path.
 */
function shellGone(why: string): void {
  if (!pipeOpen) return
  pipeOpen = false
  process.stderr.write(`[core] ${why}; quitting\n`)
  shim.app.quit()
}
process.stdin.on('end', () => shellGone('the shell closed stdin'))
process.stdout.on('error', (err: Error) => shellGone(`stdout failed: ${err.message}`))
// Electron quits through before-quit on these; plain node would just die and
// skip the drain that reaps nohup'd and disowned pane processes.
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(sig, () => shellGone(sig))

function route(ch: string, p: unknown): void {
  const c = controller!
  if (ch === 'ui:event') c.event(p as never)
  // push, not command: edit.paste carries the shell's clipboard text with it.
  else if (ch === 'ui:command') c.push(ch, p)
  else if (ch === 'term:event') c.term(p as never)
  else if (ch === 'shell:geometry') {
    if (!booted) {
      booted = true
      void c.boot(p as never)
    } else c.geometry(p as never)
  } else c.push(ch, p)
}

/** main's own warm-up cap (WARM_UP_WAIT_MS) plus headroom. */
const MAIN_READY_CAP_MS = 20_000

async function start(): Promise<void> {
  // A dynamic import so main (and the `electron` alias it pulls in) evaluates after
  // the shim is on globalThis. It registers the ipc handlers, starts the control
  // endpoint, the monitor and the updater.
  await import('../main/index.js')
  // main registers its handlers and builds the menu at the end of its whenReady
  // chain (warm-up, Linux-state import), so the menu being set means main is up.
  const t0 = Date.now()
  while (!shim.Menu.getApplicationMenu() && Date.now() - t0 < MAIN_READY_CAP_MS) {
    await new Promise<void>((r) => setTimeout(r, 10))
  }
  const menu = shim.Menu.getApplicationMenu()
  if (!menu) process.stderr.write('[core] main did not build its menu; starting without chords\n')
  controller = new Controller(
    {
      invoke: (ch, p) => shim.invokeLocal(ch, p),
      send: (ch, p) => shim.sendLocal(ch, p),
      toShell: (ch, p) => write(encodeEnvelope({ k: 'on', ch, p })),
      invokeShell: (ch, p) => shim.invokeShell(ch, p),
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      },
      platform: 'win32',
      log: (line) => process.stderr.write(line + '\n'),
    },
    { home: process.env.HOME ?? '/', version, chords: chordTableFromMenu(menu, 'win32') }
  )
  for (const [ch, p] of queued.splice(0)) {
    try {
      route(ch, p)
    } catch (err) {
      process.stderr.write(`[core] queued ${ch} failed: ${String(err)}\n`)
    }
  }
}

start().catch((err: unknown) => {
  process.stderr.write(`[core] start failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
