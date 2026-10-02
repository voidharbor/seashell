# SeaShell Native Shell, Phase 1 (the terminal core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Windows SeaShell you can run panes in: a C++ shell drawing tabs, panes and terminal grids from a view model, and today's main process plus a headless UI controller running as one Node process inside Ubuntu, measured under 200 MB working set on the Windows side at the 9-tab, 10-pane workload.

**Architecture:** Two processes over one pipe. `SeaShell.exe` (Win32, Direct2D, DirectWrite, libvterm) owns the window, the grids, input and drawing. The core (`core/index.cjs` under WSL's node) runs `src/main` through an Electron shim on a new `wslhost` platform and a headless controller that emits a `ui:model` after every state change. Pane bytes cross as `pty:data` and `pty:write`; keystrokes never make the UI round trip.

**Tech Stack:** C++17, MSVC 14.51 via `vcvars64.bat`, CMake, vcpkg (`utf8proc`, `nlohmann-json`), Direct2D 1.1, DirectWrite, DWM; libvterm 0.3.3 (neovim branch, vendored); TypeScript 7, esbuild, vitest 4, node-pty 1.1.0 built for Linux; Node 26.10 in Ubuntu 24.04 at `/usr/bin/node`.

**Spec:** `docs/superpowers/specs/2026-10-02-seashell-native-design.md` (sections 4, 5, 6, 9, 10, 11); scope `docs/superpowers/specs/2026-10-02-seashell-renderer-inventory.md`; measurement protocol and Aero values in `docs/superpowers/specs/2026-10-02-seashell-redesign.md` sections 2 and 6.

## Global Constraints

- Work only in the worktree `~/seashell-wt/redesign` on branch `redesign/1002`. Never commit on `main` (`~/Desktop/seashell` stays at `3746bfe`). Never push anything. Snapshot branches `snapshot/native-<stage>` with `git branch -f` after each stage gate; never pushed.
- Commit messages are ONE line, no attribution of any kind, no trailers. No em dashes anywhere: code, comments, docs, commit messages, UI copy.
- NEVER kill, quit, restart or replace the running `C:\Users\josh\AppData\Local\Programs\SeaShell\SeaShell.exe` or anything holding Josh's panes. Never launch that exe or `~/.local/bin/SeaShell-LEGACY.AppImage`. Never `taskkill /IM`. Never write `%APPDATA%\seashell` or `~/.config/seashell`. Scratch instances only, each with its own `SEASHELL_USER_DATA` under `C:\seashell-build\redesign\scratch\<name>` (Linux form `/mnt/c/seashell-build/redesign/scratch/<name>`).
- The kill guard (`~/.claude/bin/seashell-kill-guard.sh`) blocks any kill verb in a command whose text mentions "seashell" unless the command also mentions `release/`. Stop a scratch shell with `Stop-Process -Id <pid>` in a command that names its `release/win-native` path, or through the driver's `quit` command, never by image name. Scratch shells launch only from `C:\seashell-build\redesign\release\win-native\`.
- Windows work runs from WSL through `powershell.exe -NoProfile` or `cmd.exe /c`, every command starting with `cd /d C:\...` or `Set-Location C:\...` and using absolute `C:\` paths (a WSL cwd is UNC to Windows and silently becomes `C:\Windows`). The build tree is `C:\seashell-build\redesign\`, an rsync of the worktree by `scripts/win/sync-tree.sh`; run it before every Windows-side build. Nothing under `C:\AI\`. Nothing copied into `Programs\SeaShell`.
- Native builds: `cmd.exe /c "call \"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat\" && <command>"`. vcpkg toolchain file `C:\Users\josh\dev\vcpkg\scripts\buildsystems\vcpkg.cmake`. Build directory `C:\seashell-build\redesign\shell-build`.
- The core is built and run with WSL's own node (`/usr/bin/node`, 26.10); nothing in Phase 1 uses the Windows node. `node-pty` is the Linux build already in `node_modules/node-pty/build/Release/pty.node`.
- Gates before any snapshot: `npm run typecheck && npm test` clean in the worktree, plus the stage's Windows gate named in the task. Run one vitest file as `npx vitest run <path> --project unit` (or `--project dom` for `test/dom`). Do not `git add -A`; add files by name.
- The core imports pure renderer modules in place (`src/renderer/layout/*`, `store.ts`, `links/*`, `projects/serialize.ts`, `session/offer.ts`, `term/zoom.ts`, `term/osc7.ts`, `term/inputline.ts`, `panes/paneTitle.ts`, `panes/attention.ts`, `panes/colors.ts`, `settings/settings.ts`); nothing moves, the renderer keeps building for the other platforms. A renderer module that drags in `document` or `window` at import time is not imported; its pure functions are copied into `src/core/controller/` with a comment naming the source.
- Every subagent dispatched by this plan is given `model: "opus"` explicitly unless the ultracode-lite ladder assigns a cheaper tier for a mechanical step.
- Microsoft Edge must be closed during any RAM measurement; `measure-ram.ps1` refuses otherwise. Close nothing you did not start: if Edge is open, record "not measured, Edge was open" and continue.
- After every task that ends a stage, append a section to `~/.codex/notes/seashell-native-report-<date>.md` (Task 18 defines the sections) so a cut-off run still reports.
- Scrollback is `20_000`. The W10 workload, counting rules and the 200 MB bar are redesign spec section 2 and spec section 4.7 and are not reinterpreted.

## Review Focus

1. **The core dies mid-session** (WSL restarts, `wsl --shutdown`, an uncaught exception). The window must stay up, every pane shows an exit overlay with Restart, a toast names the cause, and the shell relaunches the core once. Task 8 step 6 tests it by ending the core from the driver.
2. **A pane prints 50 MB.** Base64 through JSON must not grow the core or the shell without bound; the pipe's backpressure must throttle the pty read. Task 18 step 2 measures it and decides base64 versus binary frames.
3. **Launching the shell from inside one of its own panes.** `SEASHELL_USER_ZDOTDIR` must never become the shim path; `buildEnv` already guards it, and Task 3 step 1 asserts the `wslhost` pane env from a process whose `ZDOTDIR` is the shim.
4. **Emoji and CJK widths.** If the shell's width path differs from xterm.js with the graphemes addon, Claude Code's boxes misalign. Task 10 step 5 is the corpus gate.
5. **The DWM colorization value is missing or malformed** (DWM off, remote session). `colorizationToTokens` must return the spec section 6.2 table for `#881798`, never throw, and the strip must paint opaque. Task 16 step 1 tests the function; Task 16 step 4 tests the fallback paint.

---

## Stage A: the core (Tasks 1 to 6)

### Task 1: Bridge protocol, esbuild, the core bundle skeleton

**Files:**
- Create: `src/core/protocol.ts`, `scripts/build-core.mjs`
- Modify: `package.json` (add `esbuild` to devDependencies; add script `"build:core": "node scripts/build-core.mjs"`)
- Test: `test/unit/core-protocol.test.ts`

**Interfaces:**
- Produces: `type Envelope = { k: 'invoke' | 'send' | 'on' | 'reply', ch: string, id?: number, p: unknown }`, `encodeEnvelope(e): string` (one line), `decodeEnvelope(line): Envelope` (throws on a bad `k`, `ch`, `id`, or a non-object `invoke` payload), `SHELL_CHANNELS: readonly string[]` (channels the shell answers itself: `window:minimize`, `window:toggleMaximize`, `window:close`, `window:isMaximized`, `window:maximized`, `app:pickFolder`, `clip:read`, `clip:write`, `open:withDefaultApp`, `open:revealInFinder`, `open:externalHttp`, `display:list`, `display:colorization`, `grid:cmd`, `test:screenshot`), `CORE_PUSH_TO_SHELL: readonly string[]` = `['pty:data', 'ui:model', 'grid:cmd']` (the only `on` channels the core writes to the pipe; every other push goes to the controller in process).
- Produces: `out/core/index.cjs` from `src/core/index.ts` (Task 6 writes the entry; this task builds a placeholder entry that prints `core skeleton` and exits 0).

- [ ] **Step 1: Failing protocol test**

```ts
import { describe, expect, it } from 'vitest'
import { CORE_PUSH_TO_SHELL, decodeEnvelope, encodeEnvelope, SHELL_CHANNELS } from '../../src/core/protocol.js'

describe('core envelope', () => {
  it('round trips an invoke with an id on one line', () => {
    const line = encodeEnvelope({ k: 'invoke', ch: 'fs:probe', id: 7, p: { path: '/x' } })
    expect(line.includes('\n')).toBe(false)
    expect(decodeEnvelope(line)).toEqual({ k: 'invoke', ch: 'fs:probe', id: 7, p: { path: '/x' } })
  })
  it('rejects unknown kinds, bad channels, bad ids and non-object invoke payloads', () => {
    expect(() => decodeEnvelope('{"k":"exec","ch":"x","p":{}}')).toThrow(/k/)
    expect(() => decodeEnvelope('{"k":"send","ch":5,"p":{}}')).toThrow(/ch/)
    expect(() => decodeEnvelope('{"k":"reply","ch":"x","id":"1","p":{}}')).toThrow(/id/)
    expect(() => decodeEnvelope('{"k":"invoke","ch":"fs:probe","id":1,"p":"str"}')).toThrow(/payload/)
  })
  it('keeps newlines inside strings escaped', () => {
    const line = encodeEnvelope({ k: 'send', ch: 'pty:write', p: { paneId: 'a', data: 'ls\n' } })
    expect(line.split('\n')).toHaveLength(1)
  })
  it('names the shell-owned and shell-bound channels', () => {
    expect(SHELL_CHANNELS).toContain('clip:write')
    expect(SHELL_CHANNELS).not.toContain('pty:spawn')
    expect(CORE_PUSH_TO_SHELL).toEqual(['pty:data', 'ui:model', 'grid:cmd'])
  })
})
```

Run: `npx vitest run test/unit/core-protocol.test.ts --project unit` Expected: FAIL, module not found.

- [ ] **Step 2: protocol.ts**

```ts
/** [pure] The one envelope shape on the shell pipe (spec 4.2). */
export type EnvelopeKind = 'invoke' | 'send' | 'on' | 'reply'
export interface Envelope { k: EnvelopeKind; ch: string; id?: number; p: unknown }
const KINDS: readonly EnvelopeKind[] = ['invoke', 'send', 'on', 'reply']

/** Channels the shell answers itself (spec 4.2); the core never handles these. */
export const SHELL_CHANNELS: readonly string[] = [
  'window:minimize', 'window:toggleMaximize', 'window:close', 'window:isMaximized', 'window:maximized',
  'app:pickFolder', 'clip:read', 'clip:write',
  'open:withDefaultApp', 'open:revealInFinder', 'open:externalHttp',
  'display:list', 'display:colorization', 'grid:cmd', 'test:screenshot',
]

/** The only `on` channels the core writes to the pipe. Every other push is for the controller. */
export const CORE_PUSH_TO_SHELL: readonly string[] = ['pty:data', 'ui:model', 'grid:cmd']

export function encodeEnvelope(e: Envelope): string {
  // JSON.stringify escapes every newline inside strings, so one envelope is one line.
  return JSON.stringify(e)
}

export function decodeEnvelope(line: string): Envelope {
  const raw: unknown = JSON.parse(line)
  if (typeof raw !== 'object' || raw === null) throw new Error('envelope: not an object')
  const r = raw as Record<string, unknown>
  if (!KINDS.includes(r.k as EnvelopeKind)) throw new Error(`envelope: bad k ${String(r.k)}`)
  if (typeof r.ch !== 'string' || !r.ch) throw new Error('envelope: bad ch')
  if (r.id !== undefined && typeof r.id !== 'number') throw new Error('envelope: bad id')
  if (r.k === 'invoke' && (typeof r.p !== 'object' || r.p === null)) throw new Error('envelope: invoke payload must be an object')
  return { k: r.k as EnvelopeKind, ch: r.ch, id: r.id as number | undefined, p: r.p }
}
```

Run the test: PASS, 4 tests.

- [ ] **Step 3: esbuild and the bundle script**

`npm install -D esbuild` (record the installed version in the commit message body as one line, e.g. `esbuild 0.27.2`). Then `scripts/build-core.mjs`:

```js
// Bundles the core for WSL's node. node-pty stays external (native module, staged beside the bundle).
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const version = require('../package.json').version

await build({
  entryPoints: ['src/core/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'out/core/index.cjs',
  external: ['node-pty'],
  alias: { electron: './src/core/electron-shim-default.ts' },
  define: { 'process.env.SEASHELL_CORE_VERSION': JSON.stringify(version) },
  sourcemap: false,
  logLevel: 'info',
})
mkdirSync('out/core', { recursive: true })
writeFileSync('out/core/VERSION', version + '\n')
console.log(`built out/core/index.cjs (${version})`)
```

Placeholder `src/core/index.ts` for this task only: `console.log('core skeleton'); process.exit(0)`. Placeholder `src/core/electron-shim-default.ts`: `export {}`. Both are replaced in Tasks 2 and 6.

Run: `node scripts/build-core.mjs && node out/core/index.cjs` Expected: `core skeleton`.

- [ ] **Step 4: Commit**

```bash
git add src/core/protocol.ts src/core/index.ts src/core/electron-shim-default.ts scripts/build-core.mjs package.json package-lock.json test/unit/core-protocol.test.ts
git commit -m "Add the core envelope protocol and the esbuild bundle"
```

---

### Task 2: Electron shim and the stdio bridge

**Files:**
- Create: `src/core/electron-shim.ts`, `src/core/electron-shim-default.ts` (replace the placeholder), `src/core/stdio-bridge.ts`
- Test: `test/unit/core-shim.test.ts`, `test/unit/core-stdio.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `encodeEnvelope`, `decodeEnvelope`, `CORE_PUSH_TO_SHELL` from Task 1.
- Produces: `createShim(opts: ShimOptions): Shim` where

```ts
export interface ShimOptions {
  write: (line: string) => void        // one envelope line to the shell
  hostPid: number                      // the shell's Windows pid
  userData: string                     // Linux path (drvfs) of the userData dir
  version: string
  onPush: (ch: string, p: unknown) => void   // pushes NOT in CORE_PUSH_TO_SHELL go here (the controller)
}
export interface Shim {
  app: AppShim; BrowserWindow: typeof BrowserWindowShim; Menu: MenuShim; ipcMain: IpcMainShim
  net: { fetch: typeof fetch }; protocol: { handle(): void; registerSchemesAsPrivileged(): void }
  screen: ScreenShim; shell: ShellShim; clipboard: ClipboardShim; dialog: DialogShim
  /** An envelope that arrived from the shell. */
  dispatch(e: Envelope): Promise<void>
  /** The controller calls main's ipc handlers in process, no pipe. */
  invokeLocal<T = unknown>(ch: string, p: unknown): Promise<T>
  sendLocal(ch: string, p: unknown): void
  /** The core's own invoke toward the shell (clip:write, display:list, ...). */
  invokeShell<T = unknown>(ch: string, p: unknown): Promise<T>
}
```

  `BrowserWindow.getAllWindows()[0].webContents.send(ch, p)` writes an `on` envelope when `ch` is in `CORE_PUSH_TO_SHELL`, otherwise calls `onPush(ch, p)`. `app.getPath('userData')` is `opts.userData`; `home`, `temp`, `exe`, `logs` from Node (`os.homedir()`, `os.tmpdir()`, `process.execPath`, `<userData>/logs`). `app.getVersion()` is `opts.version`. `app.isPackaged` is `true`. `app.requestSingleInstanceLock()` is `true`. `app.setAppUserModelId`, `app.setPath` are no-ops except `setPath('userData', x)` which updates the stored value. `app.whenReady()` resolves on the next tick. `app.quit()` emits `before-quit` then `will-quit`, then calls `process.exit(0)` after the listeners' promises settle (10 s cap). `app.on('second-instance')` fires when the shell sends `{k:'send', ch:'app:secondInstance'}`. `Menu.buildFromTemplate` keeps the template (items with `label`, `accelerator`, `click`, `submenu`), `setApplicationMenu` stores it, `getApplicationMenu()` returns it, nothing draws. `ipcMain.handle/on/removeHandler` fill the dispatch tables. `shell.openPath`, `shell.openExternal`, `shell.showItemInFolder`, `clipboard.readText`, `clipboard.writeText`, `dialog.showOpenDialog`, `screen.getPrimaryDisplay`, `screen.getDisplayMatching`, `screen.getAllDisplays` are `invokeShell` calls on `open:withDefaultApp`, `open:externalHttp`, `open:revealInFinder`, `clip:read`, `clip:write`, `app:pickFolder`, `display:list`.
- Produces: `startStdio(shim: Shim, input: NodeJS.ReadableStream = process.stdin): void` reading lines (tolerating CRLF, buffering partial lines, skipping empty ones), decoding each with `decodeEnvelope`, calling `shim.dispatch`; a line that fails to decode is logged to stderr and skipped.
- Produces: `electron-shim-default.ts` exporting the named symbols from `globalThis.__seashellCore` (`app`, `BrowserWindow`, `Menu`, `ipcMain`, `net`, `protocol`, `screen`, `shell`, `clipboard`, `dialog`) so `import { app } from 'electron'` inside `src/main` resolves to the live shim under the esbuild alias.

- [ ] **Step 1: Failing shim tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createShim } from '../../src/core/electron-shim.js'

function make() {
  const out: string[] = []
  const pushes: Array<[string, unknown]> = []
  const shim = createShim({ write: (l) => out.push(l), hostPid: 4242, userData: '/mnt/c/scratch/ud', version: '0.6.0', onPush: (ch, p) => pushes.push([ch, p]) })
  return { out, pushes, shim }
}

describe('electron shim', () => {
  it('app paths and identity come from the options', () => {
    const { shim } = make()
    expect(shim.app.getPath('userData')).toBe('/mnt/c/scratch/ud')
    expect(shim.app.getVersion()).toBe('0.6.0')
    expect(shim.app.requestSingleInstanceLock()).toBe(true)
    expect(shim.app.isPackaged).toBe(true)
  })
  it('webContents.send writes pty:data and ui:model to the pipe and routes everything else to onPush', () => {
    const { out, pushes, shim } = make()
    const wc = shim.BrowserWindow.getAllWindows()[0]!.webContents
    wc.send('pty:data', { batches: [] })
    wc.send('metrics:tick', { panes: [], system: null })
    expect(JSON.parse(out.at(-1)!)).toEqual({ k: 'on', ch: 'pty:data', p: { batches: [] } })
    expect(pushes).toEqual([['metrics:tick', { panes: [], system: null }]])
  })
  it('an invoke from the shell is answered by the ipcMain handler with the same id', async () => {
    const { out, shim } = make()
    shim.ipcMain.handle('fs:probe', async (_e, p: { path: string }) => ({ exists: p.path === '/yes' }))
    await shim.dispatch({ k: 'invoke', ch: 'fs:probe', id: 9, p: { path: '/yes' } })
    expect(JSON.parse(out.at(-1)!)).toEqual({ k: 'reply', ch: 'fs:probe', id: 9, p: { exists: true } })
  })
  it('an invoke with no handler replies with ENOHANDLER instead of hanging', async () => {
    const { out, shim } = make()
    await shim.dispatch({ k: 'invoke', ch: 'nope:x', id: 10, p: {} })
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ k: 'reply', id: 10, p: { ok: false, code: 'ENOHANDLER' } })
  })
  it('invokeLocal calls a handler in process and sendLocal fires listeners', async () => {
    const { shim } = make()
    shim.ipcMain.handle('app:getPaths', () => ({ home: '/Users/joshwald' }))
    const seen = vi.fn()
    shim.ipcMain.on('pty:write', (_e, p) => seen(p))
    expect(await shim.invokeLocal('app:getPaths', {})).toEqual({ home: '/Users/joshwald' })
    shim.sendLocal('pty:write', { paneId: 'a', data: 'x' })
    expect(seen).toHaveBeenCalledWith({ paneId: 'a', data: 'x' })
  })
  it('shell and clipboard are invokes toward the shell, resolved by its reply', async () => {
    const { out, shim } = make()
    const p = shim.shell.openPath('/Users/joshwald/a.txt')
    const sent = JSON.parse(out.at(-1)!)
    expect(sent).toMatchObject({ k: 'invoke', ch: 'open:withDefaultApp', p: { path: '/Users/joshwald/a.txt' } })
    await shim.dispatch({ k: 'reply', ch: 'open:withDefaultApp', id: sent.id, p: { ok: true } })
    expect(await p).toBe('')
  })
  it('Menu keeps the template and draws nothing', () => {
    const { shim } = make()
    const m = shim.Menu.buildFromTemplate([{ label: 'File', submenu: [{ label: 'New Pane', accelerator: 'Ctrl+Shift+D', click: vi.fn() }] }])
    shim.Menu.setApplicationMenu(m)
    expect(shim.Menu.getApplicationMenu()?.items[0]?.submenu?.items[0]?.accelerator).toBe('Ctrl+Shift+D')
  })
  it('a send with no ipcMain listener is routed to onPush for the controller', async () => {
    const { pushes, shim } = make()
    await shim.dispatch({ k: 'send', ch: 'ui:command', p: { command: 'tab.new' } })
    expect(pushes).toEqual([['ui:command', { command: 'tab.new' }]])
  })
  it('app:secondInstance from the shell raises second-instance', async () => {
    const { shim } = make()
    const seen = vi.fn()
    shim.app.on('second-instance', seen)
    await shim.dispatch({ k: 'send', ch: 'app:secondInstance', p: {} })
    expect(seen).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Failing stdio test**

```ts
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { startStdio } from '../../src/core/stdio-bridge.js'

describe('stdio bridge', () => {
  it('dispatches two envelopes in one chunk and one split across chunks, tolerating CRLF and blank lines', async () => {
    const seen: unknown[] = []
    const shim = { dispatch: async (e: unknown) => { seen.push(e) } } as never
    const input = new PassThrough()
    startStdio(shim, input)
    input.write('{"k":"send","ch":"a","p":{}}\r\n{"k":"send","ch":"b","p":{}}\n\n{"k":"se')
    await new Promise((r) => setTimeout(r, 5))
    input.write('nd","ch":"c","p":{"x":1}}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(seen.map((e) => (e as { ch: string }).ch)).toEqual(['a', 'b', 'c'])
  })
  it('skips a line that does not decode and keeps going', async () => {
    const seen: unknown[] = []
    const shim = { dispatch: async (e: unknown) => { seen.push(e) } } as never
    const input = new PassThrough()
    startStdio(shim, input)
    input.write('not json\n{"k":"send","ch":"ok","p":{}}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(seen).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Implement the shim**

`electron-shim.ts` structure (complete every method named in Interfaces; the table in spec section 4.3 of the redesign spec is the behaviour reference):

```ts
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { CORE_PUSH_TO_SHELL, encodeEnvelope, type Envelope } from './protocol.js'

type Handler = (event: IpcEvent, payload: unknown) => unknown
export interface IpcEvent { sender: { send(ch: string, p: unknown): void } }

export function createShim(opts: ShimOptions): Shim {
  const paths: Record<string, string> = {
    userData: opts.userData, home: os.homedir(), temp: os.tmpdir(), exe: process.execPath, logs: path.join(opts.userData, 'logs'),
  }
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler[]>()
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1
  const app = new EventEmitter() as AppShim
  // ... getPath/setPath/getVersion/getName/isPackaged/whenReady/requestSingleInstanceLock/setAppUserModelId/quit/exit

  const webContents = {
    send(ch: string, p: unknown) {
      if (CORE_PUSH_TO_SHELL.includes(ch)) opts.write(encodeEnvelope({ k: 'on', ch, p }))
      else opts.onPush(ch, p)
    },
  }
  const win = { webContents, isDestroyed: () => false, focus() {}, getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }), on() { return win }, once() { return win }, setTitle() {}, isMinimized: () => false, restore() {}, show() {} }
  class BrowserWindowShim { static getAllWindows() { return [win] } static getFocusedWindow() { return win } constructor() { return win as never } }

  const ipcMain = {
    handle(ch: string, fn: Handler) { handlers.set(ch, fn) },
    removeHandler(ch: string) { handlers.delete(ch) },
    on(ch: string, fn: Handler) { listeners.set(ch, [...(listeners.get(ch) ?? []), fn]) },
  }
  const event: IpcEvent = { sender: webContents }

  function invokeShell<T>(ch: string, p: unknown): Promise<T> {
    const id = nextId++
    opts.write(encodeEnvelope({ k: 'invoke', ch, id, p }))
    return new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }))
  }

  async function dispatch(e: Envelope): Promise<void> {
    if (e.k === 'invoke') {
      const h = handlers.get(e.ch)
      if (!h) { opts.write(encodeEnvelope({ k: 'reply', ch: e.ch, id: e.id, p: { ok: false, code: 'ENOHANDLER', message: `no handler for ${e.ch}` } })); return }
      try { opts.write(encodeEnvelope({ k: 'reply', ch: e.ch, id: e.id, p: await h(event, e.p) })) }
      catch (err) { opts.write(encodeEnvelope({ k: 'reply', ch: e.ch, id: e.id, p: { ok: false, code: 'EHANDLER', message: String(err) } })) }
      return
    }
    if (e.k === 'send') {
      if (e.ch === 'app:secondInstance') { app.emit('second-instance', undefined, [], process.cwd()); return }
      if (e.ch === 'app:beforeQuit') { app.quit(); return }
      const fns = listeners.get(e.ch)
      if (fns && fns.length) { for (const fn of fns) fn(event, e.p); return }
      opts.onPush(e.ch, e.p)   // ui:event, ui:command, term:event, shell:geometry, shell:colorization: the controller's
      return
    }
    if (e.k === 'reply' && e.id !== undefined) {
      const w = pending.get(e.id); pending.delete(e.id); w?.resolve(e.p); return
    }
    if (e.k === 'on') opts.onPush(e.ch, e.p)   // the shell's own pushes (ui:event, term:event, shell:geometry)
  }
  // ... Menu, shell, clipboard, dialog, screen, net, protocol as described
  return { app, BrowserWindow: BrowserWindowShim, Menu, ipcMain, net: { fetch }, protocol, screen, shell, clipboard, dialog, dispatch, invokeLocal, sendLocal, invokeShell }
}
```

`shell.openPath(p)` resolves to `''` when the reply is `{ok:true}` and to the error string otherwise (Electron's contract). `clipboard.readText()` resolves the reply's `text`. `dialog.showOpenDialog()` resolves `{ canceled, filePaths }` from `app:pickFolder`'s `{ok, path}`.

`stdio-bridge.ts`:

```ts
import type { Shim } from './electron-shim.js'
import { decodeEnvelope } from './protocol.js'

export function startStdio(shim: Shim, input: NodeJS.ReadableStream = process.stdin): void {
  let buf = ''
  input.setEncoding?.('utf8')
  input.on('data', (chunk: string | Buffer) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line) continue
      let env
      try { env = decodeEnvelope(line) } catch (err) { process.stderr.write(`[core] bad envelope: ${String(err)}\n`); continue }
      void shim.dispatch(env)
    }
  })
}
```

`electron-shim-default.ts`:

```ts
const s = (globalThis as Record<string, unknown>).__seashellCore as Record<string, unknown>
export const app = s.app, BrowserWindow = s.BrowserWindow, Menu = s.Menu, ipcMain = s.ipcMain, net = s.net, protocol = s.protocol, screen = s.screen, shell = s.shell, clipboard = s.clipboard, dialog = s.dialog
export default s
```

- [ ] **Step 4: Run both test files**

`npx vitest run test/unit/core-shim.test.ts test/unit/core-stdio.test.ts --project unit` Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/electron-shim.ts src/core/electron-shim-default.ts src/core/stdio-bridge.ts test/unit/core-shim.test.ts test/unit/core-stdio.test.ts
git commit -m "Add the Electron shim and the stdio bridge for the core"
```

---

### Task 3: The `wslhost` platform

**Files:**
- Create: `src/main/platform/wslhost.ts`
- Modify: `src/main/platform/index.ts` (select by `SEASHELL_HOST`), `src/main/platform/types.ts` (add `controlTransport?: 'tcp' | 'unix'` and `paneEnvExtras?(paneId: string): Array<[string, string]>`), `src/main/pty/manager.ts` (apply `paneEnvExtras` after `buildEnv`), `src/main/index.ts:351` (pick TCP by `platform.controlTransport === 'tcp' || process.platform === 'win32'`), `src/main/ipc-router.ts:581` (`app:getPaths` adds `host: process.env.SEASHELL_HOST === 'native-win' ? 'native' : 'electron'`), `src/main/control/endpoint.ts` (`endpointInfo` gains `corePid`)
- Test: `test/unit/platform-wslhost.test.ts`, extend `test/unit/control-endpoint.test.ts` (or the existing endpoint test file) for `corePid`

**Interfaces:**
- Consumes: `linux` from `platform/linux.ts`; `paneVars`, `appInstanceId`, `wslShimFiles`, `shimDirFor`, `pidDirFor`, `pidFileFor`, `WSL_STATE_DIR` from `src/shared/wsl-shell.ts`; `buildEnv` from `pty/env.ts`.
- Produces: `createWslhost(io: WslhostIo): Platform` with

```ts
export interface WslhostIo {
  hostPid: number                         // SEASHELL_HOST_PID
  home: string                            // os.homedir()
  appVersion: string
  mkdirp(dir: string): void
  writeFileAtomic(file: string, contents: string): void
  readdir(dir: string): string[]
  rmrf(dir: string): void
  windowsPidAlive(pid: number): boolean    // tasklist.exe through /mnt/c, true on any error (never sweep a live run)
}
export const wslhost: Platform   // createWslhost with the real io, built lazily at select()
```

  Behaviour: `id: 'linux'`, `capabilities` from linux, `loginShell` from linux (zsh from `$SHELL`), `installShellIntegration()` writes `wslShimFiles()` into `shimDirFor(home)`, sweeps `pidDirFor` siblings whose numeric name is not `hostPid` and not alive, creates `pidDirFor(home, hostPid)`, returns the shim dir; `paneEnvExtras(paneId)` returns `paneVars({ paneId, appVersion, shimDir, userZdotdir: null, pidFile: pidFileFor(home, hostPid, paneId), appId: appInstanceId('win32', hostPid) })` filtered to `SEASHELL_PIDFILE`, `SEASHELL_APP_ID`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION` (the ZDOTDIR pair and `SEASHELL_PANE_ID` are already set by `buildEnv`; `userZdotdir: null` keeps `paneVars` from re-emitting them); `controlTransport: 'tcp'`; `terminalFontPath: () => null`; everything else from linux.
- Produces: in `manager.ts`, after `buildEnv(...)`: `for (const [k, v] of platform.paneEnvExtras?.(req.paneId) ?? []) env[k] = v`.
- Produces: `platform/index.ts` `select()` returns `wslhost` when `process.env.SEASHELL_HOST === 'native-win'`, before the `process.platform` switch.

- [ ] **Step 1: Failing platform test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createWslhost } from '../../src/main/platform/wslhost.js'
import { buildEnv } from '../../src/main/pty/env.js'

function io(over: Partial<Parameters<typeof createWslhost>[0]> = {}) {
  const writes: Record<string, string> = {}
  const dirs: string[] = []
  const removed: string[] = []
  return {
    writes, dirs, removed,
    io: {
      hostPid: 777, home: '/Users/joshwald', appVersion: '0.6.0',
      mkdirp: (d: string) => { dirs.push(d) },
      writeFileAtomic: (f: string, c: string) => { writes[f] = c },
      readdir: () => ['777', '31337', 'junk'],
      rmrf: (d: string) => { removed.push(d) },
      windowsPidAlive: (pid: number) => pid === 777,
      ...over,
    },
  }
}

describe('wslhost platform', () => {
  it('writes the WSL shim files and returns the Linux shim dir', () => {
    const { io: i, writes, dirs } = io()
    const p = createWslhost(i)
    expect(p.installShellIntegration()).toBe('/Users/joshwald/.cache/seashell-win/zdotdir')
    expect(Object.keys(writes).sort()).toEqual(['.zlogin', '.zprofile', '.zshenv', '.zshrc'].map((n) => `/Users/joshwald/.cache/seashell-win/zdotdir/${n}`))
    expect(writes['/Users/joshwald/.cache/seashell-win/zdotdir/.zshenv']).toContain('SEASHELL_PIDFILE')
    expect(dirs).toContain('/Users/joshwald/.cache/seashell-win/pids/777')
  })
  it('sweeps pid dirs of dead shell pids only', () => {
    const { io: i, removed } = io()
    createWslhost(i).installShellIntegration()
    expect(removed).toEqual(['/Users/joshwald/.cache/seashell-win/pids/31337'])
  })
  it('pane env extras carry the win32 identity and the pid file', () => {
    const p = createWslhost(io().io)
    p.installShellIntegration()
    const extras = Object.fromEntries(p.paneEnvExtras!('pane-9'))
    expect(extras).toMatchObject({ SEASHELL_APP_ID: 'win32-777', SEASHELL_PIDFILE: '/Users/joshwald/.cache/seashell-win/pids/777/pane-pane-9.pid', TERM_PROGRAM: 'SeaShell', TERM_PROGRAM_VERSION: '0.6.0' })
    expect(extras).not.toHaveProperty('ZDOTDIR')
  })
  it('a pane spawned from a pane keeps the real ZDOTDIR (Review Focus 3)', () => {
    const shim = '/Users/joshwald/.cache/seashell-win/zdotdir'
    const env = buildEnv({ baseEnv: { HOME: '/Users/joshwald', ZDOTDIR: shim, SEASHELL_USER_ZDOTDIR: '/Users/joshwald' }, paneId: 'p', appVersion: '0.6.0', zdotdirShimPath: shim })
    expect(env.ZDOTDIR).toBe(shim)
    expect(env.SEASHELL_USER_ZDOTDIR).toBe('/Users/joshwald')
    expect(env.COLORTERM).toBeUndefined()
  })
  it('selects the tcp control transport and no terminal font', () => {
    const p = createWslhost(io().io)
    expect(p.controlTransport).toBe('tcp')
    expect(p.terminalFontPath()).toBeNull()
    expect(p.id).toBe('linux')
  })
})
```

Run: FAIL, module not found.

- [ ] **Step 2: Implement wslhost.ts**

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { linux } from './linux.js'
import type { Platform } from './types.js'
import { appInstanceId, paneVars, pidDirFor, pidFileFor, shimDirFor, WSL_STATE_DIR, wslShimFiles } from '../../shared/wsl-shell.js'

/**
 * The native Windows shell's platform: Linux ptys, Linux fs and sweeps, with
 * the Windows pane identity contract on top (spec 4.4). Selected by
 * SEASHELL_HOST=native-win, never by process.platform.
 */
export interface WslhostIo { /* as in Interfaces */ }

export function createWslhost(io: WslhostIo): Platform {
  let shimDir: string | null = null
  const home = io.home.replace(/\/+$/, '')
  return {
    ...linux,
    controlTransport: 'tcp',
    terminalFontPath: () => null,
    installShellIntegration(): string | null {
      const dir = shimDirFor(home)
      try {
        io.mkdirp(dir)
        for (const [name, contents] of Object.entries(wslShimFiles())) io.writeFileAtomic(`${dir}/${name}`, contents)
        const pidsRoot = `${home}/${WSL_STATE_DIR}/pids`
        io.mkdirp(pidsRoot)
        for (const name of io.readdir(pidsRoot)) {
          const other = Number(name)
          if (Number.isInteger(other) && other !== io.hostPid && !io.windowsPidAlive(other)) io.rmrf(`${pidsRoot}/${name}`)
        }
        io.mkdirp(pidDirFor(home, io.hostPid))
        shimDir = dir
        return dir
      } catch (err) {
        console.warn('[seashell] could not write the WSL ZDOTDIR shim:', err)
        shimDir = null
        return null
      }
    },
    paneEnvExtras(paneId: string): Array<[string, string]> {
      const keep = new Set(['SEASHELL_PIDFILE', 'SEASHELL_APP_ID', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'])
      // userZdotdir null: buildEnv already set the ZDOTDIR pair, paneVars must not repeat it.
      const vars = paneVars({ paneId, appVersion: io.appVersion, shimDir: null, userZdotdir: null, pidFile: null, appId: appInstanceId('win32', io.hostPid) })
      const out = vars.filter(([k]) => keep.has(k))
      if (shimDir !== null) out.unshift(['SEASHELL_PIDFILE', pidFileFor(home, io.hostPid, paneId)])
      return out
    },
  }
}

function windowsPidAlive(pid: number): boolean {
  try {
    const out = execFileSync('/mnt/c/Windows/System32/tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    return new RegExp(`\\s${pid}\\s`).test(out)
  } catch {
    return true
  }
}

export const wslhost: Platform = createWslhost({
  hostPid: Number(process.env.SEASHELL_HOST_PID) || process.ppid,
  home: os.homedir(),
  appVersion: process.env.SEASHELL_CORE_VERSION ?? '0.0.0',
  mkdirp: (d) => fs.mkdirSync(d, { recursive: true }),
  writeFileAtomic: (f, c) => { const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, c); fs.renameSync(tmp, f) },
  readdir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
  rmrf: (d) => fs.rmSync(d, { recursive: true, force: true }),
  windowsPidAlive,
})
```

Note on `paneVars`: with `shimDir: null` it emits only TERM, TERM_PROGRAM, TERM_PROGRAM_VERSION, SEASHELL_PANE_ID and SEASHELL_APP_ID; the filter keeps the four this platform adds and the pid file is prepended with the real path. Keep `pidFile` out of the `paneVars` call on purpose (it is only emitted together with the shim pair there).

`types.ts` additions:

```ts
  /** 'tcp' selects the loopback-plus-token control endpoint on any OS (the native Windows shell runs main inside WSL). */
  readonly controlTransport?: 'tcp' | 'unix'
  /** Extra pane environment, applied after buildEnv. The wslhost platform stamps the Windows pane identity here. */
  paneEnvExtras?(paneId: string): Array<[string, string]>
```

`index.ts:351` becomes `platform.controlTransport === 'tcp' || process.platform === 'win32'`. `endpoint.ts`: `endpointInfo(port, token, pid, corePid = process.pid)` returns `{ host, port, token, pid, corePid }`; `index.ts` passes `pid: Number(process.env.SEASHELL_HOST_PID) || process.pid` where the TCP server is started (find the `pid` argument in `startTcpControlServer`'s deps and thread it; if it reads `process.pid` directly, add a `pid` option defaulting to `process.pid`).

- [ ] **Step 3: Run the tests and the whole suite**

`npx vitest run test/unit/platform-wslhost.test.ts --project unit` Expected: PASS, 5 tests. `npm test` Expected: everything else still green (the `pid` default keeps the existing endpoint tests unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/main/platform/wslhost.ts src/main/platform/index.ts src/main/platform/types.ts src/main/pty/manager.ts src/main/index.ts src/main/ipc-router.ts src/main/control/endpoint.ts test/unit/platform-wslhost.test.ts
git commit -m "Add the wslhost platform for the native shell"
```

---

### Task 4: The headless controller, part 1: state, commands, the view model

**Files:**
- Create: `src/core/controller/model.ts`, `src/core/controller/controller.ts`, `src/core/controller/layout.ts`, `src/core/controller/chords.ts`, `src/core/controller/ui-state.ts`
- Test: `test/unit/controller-model.test.ts`, `test/unit/controller-commands.test.ts`, `test/unit/controller-chords.test.ts`

**Interfaces:**
- Consumes: `reducer`, `AppState`, `makePane`, `makeTab`, `paneById`, `isTerm`, `MAX_TAB_NAME`, `baseLabel`, `uid` from `src/renderer/store.ts`; `computeLayout`, `deriveDividers`, `applyDividerDrag`, `insertPane`, `rebalance`, `removePane`, `dfsPaneOrder`, `createInitialTree`, `leafMinPx`, the constants from `src/renderer/layout/*`; `ZOOM_LEVELS`, `DEFAULT_ZOOM_INDEX`, `clampIndex`, `levelAt`, `zoomPercent` from `src/renderer/term/zoom.ts`; `coerceSettings`, `DEFAULT_SETTINGS` from `src/renderer/settings/settings.ts`; `cleanPaneTitle`; `nextAttention`, `doneExpired`, `DONE_ATTENTION_MS`; `nextAutoColor`, `FIRST_PANE_COLOR`, `paneColorHex`; `accelerator` from `src/shared/keys.ts`.
- Produces `model.ts` (the wire shape, every field the shell draws; DIP = device-independent pixels at `uiScale` applied):

```ts
export interface Rect { x: number; y: number; w: number; h: number }
export interface TabModel { id: string; name: string; active: boolean; renaming: boolean }
export interface PaneModel {
  id: string; kind: 'term' | 'file' | 'web'; rect: Rect; gridRect: Rect; cols: number; rows: number
  index: number; label: string; tooltip: string; badge: string; memBadge: string | null; memHigh: boolean
  zoomPercent: number | null; fontPx: number; color: string | null; focused: boolean
  attention: 'none' | 'waiting' | 'done'; status: 'starting' | 'live' | 'exited'
  exit: { text: string; failed: boolean } | null; linked: boolean; linkEnabled: boolean
}
export interface DividerModel { id: string; rect: Rect; orientation: 'vertical' | 'horizontal' }
export interface FindModel { open: boolean; paneId: string | null; query: string; caseSensitive: boolean; regex: boolean; count: { index: number; total: number; capped: boolean } | null; miss: boolean }
export interface RestoreCardModel { tabs: number; panes: number; savedAt: string }
export interface ChordModel { chord: string; command: string }
export interface UiModel {
  seq: number
  window: { title: string; uiScale: number; fontPx: number; tabStripH: number; statusH: number }
  tabs: TabModel[]; tabFull: boolean; sleep: boolean; zoomBadge: string | null
  panes: PaneModel[]; dividers: DividerModel[]; zoomedPaneId: string | null; emptyState: boolean; starting: boolean
  find: FindModel; restore: RestoreCardModel | null; toast: string | null
  status: { panes: string; inPanes: string; used: string; usedLevel: 'ok' | 'warn' | 'crit'; compressed: string | null; swap: string | null; swapWarn: boolean; hint: string }
  chords: ChordModel[]
  tokens: Record<string, string>   // the Aero token table, Task 16 fills it; empty until then
}
export type UiEvent =
  | { type: 'click' | 'dblclick' | 'down' | 'up' | 'move'; target: string; x: number; y: number; button: 0 | 1 | 2; mods: Mods }
  | { type: 'wheel'; target: string; x: number; y: number; dy: number; mods: Mods }
  | { type: 'key'; target: string; key: string; mods: Mods }     // only for non-grid targets (edit widgets, sheets)
  | { type: 'text'; target: string; text: string }               // edit widget value changes
  | { type: 'drop'; target: string; paths: string[]; text: string | null }
  | { type: 'focus' | 'blur'; target: string }
export interface Mods { ctrl: boolean; alt: boolean; shift: boolean }
export interface Geometry { clientW: number; clientH: number; dpi: number; cellW: number; cellH: number }
export type TermEvent =
  | { type: 'title'; paneId: string; title: string }
  | { type: 'cwd'; paneId: string; cwd: string }
  | { type: 'bell'; paneId: string }
  | { type: 'pathclick'; paneId: string; line: string; index: number; mods: Mods }
  | { type: 'selection'; paneId: string; text: string }
  | { type: 'findResult'; paneId: string; index: number; total: number; capped: boolean }
export type GridCmd =
  | { paneId: string; op: 'create'; cols: number; rows: number; fontPx: number; scrollback: number }
  | { paneId: string; op: 'dispose' }
  | { paneId: string; op: 'resize'; cols: number; rows: number; fontPx: number }
  | { paneId: string; op: 'focus' } | { paneId: string; op: 'clear' } | { paneId: string; op: 'selectAll' }
  | { paneId: string; op: 'find'; query: string; direction: 'next' | 'prev'; caseSensitive: boolean; regex: boolean; incremental: boolean }
  | { paneId: string; op: 'findClear' } | { paneId: string; op: 'paste'; text: string } | { paneId: string; op: 'copy' }
  | { paneId: string; op: 'exited'; failed: boolean }
```

  Target id grammar (hit testing on the shell side keys on these): `tab:<id>`, `tab:<id>:close`, `tab:new`, `tab:<id>:rename` (the edit widget), `strip:empty`, `pane:<id>:title`, `pane:<id>:close`, `pane:<id>:color`, `pane:<id>:link`, `pane:<id>:restart`, `pane:<id>:grid`, `divider:<id>`, `find:query`, `find:case`, `find:regex`, `find:next`, `find:prev`, `find:close`, `restore:yes`, `restore:fresh`, `zoom:badge`, `sleep`, `settings`, `empty:newtab`, `web:new`, `pane:new`.
- Produces `controller.ts`:

```ts
export interface ControllerDeps {
  invoke<T = unknown>(ch: string, p: unknown): Promise<T>     // shim.invokeLocal
  send(ch: string, p: unknown): void                          // shim.sendLocal
  toShell(ch: 'ui:model' | 'grid:cmd', p: unknown): void       // write an on envelope
  invokeShell<T = unknown>(ch: string, p: unknown): Promise<T>
  now(): number
  setTimer(fn: () => void, ms: number): () => void
  platform: string                                             // 'win32' for keys.ts spelling
}
export class Controller {
  constructor(deps: ControllerDeps, opts: { home: string; version: string; chords: ChordModel[] })
  boot(geometry: Geometry): Promise<void>        // getPaths, ui-state, session:load, restore card or first tab
  geometry(g: Geometry): void                     // from shell:geometry; recomputes rects, resizes grids
  command(name: string): void                     // the 32 ui:command values
  event(e: UiEvent): void
  term(e: TermEvent): void
  push(ch: string, p: unknown): void              // pty:exit, metrics:tick, app:toast, update:state, ui:command, session:requestSnapshot, watch:*
  model(): UiModel                                // the last emitted model
  /** @internal for tests */ state(): AppState
}
```

  The controller holds `AppState` (reducer), plus `UiState` (`zoomIndex`, `settings`, `sidebarWidth`, `drawerHeight`, `tutorialSeen`, `dismissedUpdate`, from `ui-state.ts`, persisted to `<userData>/ui-state.json` through `fs:writeTextFile`? No: through a new local helper `uiState.save()` using `node:fs` directly in the core, since the file is the core's own), the rename field, the find state, the toast timer, the restore candidate, and emits `ui:model` after every mutation (coalesced to one per macrotask with `queueMicrotask`). `layout.ts` turns the active tab's tree plus `Geometry` plus `uiScale` into `PaneModel.rect`, `gridRect` (rect minus the 24 px title bar scaled), `cols`/`rows` (`floor(gridRect.w / cellW)`, `floor(gridRect.h / cellH)`), and `DividerModel[]` via `computeLayout` and `deriveDividers`; a divider drag is `applyDividerDrag` on `down`/`move`/`up` for `divider:*` targets.
- Produces `chords.ts`: `chordTableFromMenu(menu: MenuTemplateLike, platform: string): ChordModel[]` walking the stored menu template for every item with an `accelerator` and a known command; `commandForItem(label)` maps the menu labels in `src/main/menu.ts` to the `ui:command` values (the same mapping `menu.ts` uses in its `click` handlers: read them, do not re-invent). Plus the three zoom chords and the per-pane zoom chords from `app.tsx:1116-1144` in Windows spelling (`Ctrl+=`, `Ctrl+-`, `Ctrl+0`, `Ctrl+Shift+=`, `Ctrl+Shift+-`).

- [ ] **Step 1: Failing model and command tests**

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'

export function fakeDeps() {
  const sent: Array<[string, unknown]> = []
  const shellOut: Array<[string, unknown]> = []
  const handlers: Record<string, (p: unknown) => unknown> = {
    'app:getPaths': () => ({ home: '/Users/joshwald', hostname: 'jarvis', userData: '/mnt/c/scratch/ud', defaultShell: '/usr/bin/zsh', cwdOfLaunch: '/Users/joshwald', platform: 'win32', host: 'native' }),
    'session:load': () => null,
    'pty:spawn': () => ({ ok: true, pid: 100 }),
    'pty:kill': () => ({ ok: true, survivors: 0 }),
    'session:save': () => undefined,
    'session:clear': () => undefined,
  }
  const timers: Array<{ fn: () => void; at: number }> = []
  let t = 1000
  const deps = {
    invoke: async (ch: string, p: unknown) => { sent.push([ch, p]); const h = handlers[ch]; if (!h) throw new Error(`no fake for ${ch}`); return h(p) },
    send: (ch: string, p: unknown) => { sent.push([ch, p]) },
    toShell: (ch: string, p: unknown) => { shellOut.push([ch, p]) },
    invokeShell: async () => ({ ok: true }),
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const e = { fn, at: t + ms }; timers.push(e); return () => { const i = timers.indexOf(e); if (i >= 0) timers.splice(i, 1) } },
    platform: 'win32',
  }
  const advance = (ms: number) => { t += ms; for (const e of [...timers]) if (e.at <= t) { timers.splice(timers.indexOf(e), 1); e.fn() } }
  const models = () => shellOut.filter(([ch]) => ch === 'ui:model').map(([, p]) => p as import('../../src/core/controller/model.js').UiModel)
  const grid = () => shellOut.filter(([ch]) => ch === 'grid:cmd').map(([, p]) => p as import('../../src/core/controller/model.js').GridCmd)
  return { deps, sent, shellOut, handlers, advance, models, grid }
}
const GEO = { clientW: 1440, clientH: 900, dpi: 96, cellW: 7.8, cellH: 15 }

describe('controller: boot and tabs', () => {
  it('boots to one tab with one live term pane at home when there is no session', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const m = c.model()
    expect(m.starting).toBe(false)
    expect(m.tabs).toHaveLength(1)
    expect(m.tabs[0]!.name).toBe('~')
    expect(m.panes).toHaveLength(1)
    expect(m.panes[0]!.kind).toBe('term')
    expect(f.grid().find((g) => g.op === 'create')).toMatchObject({ cols: expect.any(Number), rows: expect.any(Number), scrollback: 20000 })
    expect(f.sent.find(([ch]) => ch === 'pty:spawn')?.[1]).toMatchObject({ cwd: '/Users/joshwald', file: '/usr/bin/zsh' })
  })
  it('tab.new opens a tab at home and tab.close kills its panes', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('tab.new')
    expect(c.model().tabs).toHaveLength(2)
    expect(c.model().tabs[1]!.active).toBe(true)
    c.command('tab.close')
    await new Promise((r) => setImmediate(r))
    expect(c.model().tabs).toHaveLength(1)
    expect(f.sent.some(([ch]) => ch === 'pty:kill')).toBe(true)
  })
  it('pane.new refuses the seventh pane with the toast', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    for (let i = 0; i < 6; i++) c.command('pane.new')
    expect(c.model().panes).toHaveLength(6)
    expect(c.model().tabFull).toBe(true)
    expect(c.model().toast).toBe('Tab is full (6 panes) - open a new tab (Ctrl+Shift+T)')
  })
  it('rects tile the grid area, dividers sit between panes, cols and rows come from the cell size', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const m = c.model()
    expect(m.panes).toHaveLength(2)
    expect(m.dividers).toHaveLength(1)
    expect(m.dividers[0]!.orientation).toBe('vertical')
    for (const p of m.panes) {
      expect(p.cols).toBe(Math.floor(p.gridRect.w / GEO.cellW))
      expect(p.rows).toBe(Math.floor(p.gridRect.h / GEO.cellH))
      expect(p.gridRect.h).toBe(p.rect.h - 24)
    }
  })
  it('a divider drag changes the two neighbours and marks the tab non-pristine', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const d = c.model().dividers[0]!
    const before = c.model().panes.map((p) => p.rect.w)
    const mods = { ctrl: false, alt: false, shift: false }
    c.event({ type: 'down', target: `divider:${d.id}`, x: d.rect.x + 4, y: 300, button: 0, mods })
    c.event({ type: 'move', target: `divider:${d.id}`, x: d.rect.x + 104, y: 300, button: 0, mods })
    c.event({ type: 'up', target: `divider:${d.id}`, x: d.rect.x + 104, y: 300, button: 0, mods })
    const after = c.model().panes.map((p) => p.rect.w)
    expect(after[0]).toBeGreaterThan(before[0]!)
    expect(after[1]).toBeLessThan(before[1]!)
    expect(c.state().tabs[0]!.pristine).toBe(false)
  })
  it('zoom in bumps fontPx and the badge, reset clears it', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('ui.zoomIn')
    expect(c.model().window.fontPx).toBe(16)
    expect(c.model().zoomBadge).toBe('110%')
    c.command('ui.zoomReset')
    expect(c.model().zoomBadge).toBeNull()
  })
  it('tab rename: double-click opens the field, Enter commits up to 40 chars, blank reverts', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const id = c.model().tabs[0]!.id
    const mods = { ctrl: false, alt: false, shift: false }
    c.event({ type: 'dblclick', target: `tab:${id}`, x: 0, y: 0, button: 0, mods })
    expect(c.model().tabs[0]!.renaming).toBe(true)
    c.event({ type: 'text', target: `tab:${id}:rename`, text: 'x'.repeat(50) })
    c.event({ type: 'key', target: `tab:${id}:rename`, key: 'Enter', mods })
    expect(c.model().tabs[0]!.name).toBe('x'.repeat(40))
    c.event({ type: 'dblclick', target: `tab:${id}`, x: 0, y: 0, button: 0, mods })
    c.event({ type: 'text', target: `tab:${id}:rename`, text: '' })
    c.event({ type: 'key', target: `tab:${id}:rename`, key: 'Enter', mods })
    expect(c.model().tabs[0]!.name).toBe('~')
  })
  it('a toast clears after 3.2 s', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.push('app:toast', { message: 'hello' })
    expect(c.model().toast).toBe('hello')
    f.advance(3300)
    expect(c.model().toast).toBeNull()
  })
})
```

Chord test:

```ts
import { describe, expect, it } from 'vitest'
import { chordTableFromMenu } from '../../src/core/controller/chords.js'

describe('chord table', () => {
  it('maps the menu template accelerators to commands in Windows spelling', () => {
    const menu = { items: [{ label: 'File', submenu: { items: [{ label: 'New Tab', accelerator: 'Ctrl+Shift+T' }, { label: 'New Pane', accelerator: 'Ctrl+Shift+D' }] } }] }
    const t = chordTableFromMenu(menu, 'win32')
    expect(t).toContainEqual({ chord: 'Ctrl+Shift+T', command: 'tab.new' })
    expect(t).toContainEqual({ chord: 'Ctrl+Shift+D', command: 'pane.new' })
    expect(t).toContainEqual({ chord: 'Ctrl+=', command: 'ui.zoomIn' })
    expect(t).toContainEqual({ chord: 'Ctrl+Shift+=', command: 'pane.zoomIn' })
  })
})
```

Run: FAIL, modules not found.

- [ ] **Step 2: Implement model.ts, layout.ts, ui-state.ts, chords.ts**

`layout.ts`:

```ts
import { computeLayout } from '../../renderer/layout/resize.js'
import { applyDividerDrag, columnBoxes, deriveDividers } from '../../renderer/layout/dividers.js'
import { DIVIDER_PX, TITLEBAR_PX, type CellSize, type PixelSize, type RowNode } from '../../renderer/layout/types.js'
import type { DividerModel, Geometry, Rect } from './model.js'

export interface LaidOut { rects: Map<string, Rect>; gridRects: Map<string, Rect>; dividers: DividerModel[]; cols: Map<string, number>; rows: Map<string, number> }

export function layOut(tree: RowNode, area: Rect, geo: Geometry, uiScale: number): LaidOut {
  const cell: CellSize = { width: geo.cellW, height: geo.cellH }
  const avail: PixelSize = { width: area.w, height: area.h }
  const rects = computeLayout(tree, avail, cell)   // PaneRect[] with paneId, x, y, width, height in the area's space
  const out: LaidOut = { rects: new Map(), gridRects: new Map(), dividers: [], cols: new Map(), rows: new Map() }
  const title = TITLEBAR_PX * uiScale
  for (const r of rects) {
    const rect = { x: area.x + r.x, y: area.y + r.y, w: r.width, h: r.height }
    const grid = { x: rect.x, y: rect.y + title, w: rect.w, h: Math.max(0, rect.h - title) }
    out.rects.set(r.paneId, rect); out.gridRects.set(r.paneId, grid)
    out.cols.set(r.paneId, Math.max(1, Math.floor(grid.w / cell.width)))
    out.rows.set(r.paneId, Math.max(1, Math.floor(grid.h / cell.height)))
  }
  for (const d of deriveDividers(tree, rects, columnBoxes(tree, rects))) {
    out.dividers.push({ id: d.id, orientation: d.orientation, rect: { x: area.x + d.x, y: area.y + d.y, w: d.width, h: d.height } })
  }
  return out
}
```

Read `src/renderer/layout/dividers.ts:51-170` for the exact `deriveDividers` and `applyDividerDrag` signatures (the `DividerSpec` fields and the drag's arguments) before writing the calls above; the tree operations come from `../../renderer/layout/tree.js` and `auto-arrange.js`.

`ui-state.ts`: `interface UiState { zoomIndex: number; settings: Settings; sidebarWidth: number; drawerHeight: number; tutorialSeen: boolean; dismissedUpdate: string | null }`, `loadUiState(file): UiState` (missing or malformed file gives the defaults: `DEFAULT_ZOOM_INDEX`, `coerceSettings(undefined)`, `SIDEBAR_DEFAULT`, `DRAWER_DEFAULT`, `false`, `null`), `saveUiState(file, s)` (write `<file>.tmp`, rename).

`chords.ts`: walk `menu.items[*].submenu.items[*]` recursively; for each item with an `accelerator`, map `label` to a command with the table copied from `src/main/menu.ts` (read the `click` bodies: each is `send('<command>')`), spell the accelerator with `accelerator(mac, platform)` from `keys.ts` when the template still holds the Mac form, and append the zoom chords.

`controller.ts`: the class as in Interfaces. Port from `app.tsx` the handlers for `tab.*`, `pane.new/close/next/prev/zoom/clear`, `layout.rebalance`, `ui.zoom*`, `edit.find/findNext/findPrev/copy/paste/selectAll`, `tab.rename`; the boot order from `app.tsx:328-365`; the toast from `app.tsx:1255-1259`; the pane spawn from `PaneView.tsx:397-430` (spawn after the grid's first size is known: `grid:cmd create` then `pty:spawn` with the laid-out cols and rows, then the launch command 300 ms later as `pty:write`); `pane.close` from `app.tsx:415-432` (`pty:kill`, survivors toast); `tab.close` from `app.tsx:434-457`. Commands owned by Phase 2 (`drawer.toggle`, `explorer.*`, `help.tutorial`, `app.projects`, `app.saveProject`, `app.saveTab`, `app.settings`, `preview.*`, `pane.closeAll`) toast `"<name> arrives in phase 2"`; the report lists them. Every mutation ends in `this.emit()`, which rebuilds the model and calls `toShell('ui:model', model)` once per macrotask.

- [ ] **Step 3: Run the tests**

`npx vitest run test/unit/controller-model.test.ts test/unit/controller-commands.test.ts test/unit/controller-chords.test.ts --project unit` Expected: PASS, 9 tests. `npm run typecheck` Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/core/controller test/unit/controller-model.test.ts test/unit/controller-commands.test.ts test/unit/controller-chords.test.ts
git commit -m "Add the headless controller with the view model and commands"
```

---

### Task 5: Controller part 2: panes over time, session restore, find, status, attention

**Files:**
- Modify: `src/core/controller/controller.ts`
- Create: `src/core/controller/session.ts`, `src/core/controller/status.ts`
- Test: `test/unit/controller-session.test.ts`, `test/unit/controller-panes.test.ts`

**Interfaces:**
- Consumes: `shouldOfferRestore` (`src/renderer/session/offer.ts`); `stateToTabs`, `tabsFromSaved`, `planRestore`, `applyRestoreIds`, `launchCommandText`, `applyLaunchModes`, `saveLookupFrom` (`src/renderer/projects/serialize.ts`); `cleanPaneTitle`; `parseOsc7` (`src/renderer/term/osc7.ts`, the exported parser; read the file for its name); `nextAttention`, `doneExpired`; `isAgentForeground` (`src/renderer/term/inputline.ts`).
- Produces: in the controller: `push('pty:exit', ...)` sets the pane to `exited` with the overlay text (`exited · code N` or `killed · signal N`, `failed` when the code is non-zero) and sends `grid:cmd exited`; `pane:<id>:restart` bumps the generation, sends `grid:cmd dispose` then `create`, respawns; `push('metrics:tick', ...)` updates badges, memory badges (200 MB, high past 1 GB), the status bar strings (`status.ts` formats bytes as the renderer's `StatusBar.tsx` does: read it) and attention transitions (`done` when PROMPT follows BUSY or WAITING, expiring after 9 s; `waiting` from the bell when unfocused and not PROMPT); `term({type:'title'})` sets the label when `settings.autoTitlePanes` and the label is not custom; `term({type:'cwd'})` updates `pane.cwd` and the label; `term({type:'bell'})` dispatches `pane.bell`; `term({type:'findResult'})` fills `find.count` and `miss`; find: `edit.find` opens the bar on the focused term pane (`find.paneId`), `text` on `find:query` debounced 120 ms sends `grid:cmd find` incremental, `find:next`/`find:prev`/Enter/Shift+Enter send non-incremental, `Escape` anywhere closes and sends `findClear`; `edit.copy` sends `grid:cmd copy` (the shell writes the clipboard itself); `edit.paste` arrives from the shell as `ui:command` with `{text}` (see Task 13) and the controller applies the Windows-path conversion from `app.tsx:1018-1065` before `grid:cmd paste`; `edit.selectAll` sends `grid:cmd selectAll`.
- Produces `session.ts`: `snapshotTabs(state, lookup): SavedTab[]` via `stateToTabs`; the 30 s timer (only when changed, compare the serialized JSON) calling `session:save`; `push('session:requestSnapshot')` saves at once; `boot` calls `session:load`, shows the restore card when `shouldOfferRestore(tabs)`, `restore:yes` restores through `planRestore`, `tabsFromSaved`, `projects:sessionIds`, `projects:resumeModes`, `applyLaunchModes` and types `launchCommandText(pane)` 300 ms after each spawn; `restore:fresh` or Escape clears the snapshot (`session:clear`) and opens one tab at home.

- [ ] **Step 1: Failing session and pane tests**

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps } from './controller-model.test.js'
import { buildW10 } from '../../scripts/bakeoff/make-session.mjs'

const GEO = { clientW: 1440, clientH: 900, dpi: 96, cellW: 7.8, cellH: 15 }
const mods = { ctrl: false, alt: false, shift: false }

describe('controller: session', () => {
  it('offers the restore card for a saved window and restores 9 tabs and 10 panes on Restore', async () => {
    const f = fakeDeps()
    f.handlers['session:load'] = () => buildW10('/Users/joshwald')
    f.handlers['projects:sessionIds'] = () => ({ ids: {}, sources: {} })
    f.handlers['projects:resumeModes'] = () => ({ modes: {}, bypassConsented: false })
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    expect(c.model().restore).toMatchObject({ tabs: 9, panes: 10 })
    c.event({ type: 'click', target: 'restore:yes', x: 0, y: 0, button: 0, mods })
    await new Promise((r) => setTimeout(r, 10))
    expect(c.model().restore).toBeNull()
    expect(c.model().tabs).toHaveLength(9)
    expect(c.state().tabs.reduce((n, t) => n + Object.keys(t.panes).length, 0)).toBe(10)
    expect(f.sent.filter(([ch]) => ch === 'pty:spawn')).toHaveLength(10)
  })
  it('Start fresh clears the snapshot and opens one tab', async () => {
    const f = fakeDeps()
    f.handlers['session:load'] = () => buildW10('/Users/joshwald')
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.event({ type: 'key', target: 'restore', key: 'Escape', mods })
    await new Promise((r) => setTimeout(r, 10))
    expect(f.sent.some(([ch]) => ch === 'session:clear')).toBe(true)
    expect(c.model().tabs).toHaveLength(1)
  })
  it('snapshots every 30 s only when changed and at once on session:requestSnapshot', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const saves = () => f.sent.filter(([ch]) => ch === 'session:save').length
    f.advance(30_000); await new Promise((r) => setImmediate(r))
    const n = saves()
    f.advance(30_000); await new Promise((r) => setImmediate(r))
    expect(saves()).toBe(n)
    c.command('tab.new'); f.advance(30_000); await new Promise((r) => setImmediate(r))
    expect(saves()).toBe(n + 1)
    c.push('session:requestSnapshot', undefined); await new Promise((r) => setImmediate(r))
    expect(saves()).toBe(n + 2)
  })
})

describe('controller: panes over time', () => {
  it('pty:exit shows the overlay and Restart respawns with a fresh grid', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    c.push('pty:exit', { paneId: id, exitCode: 1, signal: null, ranMs: 10 })
    expect(c.model().panes[0]).toMatchObject({ status: 'exited', exit: { text: 'exited · code 1', failed: true } })
    const creates = () => f.grid().filter((g) => g.op === 'create').length
    const before = creates()
    c.event({ type: 'click', target: `pane:${id}:restart`, x: 0, y: 0, button: 0, mods })
    await new Promise((r) => setImmediate(r))
    expect(f.grid().some((g) => g.op === 'dispose' && g.paneId === id)).toBe(true)
    expect(creates()).toBe(before + 1)
    expect(c.model().panes[0]!.status).not.toBe('exited')
  })
  it('metrics drive the badge, the memory badge and the status bar', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    c.push('metrics:tick', { panes: [{ paneId: id, footprintBytes: 1.5e9, cpuFrac: 0, state: 'BUSY', foregroundProcess: 'claude', procCount: 3, cwd: '/Users/joshwald' }], system: { usedBytes: 20e9, totalBytes: 32e9, compressorBytes: 0, swapUsedBytes: 3e9, swapTotalBytes: 8e9, pressureLevel: 'warn' } })
    const p = c.model().panes[0]!
    expect(p.badge).toBe('claude')
    expect(p.memBadge).toBe('~1.5 GB')
    expect(p.memHigh).toBe(true)
    expect(c.model().status.swapWarn).toBe(true)
    expect(c.model().status.panes).toBe('1 pane')
  })
  it('attention: bell on an unfocused busy pane is waiting, PROMPT after BUSY is done and expires', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const other = c.model().panes.find((p) => !p.focused)!
    c.push('metrics:tick', { panes: [{ paneId: other.id, footprintBytes: 0, cpuFrac: 0, state: 'BUSY', foregroundProcess: 'claude', procCount: 1, cwd: '/' }], system: null })
    c.term({ type: 'bell', paneId: other.id })
    expect(c.model().panes.find((p) => p.id === other.id)!.attention).toBe('waiting')
    c.push('metrics:tick', { panes: [{ paneId: other.id, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'claude', procCount: 1, cwd: '/' }], system: null })
    expect(c.model().panes.find((p) => p.id === other.id)!.attention).toBe('done')
    f.advance(9100)
    expect(c.model().panes.find((p) => p.id === other.id)!.attention).toBe('none')
  })
  it('title and cwd events relabel the pane unless the label is custom', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0]!.id
    c.term({ type: 'cwd', paneId: id, cwd: '/Users/joshwald/Desktop/seashell' })
    expect(c.model().panes[0]!.label).toBe('seashell')
    c.term({ type: 'title', paneId: id, title: 'josh@jarvis: vim notes.md' })
    expect(c.model().panes[0]!.label).toBe('vim notes.md')
  })
  it('find opens on the focused pane, debounces the query, and Escape clears', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0.6.0', chords: [] })
    await c.boot(GEO)
    c.command('edit.find')
    expect(c.model().find.open).toBe(true)
    c.event({ type: 'text', target: 'find:query', text: 'err' })
    expect(f.grid().filter((g) => g.op === 'find')).toHaveLength(0)
    f.advance(130)
    expect(f.grid().filter((g) => g.op === 'find').at(-1)).toMatchObject({ query: 'err', incremental: true, direction: 'next' })
    c.term({ type: 'findResult', paneId: c.model().panes[0]!.id, index: 2, total: 7, capped: false })
    expect(c.model().find.count).toEqual({ index: 2, total: 7, capped: false })
    c.event({ type: 'key', target: 'find:query', key: 'Escape', mods })
    expect(c.model().find.open).toBe(false)
    expect(f.grid().at(-1)).toMatchObject({ op: 'findClear' })
  })
})
```

Run: FAIL on the missing behaviour.

- [ ] **Step 2: Implement**

Port each behaviour from the inventory's file references (sections C, D, H, M, O, Q). `status.ts` copies the byte formatting from `src/renderer/status/StatusBar.tsx`. The 30 s snapshot compares `JSON.stringify(snapshotTabs(...))` to the last saved string. Restore types the launch command 300 ms after each `pty:spawn` resolves, as `PaneView.tsx:417-424` does.

- [ ] **Step 3: Run the tests**

`npx vitest run test/unit/controller-session.test.ts test/unit/controller-panes.test.ts --project unit` Expected: PASS, 8 tests. `npm test` Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/core/controller test/unit/controller-session.test.ts test/unit/controller-panes.test.ts
git commit -m "Add session restore, pane lifecycle, find and status to the controller"
```

---

### Task 6: The core entry, the bundle, a headless smoke under WSL

**Files:**
- Create: `src/core/index.ts` (replace the placeholder), `scripts/core-smoke.mjs`
- Modify: `src/main/index.ts` only where a top-level statement cannot run under the shim (expected: none; record each change as one line in the commit body)

**Interfaces:**
- Produces: `out/core/index.cjs` that, started as `SEASHELL_HOST=native-win SEASHELL_HOST_PID=<pid> SEASHELL_USER_DATA=<dir> node out/core/index.cjs`, reads envelopes on stdin and writes them on stdout; its first output after `{k:'send',ch:'shell:geometry',p:Geometry}` arrives is `{k:'on',ch:'ui:model',p:{...}}`; a pane spawns and `pty:data` batches follow.

- [ ] **Step 1: index.ts**

```ts
import { createShim } from './electron-shim.js'
import { startStdio } from './stdio-bridge.js'
import { Controller } from './controller/controller.js'
import { chordTableFromMenu } from './controller/chords.js'
import { encodeEnvelope } from './protocol.js'

const hostPid = Number(process.env.SEASHELL_HOST_PID) || process.ppid
const userData = process.env.SEASHELL_USER_DATA
if (!userData || !userData.startsWith('/')) { process.stderr.write('[core] SEASHELL_USER_DATA must be an absolute Linux path\n'); process.exit(2) }
const version = process.env.SEASHELL_CORE_VERSION ?? '0.0.0'
const write = (line: string) => { process.stdout.write(line + '\n') }

let controller: Controller | null = null
const queued: Array<[string, unknown]> = []
const shim = createShim({ write, hostPid, userData, version, onPush: (ch, p) => { if (controller) route(ch, p); else queued.push([ch, p]) } })
;(globalThis as Record<string, unknown>).__seashellCore = shim
startStdio(shim)

function route(ch: string, p: unknown): void {
  const c = controller!
  if (ch === 'ui:event') c.event(p as never)
  else if (ch === 'ui:command') c.command((p as { command: string }).command)
  else if (ch === 'term:event') c.term(p as never)
  else if (ch === 'shell:geometry') { if (!booted) { booted = true; void c.boot(p as never) } else c.geometry(p as never) }
  else c.push(ch, p)
}
let booted = false

await import('../main/index.js')   // registers ipc handlers, starts the control endpoint, the monitor, the updater

const menu = shim.Menu.getApplicationMenu()
controller = new Controller(
  {
    invoke: (ch, p) => shim.invokeLocal(ch, p),
    send: (ch, p) => shim.sendLocal(ch, p),
    toShell: (ch, p) => write(encodeEnvelope({ k: 'on', ch, p })),
    invokeShell: (ch, p) => shim.invokeShell(ch, p),
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    platform: 'win32',
  },
  { home: process.env.HOME ?? '/', version, chords: chordTableFromMenu(menu, 'win32') }
)
for (const [ch, p] of queued) route(ch, p)
```

`src/main/index.ts` calls `createWindow()`, which under the shim constructs the virtual window; `app.whenReady()` resolves on the next tick. Any statement that still touches a real Electron API fails loudly in step 3; add the symbol to the shim with a test rather than stubbing it in `main`.

- [ ] **Step 2: core-smoke.mjs**

```js
// Starts the core the way the shell will, drives it over stdio, and checks the first model and the first prompt.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
const ud = process.argv[2] ?? '/tmp/seashell-core-smoke'
mkdirSync(ud, { recursive: true })
const core = spawn('/usr/bin/node', ['out/core/index.cjs'], { env: { ...process.env, SEASHELL_HOST: 'native-win', SEASHELL_HOST_PID: String(process.pid), SEASHELL_USER_DATA: ud }, stdio: ['pipe', 'pipe', 'inherit'] })
const send = (e) => core.stdin.write(JSON.stringify(e) + '\n')
let buf = '', model = null, prompt = false
core.stdout.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    const e = JSON.parse(line)
    if (e.ch === 'ui:model') model = e.p
    if (e.ch === 'pty:data') for (const b of e.p.batches) if (Buffer.from(b.data, 'base64').toString().includes('%')) prompt = true
  }
})
send({ k: 'send', ch: 'shell:geometry', p: { clientW: 1440, clientH: 900, dpi: 96, cellW: 7.8, cellH: 15 } })
const t0 = Date.now()
while (Date.now() - t0 < 15000 && !(model && prompt)) await new Promise((r) => setTimeout(r, 100))
console.log(JSON.stringify({ model: model ? { tabs: model.tabs.length, panes: model.panes.length, cols: model.panes[0]?.cols } : null, prompt }))
send({ k: 'send', ch: 'app:beforeQuit', p: {} })
setTimeout(() => core.kill(), 3000)
```

- [ ] **Step 3: Build, run the smoke**

`node scripts/build-core.mjs && node scripts/core-smoke.mjs /tmp/seashell-core-smoke` Expected: `{"model":{"tabs":1,"panes":1,"cols":<n>},"prompt":true}` and a clean exit. Then check the contract from the outside: `ls ~/.cache/seashell-win/pids/$$/` shows `pane-*.pid` with `<pid> pts/N`, `cat /tmp/seashell-core-smoke/control.json` shows `pid` equal to the smoke's own pid (the fake host pid) and a `corePid`. `~/.claude/bin/send-to-pane.py` is not run here (Task 18 does, from a real pane).

- [ ] **Step 4: Gate A, snapshot, report**

`npm run typecheck && npm test` clean, `node scripts/build-core.mjs` clean, smoke green.

```bash
git add src/core/index.ts scripts/core-smoke.mjs
git commit -m "Run the main process and the controller as the core under WSL"
git branch -f snapshot/native-after-core
```

Append "Stage A: core" to the report (Task 18 format): the smoke output, the pid file and control.json lines, the test counts.

---
## Stage B: the shell foundation (Tasks 7 to 9)

### Task 7: Shell skeleton: window, glass strip, body surface, DPI, bounds, single instance, build script

**Files:**
- Create: `native/shell/CMakeLists.txt`, `native/shell/vcpkg.json`, `native/shell/app.rc`, `native/shell/app.manifest`, `native/shell/src/main.cpp`, `native/shell/src/app.h`, `native/shell/src/app.cpp`, `native/shell/src/window.h`, `native/shell/src/window.cpp`, `native/shell/src/gfx.h`, `native/shell/src/gfx.cpp`, `native/shell/src/paths.h`, `native/shell/src/paths.cpp`, `native/shell/src/log.h`, `native/shell/src/log.cpp`
- Create: `scripts/win/build-shell.cmd`

**Interfaces:**
- Produces: `SeaShell.exe` (class `SeaShellHost`, title `SeaShell`, AppUserModelID `dev.seashell.app`, icon `build/icon.ico`, mutex `Local\SeaShellHost-<SEASHELL_INSTANCE or default>`; a second launch with the same instance name posts `WM_COPYDATA` with `{"k":"send","ch":"app:secondInstance","p":{}}` to the first and exits), reading `SEASHELL_USER_DATA` (Windows path; default `%APPDATA%\seashell`), `SEASHELL_INSTANCE`, `SEASHELL_TEST_PORT`, `SEASHELL_CORE_DIR` (Linux path of a built core to run directly, dev only), `SEASHELL_SHELL_LOG` (a file every envelope channel and every error is appended to).
- Produces `window.h`:

```cpp
struct Dpi { float dpi = 96.f; float scale() const { return dpi / 96.f; } };
class Window {
public:
  static Window& instance();
  HWND hwnd() const;            // the top-level window (glass strip lives here)
  HWND body() const;            // the opaque child covering everything below the strip
  Dpi dpi() const;
  int stripHeightPx() const;    // 38 DIP times scale, the IE9 tab row (DWM caption buttons sit in it)
  RECT bodyRect() const;        // client rect minus the strip
  void invalidateStrip();
  void invalidateBody(const RECT* r = nullptr);
  void setTitle(const std::wstring& s);
  void post(UINT msg, WPARAM w = 0, LPARAM l = 0);   // PostMessage to hwnd()
  // WM_APP messages the rest of the shell uses:
  static constexpr UINT WM_APP_CORE_LINE = WM_APP + 1;   // lParam: std::string* (heap, receiver deletes)
  static constexpr UINT WM_APP_CORE_EXIT = WM_APP + 2;   // wParam: exit code
  static constexpr UINT WM_APP_DRIVER   = WM_APP + 3;   // lParam: DriverCall* (Task 9)
  static constexpr UINT WM_APP_PTY_FEED = WM_APP + 4;   // batched pty bytes ready (Task 11)
};
```

  The top-level window uses the DWM custom frame recipe: `WM_NCCALCSIZE` with `wParam == TRUE` returns 0 (the whole window is client), insetting by `GetSystemMetrics(SM_CXSIZEFRAME) + SM_CXPADDEDBORDER` on every side when maximized; `DwmExtendFrameIntoClientArea` with `MARGINS{0, 0, stripHeightPx(), 0}` on `WM_ACTIVATE`, `WM_DPICHANGED` and `WM_DWMCOMPOSITIONCHANGED`; `WM_NCHITTEST` first offers the message to `DwmDefWindowProc` (so DWM's own caption buttons in the extended frame hit and paint), then returns `HTTOP`, `HTLEFT`, ... for the 8 DIP resize borders, `HTCAPTION` for strip points the UI (Task 15) reports as `strip:empty`, `HTCLIENT` elsewhere. The strip is painted in `WM_PAINT` of the top-level window through a 32-bpp premultiplied DIB bound to an `ID2D1DCRenderTarget`, then `BitBlt` to the window DC, so alpha-0 pixels show the glass (the MSDN "Custom Window Frame Using DWM" technique); `WM_ERASEBKGND` returns 1. The body is a child window (class `SeaShellBody`, `WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN`) owning an `ID2D1HwndRenderTarget` (hardware) that Task 12 and Task 15 draw into; it is resized in `WM_SIZE` to `bodyRect()`. Mouse and keyboard messages on either window route to `Ui` (Task 15) and the grids (Task 13) through `App`.
- Produces `gfx.h`: `Gfx::instance()` holding `ID2D1Factory1*`, `IDWriteFactory*`, `IWICImagingFactory*`; `Gfx::bodyTarget()` (recreated on `D2DERR_RECREATE_TARGET`), `Gfx::stripTarget(HDC, RECT)`.
- Produces `paths.h`: `std::wstring userDataWin()`, `std::string userDataLinux()` (`C:\a\b` to `/mnt/c/a/b`), `std::wstring toWindowsPath(const std::string& linuxPath)` (`/mnt/c/x` to `C:\x`, else `\\wsl.localhost\Ubuntu-24.04\x`), `std::wstring boundsFile()` (`<userData>\window-bounds.json`), `loadBounds()` / `saveBounds()` with the same keys as `src/main/window-bounds.ts` (`{x, y, width, height, maximized}`), clamped to the matching monitor's work area.
- Produces `app.h`: `App::run(HINSTANCE)`, `App::quit(int code)`, `App::log(const char* fmt, ...)`.

- [ ] **Step 1: Manifest, resources, CMake, vcpkg**

`native/shell/vcpkg.json`: `{ "name": "seashell-shell", "version-string": "0.6.0", "dependencies": ["utf8proc", "nlohmann-json"] }`.

`native/shell/app.manifest` declares `PerMonitorV2` DPI awareness (`<dpiAwareness>PerMonitorV2</dpiAwareness>`) and the common-controls 6 dependency. `native/shell/app.rc`: `IDI_APP ICON "..\\..\\build\\icon.ico"`, the manifest as `1 RT_MANIFEST "app.manifest"`, and a `VERSIONINFO` block with `ProductName "SeaShell"`, `FileDescription "SeaShell"`, version `0.6.0.0`.

`native/shell/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.25)
project(seashell_shell C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(unofficial-utf8proc CONFIG REQUIRED)   # vcpkg exports utf8proc as unofficial::utf8proc
find_package(nlohmann_json CONFIG REQUIRED)
add_subdirectory(../third_party/libvterm ${CMAKE_BINARY_DIR}/libvterm)   # Task 10 adds it; comment out until then
file(GLOB SHELL_SRC CONFIGURE_DEPENDS src/*.cpp src/ui/*.cpp)
add_executable(SeaShell WIN32 ${SHELL_SRC} app.rc)
target_include_directories(SeaShell PRIVATE src)
target_link_libraries(SeaShell PRIVATE unofficial::utf8proc nlohmann_json::nlohmann_json vterm d2d1 dwrite dwmapi windowscodecs shlwapi ws2_32 shell32 ole32 uxtheme)
target_compile_definitions(SeaShell PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(SeaShell PRIVATE /W3 /utf-8 /EHsc)
```

If vcpkg's utf8proc port exports a different target name, `vcpkg install utf8proc` prints the correct `find_package` lines; use those.

`scripts/win/build-shell.cmd`:

```bat
@echo off
cd /d C:\seashell-build\redesign
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cmake -S C:\seashell-build\redesign\native\shell -B C:\seashell-build\redesign\shell-build -A x64 -DCMAKE_TOOLCHAIN_FILE=C:\Users\josh\dev\vcpkg\scripts\buildsystems\vcpkg.cmake || exit /b 1
cmake --build C:\seashell-build\redesign\shell-build --config Release || exit /b 1
echo built C:\seashell-build\redesign\shell-build\Release\SeaShell.exe
```

Run from WSL: `scripts/win/sync-tree.sh && cmd.exe /c C:\seashell-build\redesign\scripts\win\build-shell.cmd`.

- [ ] **Step 2: window.cpp**

The frame recipe, concretely (the parts that are easy to get wrong):

```cpp
case WM_NCCALCSIZE:
  if (wParam) {
    if (IsZoomed(hwnd)) {
      auto* p = reinterpret_cast<NCCALCSIZE_PARAMS*>(lParam);
      int fx = GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
      int fy = GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
      p->rgrc[0].left += fx; p->rgrc[0].right -= fx; p->rgrc[0].top += fy; p->rgrc[0].bottom -= fy;
    }
    return 0;
  }
  break;
case WM_NCHITTEST: {
  LRESULT dwm = 0;
  if (DwmDefWindowProc(hwnd, msg, wParam, lParam, &dwm)) return dwm;   // DWM's caption buttons
  POINT pt{ GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam) }; ScreenToClient(hwnd, &pt);
  RECT rc; GetClientRect(hwnd, &rc);
  int b = (int)std::lround(8 * scale);
  bool top = pt.y < b, bottom = pt.y >= rc.bottom - b, left = pt.x < b, right = pt.x >= rc.right - b;
  if (!IsZoomed(hwnd)) {
    if (top && left) return HTTOPLEFT; if (top && right) return HTTOPRIGHT;
    if (bottom && left) return HTBOTTOMLEFT; if (bottom && right) return HTBOTTOMRIGHT;
    if (top) return HTTOP; if (bottom) return HTBOTTOM; if (left) return HTLEFT; if (right) return HTRIGHT;
  }
  if (pt.y < stripHeightPx() && Ui::instance().stripTargetAt(pt) == "strip:empty") return HTCAPTION;
  return HTCLIENT;
}
case WM_ACTIVATE: case WM_DWMCOMPOSITIONCHANGED: { MARGINS m{0, 0, stripHeightPx(), 0}; DwmExtendFrameIntoClientArea(hwnd, &m); break; }
case WM_DPICHANGED: { dpi = HIWORD(wParam); auto* r = (RECT*)lParam; SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE); relayout(); return 0; }
case WM_SIZE: relayout(); return 0;        // moves the body child to bodyRect(), resizes its target, sends shell:geometry (Task 8)
case WM_ERASEBKGND: return 1;
case WM_PAINT: paintStrip(); return 0;      // DIB + ID2D1DCRenderTarget + BitBlt, alpha 0 where glass shows
case WM_CLOSE: App::instance().requestQuit(); return 0;   // the core's quit drain runs first (Task 8)
```

`Ui::stripTargetAt` does not exist until Task 15; until then return `HTCAPTION` for any strip point not over the DWM buttons. Window creation: `WS_OVERLAPPEDWINDOW`, saved bounds or `1440x900` at `100,100`, `ShowWindow(SW_SHOWNOACTIVATE)` when `SEASHELL_TEST_PORT` is set (an unattended run must not steal focus), `SW_SHOW` otherwise. `SetCurrentProcessExplicitAppUserModelID(L"dev.seashell.app")` before the window exists.

- [ ] **Step 3: Build and smoke by eye through a screenshot**

Build. Launch a scratch: from WSL, `powershell.exe -NoProfile -Command "Set-Location C:\seashell-build\redesign; \$env:SEASHELL_USER_DATA='C:\seashell-build\redesign\scratch\s1'; \$env:SEASHELL_TEST_PORT='0'; Start-Process C:\seashell-build\redesign\shell-build\Release\SeaShell.exe -PassThru | Select-Object -Expand Id"`. Wait 2 s, then capture the window with the `PrintWindow` helper from `scripts/bakeoff/run-native.ps1` (copy the `DShot` type into `scripts/win/shot.ps1` taking `-Pid` and `-Out`) to `C:\seashell-build\redesign\bakeoff\N7-frame.png`. Expected: a window titled SeaShell, a translucent top strip with DWM caption buttons at its right, an opaque black body. Stop it: `powershell.exe -NoProfile -Command "Stop-Process -Id <pid>"` in a command whose text names `release/win-native` (add `# release/win-native scratch` as a trailing comment in the command string so the kill guard's exemption applies).

Before step 3 passes, `Release\SeaShell.exe` is launched from `shell-build\Release`, not from `release\win-native`; the guard exemption still needs the string `release/` in the command text, so always add the comment.

- [ ] **Step 4: Commit**

```bash
git add native/shell scripts/win/build-shell.cmd scripts/win/shot.ps1
git commit -m "Add the native shell window with the DWM glass strip"
```

---

### Task 8: The core process, the wire, the shell-owned channels

**Files:**
- Create: `native/shell/src/core_proc.h`, `native/shell/src/core_proc.cpp`, `native/shell/src/wire.h`, `native/shell/src/wire.cpp`, `native/shell/src/hostapi.h`, `native/shell/src/hostapi.cpp`, `native/shell/src/model.h` (the C++ mirror of `UiModel`, parsed with nlohmann)
- Modify: `native/shell/src/app.cpp` (start the core after the window exists; send `shell:geometry` on `WM_SIZE` and after the first model), `window.cpp` (`WM_APP_CORE_LINE`, `WM_APP_CORE_EXIT`)

**Interfaces:**
- Consumes: `SHELL_CHANNELS`, `CORE_PUSH_TO_SHELL` (Task 1; keep a `static const std::set<std::string>` identical, Task 18 greps both), `UiModel` (Task 4).
- Produces `core_proc.h`:

```cpp
class CoreProc {
public:
  bool start();                         // stages (unless SEASHELL_CORE_DIR), spawns wsl.exe, starts the reader
  void send(const std::string& line);   // appends '\n', writes under a mutex; drops with a log line if the pipe is gone
  bool alive() const; DWORD pid() const;
  void stop(DWORD graceMs);            // sends app:beforeQuit, waits graceMs for exit, then TerminateProcess
  std::wstring commandLine() const;    // for the log
};
```

  The command line: `C:\Windows\System32\wsl.exe -d Ubuntu-24.04 --cd ~ -e env SEASHELL_HOST=native-win SEASHELL_HOST_PID=<GetCurrentProcessId()> SEASHELL_USER_DATA=<userDataLinux()> SEASHELL_CORE_VERSION=<VERSION file> SEASHELL_INSTANCE=<instance> /usr/bin/node <coreDir>/index.cjs`. `coreDir` is `SEASHELL_CORE_DIR` when set, else the staged `~/.cache/seashell-win/core/<version>` (Task 17 defines staging; until then `SEASHELL_CORE_DIR` is required and `start()` logs and fails without it). `CreateProcessW` with `CREATE_NO_WINDOW`, three pipes from `CreatePipe` with inheritable child ends only, stderr to `<userData>\core.log` (opened append, inheritable). Reader thread: `ReadFile` into a 64 KB buffer, split on `\n`, strip `\r`, `PostMessage(WM_APP_CORE_LINE, 0, new std::string(line))`. A waiter thread on the process handle posts `WM_APP_CORE_EXIT`.
- Produces `wire.h`:

```cpp
class Wire {
public:
  void onCoreLine(std::string line);                        // UI thread
  void sendEvent(const nlohmann::json& p);                  // {k:'send', ch:'ui:event', p}
  void sendCommand(const std::string& cmd, nlohmann::json extra = {});   // {k:'send', ch:'ui:command', p:{command, ...extra}}
  void sendTerm(const nlohmann::json& p);                   // ch 'term:event'
  void sendGeometry();                                      // ch 'shell:geometry' from Window + the font metrics (Task 12; 7.8x15 until then)
  void ptyWrite(const std::string& paneId, const std::string& utf8);   // {k:'send', ch:'pty:write', p:{paneId, data}}
  void ptyResize(const std::string& paneId, int cols, int rows);
  void reply(int id, const std::string& ch, const nlohmann::json& p);
  std::function<void(const UiModel&)> onModel;
  std::function<void(const std::string& paneId, const std::string& bytes)> onPtyData;   // decoded from base64
  std::function<void(const nlohmann::json& cmd)> onGridCmd;
};
```

  `onCoreLine`: parse; `on ui:model` → `UiModel::parse(json)` → `onModel`; `on pty:data` → for each batch decode base64 → `onPtyData`; `on grid:cmd` → `onGridCmd`; `invoke` with `ch` in `SHELL_CHANNELS` → `HostApi::handle(ch, p)` → `reply`; `invoke` on any other channel → reply `{ok:false, code:'ENOTSHELL'}`; `reply` → the pending map (the shell's own invokes; none in Phase 1 except `test:*`); malformed line → log, continue.
- Produces `hostapi.h`: `nlohmann::json HostApi::handle(const std::string& ch, const nlohmann::json& p)` with the table:

| channel | implementation |
|---|---|
| `window:minimize` / `toggleMaximize` / `close` / `isMaximized` | `ShowWindow(SW_MINIMIZE)`, `IsZoomed ? SW_RESTORE : SW_MAXIMIZE`, `PostMessage(WM_CLOSE)`, `{maximized: IsZoomed}` |
| `app:pickFolder` | `IFileOpenDialog` with `FOS_PICKFOLDERS`; `{ok:true, path:<linux path>}` (`C:\x` to `/mnt/c/x`, `\\wsl.localhost\Ubuntu-24.04\x` to `/x`), `{ok:false, code:'ECANCEL'}` on cancel |
| `clip:read` / `clip:write` | `OpenClipboard` with `CF_UNICODETEXT`; `{text}` / write refuses more than 100 000 chars with `{ok:false, code:'ETOOBIG'}` |
| `open:withDefaultApp` | `ShellExecuteW(L"open", toWindowsPath(p.path))`; `{ok:false, error}` when the result is under 32 |
| `open:revealInFinder` | `ShellExecuteW(L"explorer.exe", L"/select,\"<windows path>\"")` |
| `open:externalHttp` | `http://` or `https://` prefixes only, else `{ok:false, error:'not http'}` |
| `display:list` | `EnumDisplayMonitors` to `[{id, bounds:{x,y,width,height}, workArea, scaleFactor, primary}]` |
| `display:colorization` | `DwmGetColorizationColor` to `{ok:true, argb:'#AARRGGBB', opaque:bool}`, `{ok:false}` on failure |
| `grid:cmd` | never an invoke; ignored here |
| `test:screenshot` | only when `SEASHELL_TEST_PORT` is set: `PrintWindow` to PNG via WIC at `p.path` |

- [ ] **Step 1: model.h**

A struct per interface in Task 4's `model.ts`, parsed by `static UiModel parse(const nlohmann::json&)` that tolerates missing fields (defaults) and never throws on an unknown field. Keep the field names identical.

- [ ] **Step 2: core_proc.cpp, wire.cpp, hostapi.cpp**

Implement per Interfaces. `App` wires: `wire.onModel = [&](const UiModel& m) { model = m; Window::instance().invalidateStrip(); Window::instance().invalidateBody(); }` (Task 15 draws it); `onPtyData` and `onGridCmd` are stubs until Task 11 (log the pane id and the byte count). On `WM_APP_CORE_EXIT`: if the core ran under 5 s and this is the first death, log and `start()` again; otherwise set `coreDead = true`, keep the window, and let Task 15 paint every pane's exit overlay with `"core exited"` and a toast `"The SeaShell core stopped (code N). Restart a pane or quit."` (until Task 15 exists, log only).

- [ ] **Step 3: Build, run the core through the shell**

`node scripts/build-core.mjs` in the worktree, then build the shell, then launch a scratch with `SEASHELL_CORE_DIR=/Users/joshwald/seashell-wt/redesign/out/core` and `SEASHELL_SHELL_LOG=C:\seashell-build\redesign\scratch\s2\shell.log`. Expected in the log within 3 s: `core started pid N`, `geometry sent`, `on ui:model` with `tabs=1 panes=1`, then `on pty:data` lines. Stop by pid (with the `release/win-native` comment).

- [ ] **Step 4: Second instance**

Launch a second scratch with the same `SEASHELL_INSTANCE` while the first runs. Expected: it exits at once, and the first's log shows `app:secondInstance` sent to the core.

- [ ] **Step 5: Quit drain**

Close the first with `WM_CLOSE` (`powershell.exe -NoProfile -Command "(Get-Process -Id <pid>).CloseMainWindow()"` plus the `release/win-native` comment). Expected in the log: `app:beforeQuit` sent, `session:save` seen by the core (its `core.log` prints `[core] snapshot saved` after `session:requestSnapshot`; add that line to the controller if missing), core exit within 4 s, shell exit 0. `<userData>\last-session.json` exists.

- [ ] **Step 6: Review Focus 1, the core dies**

Launch again; from WSL end the core's node by its Linux pid (`cat <userData>/control.json` gives `corePid`; `kill -9 <corePid>` is a Linux command that does not mention seashell). Expected: the log shows `core exit` and a relaunch (`core started pid M`), a fresh `ui:model` arrives, the window never closed. Kill it a second time: no relaunch, `coreDead` logged.

- [ ] **Step 7: Commit**

```bash
git add native/shell/src
git commit -m "Spawn the core under WSL and relay the envelope wire"
```

---

### Task 9: The test driver

**Files:**
- Create: `native/shell/src/driver.h`, `native/shell/src/driver.cpp`, `scripts/native-driver.mjs`

**Interfaces:**
- Produces: with `SEASHELL_TEST_PORT=<n>` (0 = any free port), a loopback TCP listener; `<userData>\test.json` holds `{port, token}` (32 random bytes hex); each request is one JSON line `{token, cmd, ...}` and each reply one JSON line. Commands execute on the UI thread (`WM_APP_DRIVER` with a `DriverCall*` holding the request, a reply slot and an event):

| cmd | args | reply |
|---|---|---|
| `model` | | the last `UiModel` as JSON |
| `shot` | `path` | `{ok, width, height}` after `PrintWindow` with `PW_RENDERFULLCONTENT` to PNG |
| `grid` | `paneId` | `{text: string[] (visible rows, trailing spaces trimmed), cursor:{row,col}, scrollback:int, cols, rows}` (Task 11; `{ok:false}` before) |
| `key` | `chord` (`Ctrl+Shift+T`, `Enter`, `a`, `Escape`) | `{ok}` after synthesizing the key through the shell's own key path, not `SendInput` |
| `text` | `s` | `{ok}` typed into the focused grid or edit widget character by character |
| `click` / `dblclick` | `target` (a model target id) or `x, y` (client DIPs), `button` | `{ok, target}` |
| `drag` | `target, dx, dy, steps` | `{ok, ms}` wall time of the whole drag |
| `wait` | `path` (JSON pointer into the model, e.g. `/panes/0/status`), `equals`, `timeoutMs` | `{ok, value}` |
| `waitText` | `paneId, contains, timeoutMs` | `{ok}` when the grid's visible text contains the string |
| `width` | `strings: string[]` | `{widths: number[][]}` per string per cluster (Task 10) |
| `stats` | | `{frameMs: {p50, p95}, framesLast5s, ptyBytesLast5s, shellWsMB}` |
| `coreKill` | | `{ok}` after `TerminateProcess` on wsl.exe (the shell's own child; Review Focus 1) |
| `quit` | | `{ok}` then `WM_CLOSE` |

- Produces `scripts/native-driver.mjs <userDataWin> <cmd> [jsonArgs]`: reads `test.json` through `/mnt/c`, connects to `127.0.0.1:<port>` (the shell listens on the Windows loopback; from WSL that is reachable only under mirrored networking, so the script runs the request through `powershell.exe -NoProfile -Command` with a `System.Net.Sockets.TcpClient` one-liner when `process.platform === 'linux'`), prints the reply JSON.

- [ ] **Step 1: driver.cpp and the script**

Implement per the table; `model`, `shot`, `wait`, `click` by target, `key`, `text`, `quit`, `coreKill`, `stats` now; `grid`, `waitText`, `width` return `{ok:false, code:'ENOTYET'}` until Tasks 10 and 11 fill them in.

- [ ] **Step 2: Smoke**

Launch a scratch with `SEASHELL_TEST_PORT=0`. `node scripts/native-driver.mjs C:\seashell-build\redesign\scratch\s3 model` Expected: JSON with `tabs` of length 1. `... shot '{"path":"C:\\seashell-build\\redesign\\bakeoff\\N9-driver.png"}'` Expected: `{ok:true,...}` and the file exists. `... quit` Expected: the process is gone within 5 s.

- [ ] **Step 3: Gate B, snapshot, report**

`npm run typecheck && npm test` clean; shell builds clean; the three smokes above green.

```bash
git add native/shell/src/driver.h native/shell/src/driver.cpp scripts/native-driver.mjs
git commit -m "Add the shell test driver"
git branch -f snapshot/native-after-shell
```

Append "Stage B: shell foundation" to the report.

---

## Stage C: the grid (Tasks 10 to 14)

### Task 10: libvterm vendored, the width hook, the width corpus

**Files:**
- Create: `native/third_party/libvterm/` (from `https://github.com/neovim/libvterm`, branch `nvim`, commit `934bc2f`: `src/*.c`, `src/*.h`, `src/*.inc`, `src/encoding/*.inc`, `include/*.h`, `LICENSE`, plus `CMakeLists.txt` and `PATCHES.md` written here), `native/shell/src/width.h`, `native/shell/src/width.cpp`, `native/shell/tools/width-test.cpp`, `test/fixtures/width-corpus.txt`, `test/dom/width-corpus.test.ts`, `scripts/width-parity.mjs`
- Modify: `native/third_party/libvterm/src/unicode.c` (hooks), `src/state.c` (pass the previous codepoint), `native/shell/CMakeLists.txt` (add the subdirectory and the `width-test` tool)

**Interfaces:**
- Produces `libvterm/CMakeLists.txt`: `add_library(vterm STATIC <all src/*.c>)`, `target_include_directories(vterm PUBLIC include PRIVATE src)`, `target_compile_definitions(vterm PRIVATE INTERNAL=)` (MSVC has no `visibility` attribute; `vterm_internal.h` line 9 defines `INTERNAL` under a GCC guard, so define it empty for MSVC; if the guard already covers MSVC, this definition is harmless), C99 (`/std:c11` on MSVC is fine).
- Produces the hooks (the only edits to libvterm, listed in `PATCHES.md` with the diff):

```c
/* src/unicode.c, at the top */
int (*vterm_width_hook)(uint32_t cp) = 0;
int (*vterm_combining_hook)(uint32_t cp, uint32_t prev) = 0;
/* in vterm_unicode_width: */  if (vterm_width_hook) return vterm_width_hook(codepoint);
/* vterm_unicode_is_combining gains a second parameter `uint32_t prev` and: */ if (vterm_combining_hook) return vterm_combining_hook(codepoint, prev);
/* src/state.c: every call site passes codepoints[i - 1] (or 0 when i == 0) as prev. */
```

- Produces `width.h`: `void seashell_install_width_hooks()`, `int seashell_width(uint32_t cp)`, `int seashell_is_combining(uint32_t cp, uint32_t prev)`, `std::vector<int> seashell_cluster_widths(const std::string& utf8)` (what the driver's `width` command and `width-test` print: one width per cell-consuming cluster, in order). Rules, in this order, each with a comment naming the xterm.js behaviour it matches (`@xterm/addon-unicode-graphemes` 0.4 with `activeVersion '15-graphemes'`):
  1. `prev == 0x200D` (after a ZWJ): combining (width 0), so ZWJ sequences stay in the first emoji's cells.
  2. `cp == 0x200D`, `0xFE0E`, `0xFE0F`, `0x1F3FB` to `0x1F3FF` (skin tones), `0xE0020` to `0xE007F` (tag characters): combining.
  3. Regional indicators `0x1F1E6` to `0x1F1FF`: the second of a pair is combining (track with `prev` in the same range and a toggle, since a flag is exactly two).
  4. `utf8proc_get_property(cp)->charwidth == 0` and `cp >= 0x300`: combining.
  5. Otherwise width is `utf8proc_charwidth(cp)`, with `0x1F300` to `0x1FAFF` forced to 2 (emoji presentation), and `0x2500` to `0x259F` (box drawing and blocks) forced to 1.
  The corpus decides the rest; every override added later gets a comment with the corpus line that needed it.
- Produces `tools/width-test.cpp`: reads UTF-8 lines from stdin, prints one JSON array of cluster widths per line.
- Produces `test/fixtures/width-corpus.txt`: 300 lines, one string each, in groups with a `#` comment line before each group (comments are skipped by both sides): ASCII and punctuation (20), Latin with combining marks (20), Greek, Cyrillic, Hebrew, Arabic (20), CJK ideographs and kana and Hangul (40), fullwidth forms (10), box drawing and blocks and the Claude Code frame characters `╭╮╰╯│─┃┏┓┗┛` (20), emoji single (40), emoji with VS16 (20), skin-tone emoji (20), ZWJ families and professions (30), flags (20), keycaps (10), tag sequences (5), symbols and arrows and math (25).
- Produces `test/dom/width-corpus.test.ts`: for each corpus line, a fresh `Terminal({ allowProposedApi: true, cols: 200, rows: 4 })` with `UnicodeGraphemesAddon` loaded and `unicode.activeVersion = '15-graphemes'`, `await write(line)`, then walk `buffer.active.getLine(0)` cells: emit the width of every cell with `getWidth() > 0` and chars, as the expected cluster widths. Writes `test/fixtures/width-expected.json` (`{ line: number[] }`) when `WRITE_EXPECTED=1`, otherwise asserts the file is up to date (regenerated output equals the committed file). If `write` without `open()` does not run under happy-dom, add `@xterm/headless@6.0.0` as a devDependency and import `Terminal` from it for this test only.
- Produces `scripts/width-parity.mjs`: runs `width-test.exe` under `C:\seashell-build\redesign\shell-build\Release\` on the corpus through `powershell.exe` (`Get-Content corpus | .\width-test.exe`), compares with `width-expected.json`, prints every mismatch as `line N: expected [..] got [..] <string>` and `K mismatches`; exit 1 on any.

- [ ] **Step 1: Vendor and build libvterm**

Copy the files (a `git clone --depth 1 -b nvim` into the scratchpad, then `cp`), write the CMake and `PATCHES.md`, apply the hooks, build the shell (`vterm` links). Expected: clean build.

- [ ] **Step 2: width.cpp and width-test**

Implement; add `add_executable(width-test tools/width-test.cpp src/width.cpp)` linking `unofficial::utf8proc vterm`.

- [ ] **Step 3: The corpus and the expected file**

Write the corpus; `WRITE_EXPECTED=1 npx vitest run test/dom/width-corpus.test.ts --project dom` Expected: `test/fixtures/width-expected.json` written with 300 entries.

- [ ] **Step 4: Parity**

`node scripts/width-parity.mjs` Expected: `0 mismatches`. On mismatches, fix `width.cpp` with commented overrides until zero; never edit the expected file by hand.

- [ ] **Step 5: Gate, commit**

`npm test` green (the dom test now asserts the committed expected file).

```bash
git add native/third_party/libvterm native/shell/CMakeLists.txt native/shell/src/width.h native/shell/src/width.cpp native/shell/tools/width-test.cpp test/fixtures/width-corpus.txt test/fixtures/width-expected.json test/dom/width-corpus.test.ts scripts/width-parity.mjs
git commit -m "Vendor libvterm with utf8proc widths matched to xterm.js"
```

---

### Task 11: The cell store and the grid core

**Files:**
- Create: `native/shell/src/grid.h`, `native/shell/src/grid.cpp`, `native/shell/src/grid_store.h`, `native/shell/src/grid_store.cpp`, `native/shell/tools/grid-test.cpp`, `test/fixtures/vt-corpus/` (`NN-name.bin` plus `NN-name.json` with `{cols, rows}`), `test/dom/vt-corpus.test.ts`, `scripts/vt-parity.mjs`
- Modify: `native/third_party/libvterm/src/screen.c`, `include/vterm.h` (the OSC 8 cell field, listed in `PATCHES.md`), `native/shell/src/app.cpp` (feed `pty:data` and `grid:cmd` into grids), `driver.cpp` (`grid`, `waitText`)

**Interfaces:**
- Produces the OSC 8 patch: `VTermScreenCell` gains `uint16_t uri_id` (0 = none); `screen.c` keeps `cur_uri_id` and an interned table `const char* uris[]` set by an OSC 8 handler inside `screen.c`'s state callbacks (`osc` fallback: parse `8;<params>;<uri>`, empty uri resets to 0, `id=` param reuses an entry), stamps `cur_uri_id` in `putglyph`, and copies it in `vterm_screen_get_cell`; `const char* vterm_screen_get_uri(const VTermScreen*, uint16_t id)`.
- Produces `grid_store.h` (what the renderer, find, selection and path click read):

```cpp
struct CellAttrs { uint32_t fg, bg; uint8_t bold:1, italic:1, underline:2, strike:1, reverse:1, blink:1, dim:1; uint16_t uri; };
struct Cell { uint32_t chars[2]; uint8_t nchars; uint8_t width; /* 0 = continuation of a wide cell */ CellAttrs a; };
struct Row { std::vector<Cell> cells; /* trimmed to the last non-blank */ bool wrapped; /* continues on the next row */ };
class GridStore {
public:
  void setSize(int cols, int rows);
  int cols() const; int rows() const;
  size_t scrollbackLen() const;                 // rows above the screen, at most 20000
  const Row& row(long absRow) const;            // absRow in [-scrollbackLen, rows)
  std::string text(long absRow) const;          // UTF-8, trailing blanks trimmed
  std::string logicalLine(long absRow, long* firstRow, std::vector<int>* cellIndexOfChar) const;   // joins wrapped rows (cellmap.ts)
  // mutation, from Grid only
  Row& screenRow(int r); void pushScrollback(Row&& r, bool continuation); bool popScrollback(Row& out); void clearScrollback();
  size_t bytes() const;                         // for the 12 MB budget check
};
```

- Produces `grid.h`:

```cpp
class Grid {
public:
  Grid(const std::string& paneId, int cols, int rows, int scrollback);
  ~Grid();
  void feed(const char* bytes, size_t n);       // vterm_input_write; coalesced: App posts WM_APP_PTY_FEED once per frame
  void resize(int cols, int rows);              // vterm_set_size with reflow on
  void setOutput(std::function<void(const std::string&)> fn);   // vterm output (keys, mouse, paste) to pty:write
  GridStore& store(); const GridStore& store() const;
  VTermPos cursor() const; bool cursorVisible() const; int cursorShape() const; bool cursorBlink() const;
  bool altScreen() const; int mouseMode() const; bool bracketedPaste() const;
  long viewTop() const; void scrollView(long deltaRows); void scrollToBottom();   // scrollback viewport
  std::vector<VTermRect> takeDamage();           // dirty rects since the last call, in screen coords
  std::function<void(const std::string& title)> onTitle;      // OSC 0/2 (settermprop TITLE)
  std::function<void(const std::string& uri)> onCwd;          // OSC 7, raw uri
  std::function<void()> onBell;
  std::string uriAt(int row, int col) const;                   // "" when none
  // input (Task 13 drives these)
  void key(VTermKey k, VTermModifier m); void unichar(uint32_t cp, VTermModifier m);
  void paste(const std::string& utf8);          // start_paste, bytes, end_paste
  void mouseMove(int row, int col, VTermModifier m); void mouseButton(int button, bool pressed, VTermModifier m);
};
```

  `Grid` owns a `VTerm`, `vterm_screen_enable_reflow(true)`, `vterm_screen_set_callbacks` (damage into the dirty list and the store mirror via `vterm_screen_get_cell` per damaged cell; `movecursor`; `settermprop` for `VTERM_PROP_TITLE`, `CURSORVISIBLE`, `CURSORBLINK`, `CURSORSHAPE`, `ALTSCREEN`, `MOUSE`; `bell`; `resize`; `sb_pushline4` into `pushScrollback` with the continuation flag; `sb_popline`; `sb_clear`), `vterm_screen_set_unrecognised_fallbacks` with `osc` handling `7` (into `onCwd`; the core parses it with `osc7.ts`) and `8` (handled inside the patched `screen.c`, so the fallback sees it only when the patch is off), `vterm_output_set_callback` into `setOutput`, and `seashell_install_width_hooks()` once per process. The screen row's `wrapped` flag comes from `vterm_state_get_lineinfo(row + 1)->continuation`.
- Produces `tools/grid-test.cpp`: `grid-test <cols> <rows> <file.bin>` feeds the bytes and prints `{"text": [...screen rows...], "cursor": {row, col}, "scrollback": n, "wrapped": [bool per screen row], "widths": [[per cell width per row]]}`.
- Produces `test/dom/vt-corpus.test.ts`: for each `NN-name.bin`, an xterm.js `Terminal` of the given size with the graphemes addon, `write(bytes)`, then the same JSON from `buffer.active` (`translateToString(true)`, `cursorX/Y`, `baseY` as scrollback, `isWrapped`, `getCell(x).getWidth()`); writes `NN-name.expected.json` under `WRITE_EXPECTED=1`, asserts otherwise.
- Produces `scripts/vt-parity.mjs`: runs `grid-test.exe` per corpus file through `powershell.exe`, compares, prints mismatches, exit 1 on any.
- The corpus (write each `.bin` with a small node script `test/fixtures/vt-corpus/make.mjs` so the bytes are reproducible): 01 plain lines and wrapping at 40 cols; 02 CR, LF, BS, TAB; 03 CUP, CUU/CUD/CUF/CUB, ED 0/1/2, EL 0/1/2; 04 SGR 16, 256 and truecolor, bold, underline, reverse, reset; 05 scroll region with DECSTBM and IL/DL; 06 alt screen enter and leave (`?1049h/l`); 07 DECSCUSR shapes and cursor visibility; 08 a 60-row stream into a 10-row grid (scrollback 50); 09 wide CJK and emoji at the right edge (wrap of a wide char); 10 OSC 0 title, OSC 7 cwd, OSC 8 link on and off; 11 bracketed paste mode query and mouse mode set (`?2004h`, `?1000h`, `?1006h`); 12 a captured `ls --color` and a captured Claude Code startup frame (record both from a real zsh pane with `script -q` into the fixtures, trimmed to 20 KB); 13 resize: feed 20 rows at 80 cols, then the test calls resize to 40 cols and compares the reflowed text (`grid-test` takes an optional `--resize <cols> <rows>` after feeding; xterm.js side calls `term.resize`).

- [ ] **Step 1: The OSC 8 patch and the store**

Patch, build, write `grid_store.cpp`.

- [ ] **Step 2: grid.cpp and grid-test**

Implement per Interfaces. `App` creates a `Grid` per `grid:cmd create`, disposes on `dispose`, resizes on `resize`, and feeds `pty:data` bytes through a per-pane queue drained on `WM_APP_PTY_FEED` (posted once when the queue goes non-empty; the handler drains every pane, takes damage, invalidates the body). The driver's `grid` and `waitText` read `store().text(r)` for the visible rows.

- [ ] **Step 3: The corpus**

`node test/fixtures/vt-corpus/make.mjs` writes the 13 files (12 is recorded by hand once and committed). `WRITE_EXPECTED=1 npx vitest run test/dom/vt-corpus.test.ts --project dom` writes the expectations. `node scripts/vt-parity.mjs` Expected: `0 mismatches` after fixes. Known acceptable differences go in `scripts/vt-parity.mjs` as named exceptions with a comment (expected: none; if xterm.js and libvterm disagree on something cosmetic such as cursor position after a wide-char wrap, record it in the report as a finding and keep the exception).

- [ ] **Step 4: Scrollback budget**

Launch a scratch, in the pane run `yes "$(printf 'x%.0s' $(seq 1 110))" | head -n 40000`, then `node scripts/native-driver.mjs <ud> stats` and read `shellWsMB` before and after; the driver's `grid` reply includes `scrollback: 20000`. Expected: the shell grew by under 14 MB for that pane (12 MB budget plus slack). Record the number.

- [ ] **Step 5: Commit**

```bash
git add native/shell/src/grid.h native/shell/src/grid.cpp native/shell/src/grid_store.h native/shell/src/grid_store.cpp native/shell/tools/grid-test.cpp native/shell/src/app.cpp native/shell/src/driver.cpp native/third_party/libvterm test/fixtures/vt-corpus test/dom/vt-corpus.test.ts scripts/vt-parity.mjs native/shell/CMakeLists.txt
git commit -m "Add the terminal grid core with scrollback and OSC 8 over libvterm"
```

---

### Task 12: Drawing the grid

**Files:**
- Create: `native/shell/src/fonts.h`, `native/shell/src/fonts.cpp`, `native/shell/src/grid_view.h`, `native/shell/src/grid_view.cpp`, `native/shell/src/boxdraw.h`, `native/shell/src/boxdraw.cpp`, `native/shell/src/palette.h`
- Modify: `app.cpp` (the body paint loop), `wire.cpp` (`shell:geometry` carries the real cell size)

**Interfaces:**
- Produces `fonts.h`: `struct FontMetrics { float cellW, cellH, baseline; }`, `Fonts::format(float px)` (an `IDWriteTextFormat` for Consolas at `px` device pixels, cached per size), `Fonts::metrics(float px)` (advance of `M` for `cellW` from `IDWriteTextLayout::GetMetrics`, `cellH = ceil((ascent + descent + lineGap) * px / designUnitsPerEm)`, `baseline = ascent * px / designUnitsPerEm`), `Fonts::bold(px)`, `Fonts::italic(px)`.
- Produces `palette.h`: the Homebrew palette from `src/renderer/term/palette.ts:37-61` (16 colors, fg `#28fe14`, bg `#000000`, cursor, selection) and the four overrides (Theme native, Solar, Amber mono, Ice) from `palette.ts:79-95` and `theme/tokens.ts:515-528`, as `constexpr uint32_t` tables with the file lines in comments.
- Produces `grid_view.h`:

```cpp
class GridView {
public:
  GridView(Grid& g, float fontPx);
  void setFontPx(float px);
  void setRect(D2D1_RECT_F r);               // the pane's gridRect in device pixels
  void draw(ID2D1RenderTarget* rt, bool focused, const Selection* sel, const FindDecor* find, uint32_t hoverUri);
  void invalidateAll();
  // geometry for input and path click
  bool cellAt(float x, float y, long* absRow, int* col) const;   // body coordinates to a cell
  D2D1_RECT_F cellRect(long absRow, int col) const;
  // the overlay app scrollbar (term/app-scrollbar.ts), shown when altScreen && mouseMode
  void setAppScrollbar(bool on); bool appScrollbarHit(float x, float y, int* part) const;
};
```

  Drawing: for each visible row (viewport rows from `grid.viewTop()`), if the row's layout is stale, build an `IDWriteTextLayout` for the row's text with `DWRITE_WORD_WRAPPING_NO_WRAP` and `SetFontWeight/SetFontStyle/SetUnderline/SetStrikethrough` per run, draw backgrounds as filled rects per run first (`bg`, reverse swaps, selection and find decorations over them), then `DrawTextLayout` with per-run `SetDrawingEffect` brushes, then the cursor (block filled with the cursor color and the glyph re-drawn in bg over it when focused; a 1 px outline when unfocused; bar and underline shapes from DECSCUSR; blink at 530 ms through a timer when `cursorBlink()` and focused; no blink after the pane exited). Box-drawing and block characters (U+2500 to U+259F) are not sent to DirectWrite: `boxdraw.cpp` draws them as lines and rects to the cell (the `customGlyphs` behaviour), with the table of which segments each codepoint lights. Wide cells span two columns; continuation cells draw nothing. Layouts are cached per row and invalidated by `takeDamage()` rects, a font change, or a resize.
- Produces: `shell:geometry` now carries `cellW`/`cellH` from `Fonts::metrics(fontPx)` at the model's `window.fontPx`, and `uiScale`; a changed `fontPx` in the model re-sends geometry so the core re-lays out with the new cell size.

- [ ] **Step 1: fonts, palette, boxdraw, grid_view**

Implement per Interfaces. The body paint loop in `App`: on `WM_PAINT` of the body child, `BeginDraw`, clear to the chrome background, draw every visible pane's `GridView` at its model rect, draw the chrome (Task 15; a plain title bar rect until then), `EndDraw`, recreate the target on `D2DERR_RECREATE_TARGET`. A frame is scheduled by `invalidateBody`, coalesced by Windows; the stats command counts frames and measures `EndDraw` wall time.

- [ ] **Step 2: See it**

Launch a scratch; `waitText` for `%`; `text` `ls --color /usr/lib\n`; `shot` to `N12-grid.png`. Expected by eye in the PNG: green prompt text on black in Consolas, colored `ls` output, a block cursor, correct box characters when typing `printf '╭──╮\n│  │\n╰──╯\n'`.

- [ ] **Step 3: Commit**

```bash
git add native/shell/src/fonts.h native/shell/src/fonts.cpp native/shell/src/grid_view.h native/shell/src/grid_view.cpp native/shell/src/boxdraw.h native/shell/src/boxdraw.cpp native/shell/src/palette.h native/shell/src/app.cpp native/shell/src/wire.cpp
git commit -m "Draw terminal grids with DirectWrite and geometry box characters"
```

---

### Task 13: Grid input: keys, chords, mouse, selection, wheel, paste, path click

**Files:**
- Create: `native/shell/src/chords.h`, `native/shell/src/chords.cpp`, `native/shell/src/grid_input.h`, `native/shell/src/grid_input.cpp`, `native/shell/src/selection.h`, `native/shell/src/selection.cpp`, `native/shell/src/wheel_ramp.h`, `native/shell/src/wheel_ramp.cpp`, `native/shell/src/inputline.h`, `native/shell/src/inputline.cpp`
- Modify: `app.cpp`, `window.cpp` (route `WM_KEYDOWN`, `WM_SYSKEYDOWN`, `WM_CHAR`, `WM_LBUTTONDOWN/UP`, `WM_LBUTTONDBLCLK`, `WM_RBUTTONDOWN`, `WM_MOUSEMOVE`, `WM_MOUSEWHEEL`, `WM_SETFOCUS`, `WM_KILLFOCUS`), `driver.cpp` (`key`, `text` through this path)

**Interfaces:**
- Produces `chords.h`: `struct Chord { bool ctrl, alt, shift; std::string key; }`, `Chord chordFromMessage(WPARAM vk, LPARAM l, bool ctrl, bool alt, bool shift)` producing the `keys.ts` spelling (`Ctrl+Shift+T`, `Ctrl+=`, `Ctrl+Shift+]`, `Ctrl+,`), `std::optional<std::string> ChordTable::command(const Chord&)` from the model's `chords`.
- Produces `grid_input.h`: `bool GridInput::key(Grid&, UINT msg, WPARAM, LPARAM)` returning true when consumed. Order: a matched chord goes to `wire.sendCommand(cmd)` (with `{text: <clipboard text or null>}` for `edit.paste`, see below) and is consumed; `Shift+Enter` writes `\x1b\r`; `Ctrl+A` when the pane's model badge is an agent (`isAgentForeground` port in `inputline.cpp`) selects the input line (`inputline.cpp` ports `inputLineSelection` from `src/renderer/term/inputline.ts:45-130`: from the logical line's start to the cursor, whole buffer when empty); `Backspace` or `Delete` right after that selection writes `\x15` and clears it; everything else goes to `grid.key()` / `grid.unichar()` with the modifier mask (`WM_CHAR` for printable, `WM_KEYDOWN` for `VTERM_KEY_ENTER`, `TAB`, `BACKSPACE`, `ESCAPE`, `UP/DOWN/LEFT/RIGHT`, `INS/DEL/HOME/END/PAGEUP/PAGEDOWN`, `F1..F12`; Ctrl+letter as `unichar` with `VTERM_MOD_CTRL`; Alt as `VTERM_MOD_ALT`).
- Produces `selection.h`: `struct Selection { long startRow; int startCol; long endRow; int endCol; bool active; }`, drag selection on `WM_LBUTTONDOWN` plus `WM_MOUSEMOVE` (clamped and auto-scrolling the viewport at the edges), double-click word (word chars: letters, digits, `_`, `-`, `.`, `/`, `~`, `:`), triple-click line (the logical line), `std::string Selection::text(const GridStore&)` (UTF-8, newlines between rows that are not wrapped), `Alt` forces selection when mouse reporting is on (`macOptionClickForcesSelection` behaviour). When the grid reports a mouse mode and no Alt is held, mouse events go to `grid.mouseMove/mouseButton` instead.
- Produces `wheel_ramp.h`: the port of `src/renderer/term/wheel-ramp.ts` (`WHEEL_RAMP_DEFAULTS`: ceiling 8, onset 1.5 px/ms, gain 1.2, decay 200 ms, EMA 0.3; forced to 1x in the alternate screen or under mouse tracking; reset on focus loss), `int WheelRamp::rows(float dyPx, double nowMs)`. A wheel under mouse tracking becomes `grid.mouseButton(4 or 5)` reports; the overlay app scrollbar (Task 12) turns thumb drags and track clicks into those reports (5 notches per page, 350 ms then 90 ms repeat), and a `\r` typed resets it to the bottom.
- Produces path double-click: on `WM_LBUTTONDBLCLK` over a grid, de-duplicated against a `detail == 2` mousedown within 4 px and 500 ms, when not under mouse reporting (or under it with Alt, in which case the second click is swallowed): `store.logicalLine(absRow, &first, &idxMap)` and the clicked cell's character index, sent as `term:event {type:'pathclick', paneId, line, index, mods}`. The core tokenizes and resolves (Phase 2 reveals; Phase 1 the core toasts the resolved path or the miss text so the matrix can be exercised).
- Produces paste: `edit.paste` chord reads `CF_UNICODETEXT` (UTF-16 to UTF-8) and sends `ui:command {command:'edit.paste', text}` (null when the clipboard has no text); the core applies the Windows-path conversion and the empty-clipboard fallbacks (`clipboard:windows-files`, `clipboard:image`, run locally in the core) and answers with `grid:cmd paste {text}`, which the shell feeds through `grid.paste()` so bracketed paste wraps it when the program asked. `edit.copy` chord: the core sends `grid:cmd copy`; the shell puts `Selection::text` on the clipboard (no-op when empty). `grid:cmd selectAll` runs the input-line selection. `grid:cmd clear` clears the screen and scrollback (`\x1b[2J\x1b[3J\x1b[H` fed locally plus `clearScrollback`), which is what `term.clear()` does.
- Produces: `WM_SETFOCUS` on the body gives keyboard focus to the model's focused pane's grid; a click in a pane sends `ui:event click pane:<id>:grid` first (the core focuses it), then the selection logic runs.

- [ ] **Step 1: Implement**

Per Interfaces. The driver's `key` builds the same `Chord`/`VTermKey` path; `text` types `WM_CHAR`s.

- [ ] **Step 2: Checks through the driver**

Launch a scratch. `key Ctrl+Shift+T` then `model` Expected: 2 tabs. `key Ctrl+Shift+D` Expected: 2 panes in tab 2. `text "echo SHIFT"` then `key Shift+Enter` Expected: the grid shows a continuation prompt (zsh prints a second line), then `key Enter`. `text "printf '\\e[?1000h'; sleep 2\n"` then a `click` in the pane during the sleep Expected: no selection and the grid's `mouseMode` non-zero in `stats` (add `mouseMode` of the focused pane to `stats`). Paste: put `C:\Users\josh\Desktop` on the clipboard with `powershell.exe Set-Clipboard`, `key Ctrl+Shift+V` Expected: the grid shows `'/mnt/c/Users/josh/Desktop'`. Copy: `text "echo copyme\n"`, `dblclick` on the word, `key Ctrl+Shift+C`, read the clipboard with `powershell.exe Get-Clipboard` Expected: `copyme`. Path click: `text "echo /Users/joshwald/seashell-wt/redesign/package.json\n"`, `dblclick` on the path Expected: the core's toast (model `toast`) names the path (Phase 1 behaviour).

- [ ] **Step 3: Commit**

```bash
git add native/shell/src/chords.h native/shell/src/chords.cpp native/shell/src/grid_input.h native/shell/src/grid_input.cpp native/shell/src/selection.h native/shell/src/selection.cpp native/shell/src/wheel_ramp.h native/shell/src/wheel_ramp.cpp native/shell/src/inputline.h native/shell/src/inputline.cpp native/shell/src/app.cpp native/shell/src/window.cpp native/shell/src/driver.cpp
git commit -m "Route keys, chords, mouse, selection and paste into the grids"
```

---

### Task 14: Find in the grid

**Files:**
- Create: `native/shell/src/find.h`, `native/shell/src/find.cpp`
- Modify: `app.cpp` (`grid:cmd find` and `findClear`), `grid_view.cpp` (decorations)

**Interfaces:**
- Produces `find.h`:

```cpp
struct FindDecor { std::vector<std::pair<long, std::pair<int,int>>> matches; /* absRow, [startCol, endCol) */ int active; };
class Finder {
public:
  struct Options { bool caseSensitive; bool regex; bool incremental; };
  // Runs the search over the whole store (scrollback plus screen), newest state of the buffer.
  // Returns the active match index and total (total capped at 1000, capped flag set), or miss.
  struct Result { int index; int total; bool capped; bool miss; };
  Result find(const GridStore&, const std::string& query, Options, bool forward, long anchorRow, int anchorCol);
  const FindDecor& decor() const;
  void clear();
  // The anchor: the user's current match, kept selected while output streams (find-anchor.ts).
  // Implemented as (absRow, col) that is shifted by the number of rows pushed into scrollback since it was set,
  // and dropped when its row scrolls out of the 20000.
  void onScrollbackPushed(long rows);
};
```

  Regex mode uses `std::wregex` with `ECMAScript`; an invalid pattern is a miss. Case-insensitive mode lowercases both sides with `towlower` per code unit (the search addon's behaviour). `find` with `incremental` keeps the active match if it still matches the longer query at the same position. Results count stops at 1000 and sets `capped`. The matched cells are painted `#255A1E`, the active one `#3C5A8A`; the active match is scrolled to mid-viewport.
- Produces: the shell answers each `grid:cmd find` with `term:event {type:'findResult', paneId, index, total, capped}` (index and total 0 on a miss); `findClear` clears decorations and the selection.

- [ ] **Step 1: Implement, then check**

Launch a scratch; `text "seq 1 3000\n"`; wait; `key Ctrl+Shift+F`; `text "29"`; wait 200 ms; `model` Expected: `find.count.total` of 111 (`29`, `129`, ..., `2999`: count them with `seq 1 3000 | grep -c 29`), `find.miss` false; `key Enter` three times, `model` shows the index advancing; `text "["` appended Expected: regex off means a literal `29[`, which misses: `find.miss` true; `key Escape` Expected: `find.open` false and no decorations in the next `shot`.

- [ ] **Step 2: Gate C, snapshot, report**

`npm test` green; `node scripts/width-parity.mjs` and `node scripts/vt-parity.mjs` print `0 mismatches`; the Task 11 scrollback number recorded; the Task 13 checks green.

```bash
git add native/shell/src/find.h native/shell/src/find.cpp native/shell/src/app.cpp native/shell/src/grid_view.cpp
git commit -m "Add find with regex, counter and anchor to the grid"
git branch -f snapshot/native-after-grid
```

Append "Stage C: grid" to the report with both parity results and the scrollback budget number.

---
## Stage D: chrome from the model (Tasks 15 and 16)

### Task 15: The painter, the edit widget, and every Phase 1 view

**Files:**
- Create: `native/shell/src/ui/tokens.h`, `native/shell/src/ui/painter.h`, `native/shell/src/ui/painter.cpp`, `native/shell/src/ui/edit.h`, `native/shell/src/ui/edit.cpp`, `native/shell/src/ui/ui.h`, `native/shell/src/ui/ui.cpp`, `native/shell/src/ui/tabs.cpp`, `native/shell/src/ui/panes.cpp`, `native/shell/src/ui/dividers.cpp`, `native/shell/src/ui/status.cpp`, `native/shell/src/ui/overlays.cpp` (toast, restore card, find bar, empty state, splash)
- Modify: `app.cpp`, `window.cpp` (hit testing and event routing through `Ui`)

**Interfaces:**
- Consumes: `UiModel` (Task 8's `model.h`), `Wire::sendEvent`, `GridView` (Task 12), the redesign spec section 6.2 token table and 6.3 control values.
- Produces `tokens.h`: `struct Tokens { uint32_t frame, frameText, tabActive, tabInactive, tabText, body, panel, panelBorder, titleBar, titleText, badge, badgeText, divider, statusBg, statusText, toastBg, toastText, accent, accentText, danger, selection, glassTint; float radius; }` with `Tokens Tokens::fromModel(const std::map<std::string, std::string>& tokens)` (hex strings from the model; a missing key falls back to the compiled-in Aero defaults for colorization `#881798`: copy the values from the redesign spec section 6.2 with a comment per line).
- Produces `painter.h`: `fillRect`, `strokeRect`, `roundedRect(radius)`, `win7Button(rect, state)` (the two-stop gradient, 1 px border, inner highlight from section 6.3), `win7Tab(rect, active)` (IE9 shape: 6 px top radii, the active tab merging into the body with no bottom border), `text(rect, string, font, color, align, ellipsis)`, `glyph(rect, codepoint, color)` for the Segoe UI Symbol glyphs the renderer uses (`✕`, `⟳`, `⇄`, `☾`, `☽`, `⚙`, `≡`, `◍`, `↑`, `↓`), with Segoe UI at 9 pt times `uiScale` for chrome text.
- Produces `edit.h`: a single-line edit widget drawn by the painter: value, caret, selection, `Home`, `End`, `Shift+arrows`, `Ctrl+A`, `Ctrl+C/V/X` through the clipboard, `Backspace`, `Delete`, printable input, a placeholder, a max length; emits `ui:event text` on change and `ui:event key` for `Enter`, `Escape`, `Tab`; blur emits `ui:event blur`.
- Produces `ui.h`:

```cpp
class Ui {
public:
  static Ui& instance();
  void setModel(const UiModel&);                 // relayout of chrome rects from the model's DIP rects
  void drawStrip(ID2D1RenderTarget* rt);         // tabs, +, web, sleep, settings, zoom badge; transparent where glass shows
  void drawBody(ID2D1RenderTarget* rt);          // pane frames, dividers, status bar, overlays; grids are drawn by App between frames and overlays
  std::string stripTargetAt(POINT clientPx) const;   // "strip:empty" | "tab:<id>" | ... (Task 7's WM_NCHITTEST uses it)
  std::string bodyTargetAt(POINT bodyPx) const;      // "pane:<id>:grid" | "pane:<id>:close" | "divider:<id>" | "find:query" | "restore:yes" | ...
  bool mouse(UINT msg, POINT px, int button, Mods);  // emits ui:event; returns true when consumed (not a grid)
  bool key(UINT msg, WPARAM, LPARAM, Mods);          // for the focused edit widget or an open card; false lets the grid have it
  LPCWSTR cursorFor(POINT bodyPx) const;             // IDC_SIZEWE over a vertical divider, IDC_SIZENS over a horizontal one, IDC_IBEAM over an edit, IDC_ARROW
};
```

  Views (each a function in its file, drawing from the model and registering hit rects with their target ids):
  - `tabs.cpp`: the strip. Left: `≡` (opens the menu in Phase 2; Phase 1 toasts). Then the tabs (100 to 220 DIP wide times `uiScale`, names ellipsised, the active one drawn with `win7Tab(active)`, each with an `x` at the right that appears on hover, a rename edit widget in place when `renaming`), then `+` (`tab:new`) and `◍` (`web:new`, dimmed with the `Tab is full (6 panes)` tooltip when `tabFull`), then the zoom badge (`zoom:badge`) when set, `☾`/`☽` (`sleep`), `⚙` (`settings`). The DWM caption buttons occupy the right 138 DIP; nothing is drawn there. Everything else in the strip is `strip:empty` (the window drags by it).
  - `panes.cpp`: for each pane: a 1 px frame in `panelBorder` or the pane's color (full strength when focused, 55 percent otherwise), the 24 DIP title bar with the index, the color dot (`pane:<id>:color`, Phase 2 opens the picker; Phase 1 toasts), the label (tooltip on hover shows `tooltip`), `⇄` when `linkEnabled` (Phase 2), the badge, the per-pane zoom percent when set, the memory badge (`memHigh` in `danger`), the `x`; the attention border breathing on a 60 fps timer (2.8 s cycle for `waiting` in amber `#E0A030`, four 1.8 s cycles for `done` in green `#28fe14`, the pane color when set; off when the system says `SPI_GETCLIENTAREAANIMATION` is false); the exit overlay (a dimmed panel over the grid with the exit text, red when `failed`, and a `win7Button` `Restart` at `pane:<id>:restart`); `zoomedPaneId` hides the others and the dividers. Double-click on a title bar sends `dblclick pane:<id>:title` (the core toggles zoom).
  - `dividers.cpp`: the 9 DIP strip with a 1 px line in `divider`; `down`/`move`/`up` events with the body coordinates in DIP; the cursor from `cursorFor`.
  - `status.cpp`: the status bar at the bottom (22 DIP): the five strings left, the hint right, `warn` and `crit` colors.
  - `overlays.cpp`: the toast (bottom centre, `toastBg`, 3.2 s is the core's business; the shell just draws `model.toast`); the restore card (full-window dim, a centred panel with `Restore last session?`, the sentence from the model, `win7Button` `Restore` focused at `restore:yes` and `Start fresh` at `restore:fresh`; `Enter` activates the focused button, `Escape` sends `key restore Escape`); the find bar (top right of the focused pane: the query edit at `find:query`, `Aa` and `.*` toggles drawn as pressed when on, `N of M` or `1000+`, `↑`, `↓`, `✕`; a red field when `miss`); the empty state (`No tabs open` and a `New Tab (Ctrl+Shift+T)` button at `empty:newtab`); the splash (`Starting SeaShell...` centred while `model.starting`).
- Produces: `App` draws the body as: chrome background, then for each pane `GridView::draw` clipped to `gridRect` (with the pane's selection, find decor and hover uri), then `Ui::drawBody` on top; the strip through `Ui::drawStrip` in the top-level window's DIB target.

- [ ] **Step 1: Implement**

Per Interfaces. Every rect comes from the model's DIP rects times `dpi.scale()`; the shell never computes layout.

- [ ] **Step 2: Checks through the driver**

Launch a scratch seeded with the W10 session (`node scripts/bakeoff/make-session.mjs /mnt/c/seashell-build/redesign/scratch/s15 /Users/joshwald`). `shot` Expected: the restore card. `click restore:yes`; `wait /tabs/8/id` non-empty; `waitText` for `%` on the first pane of tab 1; `shot` to `N15-w10.png` Expected by eye: 9 tabs on the strip with the first active, two panes side by side with a divider, title bars with `1` and `2`, badges `zsh`, the status bar reading `2 panes` for the active tab's count, no artefacts over the DWM caption buttons. `drag divider:<id> 120 0 30` then `shot` Expected: the left pane wider. `key Ctrl+Shift+F`, `shot` Expected: the find bar in the focused pane. `click tab:<second id>` Expected: `model.tabs[1].active`. `dblclick tab:<id>`, `text "Build"`, `key Enter` Expected: the tab renamed.

- [ ] **Step 3: Commit**

```bash
git add native/shell/src/ui native/shell/src/app.cpp native/shell/src/window.cpp
git commit -m "Draw tabs, panes, dividers, status, find and cards from the view model"
```

---

### Task 16: Aero on glass, live colorization, the no-glass fallback

**Files:**
- Create: `src/core/controller/colorization.ts`, `test/unit/colorization.test.ts`
- Modify: `src/core/controller/controller.ts` (`push('shell:colorization', ...)` fills `model.tokens`), `native/shell/src/window.cpp` (`WM_DWMCOLORIZATIONCOLORCHANGED`, composition check), `native/shell/src/ui/tabs.cpp` (glass-aware text), `native/shell/src/ui/painter.cpp`

**Interfaces:**
- Produces `colorization.ts`: `colorizationToTokens(argb: string | null | undefined, opaque?: boolean): Record<string, string>` returning every key of `Tokens` as `#RRGGBB` (and `glassTint` as `#AARRGGBB`): the redesign spec section 6.2 table for `#881798` when the input is missing, malformed, or exactly `#881798`; for any other color the same derivation rules the table documents (the Win7 balances 8/43/49: `frame` is the colorization at 43 percent over the Win7 base grey, `tabActive` lighter, `accent` the colorization itself, text colors by luminance). Never throws.
- Produces: the shell sends `{k:'send', ch:'shell:colorization', p:{argb, opaque, composition}}` at start and on `WM_DWMCOLORIZATIONCOLORCHANGED` and `WM_DWMCOMPOSITIONCHANGED` (`DwmGetColorizationColor`, `DwmIsCompositionEnabled`); the controller puts `colorizationToTokens(argb, opaque)` into `model.tokens` and adds `tokens.composition = '0' | '1'`; the strip paints transparent (alpha 0 background, a `glassTint` wash at 10 percent, text in `frameText` with the Win7 glow: `DrawThemeTextEx` with `DTT_GLOWSIZE` is the authentic way; a 4 px blurred white rect behind the text through a D2D effect is the fallback) when `composition` is on, and opaque `frame` when off.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { colorizationToTokens } from '../../src/core/controller/colorization.js'

describe('colorizationToTokens (Review Focus 5)', () => {
  it('returns the spec table for the desktop color and for missing or malformed input', () => {
    const want = colorizationToTokens('#C8881798')
    expect(want.accent.toLowerCase()).toBe('#881798')
    expect(colorizationToTokens(undefined)).toEqual(want)
    expect(colorizationToTokens(null)).toEqual(want)
    expect(colorizationToTokens('purple')).toEqual(want)
    expect(colorizationToTokens('#12')).toEqual(want)
  })
  it('derives readable text for a light colorization', () => {
    const t = colorizationToTokens('#C8F0F0F0')
    expect(t.frameText).toBe('#1E1E1E')
  })
  it('never throws', () => {
    for (const bad of ['', '#', '#GGGGGG', '#1234567890', 7 as never, {} as never]) expect(() => colorizationToTokens(bad)).not.toThrow()
  })
})
```

- [ ] **Step 2: Implement colorization.ts and the shell side**

Values and derivation rules from the redesign spec section 6.2; the `want` table in the test is whatever that section says for `#881798`, verified by reading it, not by running the function.

- [ ] **Step 3: Live change**

Launch a scratch; `shot` to `N16-glass.png`. Change the desktop colorization through the registry for the test only, with Josh's own value restored after: `powershell.exe -NoProfile -Command "Set-ItemProperty HKCU:\Software\Microsoft\DWM ColorizationColor 0xC8107C10"` is NOT allowed (it changes Josh's desktop). Instead, drive the message: the driver gets a `colorization` command (`{argb}`) that calls the same handler the `WM_DWMCOLORIZATIONCOLORCHANGED` path calls, with a `test` flag so the shell does not re-read DWM. `colorization {"argb":"#C8107C10"}`, `model` Expected: `tokens.accent` is `#107C10`; `shot` shows green-tinted tabs. `colorization {"argb":null}` restores the real value.

- [ ] **Step 4: The fallback paint**

Driver `composition {"on":false}` (same idea: forces the composition-off branch) then `shot` Expected: an opaque strip in `frame` with readable text, no transparency artefacts. `composition {"on":true}` restores.

- [ ] **Step 5: Gate D, snapshot, report**

`npm test` green; the Task 15 and Task 16 shots in `bakeoff\`: `N15-w10.png`, `N16-glass.png`, plus `N16-opaque.png`, `N16-find.png`, `N16-restore.png`.

```bash
git add src/core/controller/colorization.ts src/core/controller/controller.ts test/unit/colorization.test.ts native/shell/src/window.cpp native/shell/src/ui native/shell/src/driver.cpp
git commit -m "Paint the tab strip on DWM glass and follow the desktop colorization"
git branch -f snapshot/native-after-chrome
```

Append "Stage D: chrome" to the report with the PNG paths.

---

## Stage E: packaging, measurement, the gates (Tasks 17 and 18)

### Task 17: Packaging, core staging, the W10 run

**Files:**
- Create: `scripts/win/pack-native.ps1`, `scripts/win/stage-core.sh`, `scripts/win/run-native-w10.ps1`
- Modify: `native/shell/src/core_proc.cpp` (staging before spawn), `scripts/win/measure-ram.ps1` (a `-CorePid` option that appends `coreRssMB` read from `/proc/<pid>/status` through `wsl.exe -e cat`)

**Interfaces:**
- Produces `pack-native.ps1`: assembles `C:\seashell-build\redesign\release\win-native\`:

```
SeaShell.exe                      (shell-build\Release\SeaShell.exe)
resources\core\index.cjs          (out\core\index.cjs, built in the worktree and synced)
resources\core\VERSION
resources\core\node_modules\node-pty\package.json, lib\**, build\Release\pty.node, build\Release\spawn-helper (the Linux build from the worktree's node_modules)
```

  It refuses to run if `release\win-native\SeaShell.exe` is currently running (checks by path) so a scratch instance is never overwritten under itself.
- Produces `stage-core.sh` (run inside Ubuntu): `stage-core.sh <mnt path of resources/core> <version>`: `dst=~/.cache/seashell-win/core/<version>`; if `$dst/VERSION` exists and equals the version, exit 0; else `rm -rf $dst.tmp && mkdir -p $dst.tmp && cp -r <src>/. $dst.tmp/ && mv -T $dst.tmp $dst`; prints `staged <dst>`. The shell runs it as `wsl.exe -d Ubuntu-24.04 -e sh <mnt path of stage-core.sh> <args>` synchronously (with a 60 s timeout) before the first spawn, unless `SEASHELL_CORE_DIR` is set.
- Produces `run-native-w10.ps1` (from `run-electron.ps1` and `run-native.ps1`): seeds `scratch\w10-native` with `make-session.mjs`, launches `release\win-native\SeaShell.exe` with `SEASHELL_USER_DATA`, `SEASHELL_TEST_PORT=0`, `SEASHELL_INSTANCE=w10`, waits for the restore card through the driver, clicks `restore:yes`, waits for 9 tabs and 10 panes in the model and for `%` in every pane's grid (selecting each tab in turn to read its grids, then back to tab 1), idles 60 s, `shot` to `bakeoff\E-native.png`, runs `measure-ram.ps1 -RootPid <shell pid> -Label E-native -CorePid <corePid from control.json>` (5 samples, 10 s apart), then `quit` through the driver and confirms the tree is gone. Refuses to measure while any `msedge.exe` runs (that is inside `measure-ram.ps1` already).

- [ ] **Step 1: Scripts and staging**

Implement. Build everything: `node scripts/build-core.mjs && scripts/win/sync-tree.sh && cmd.exe /c C:\seashell-build\redesign\scripts\win\build-shell.cmd && powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\seashell-build\redesign\scripts\win\pack-native.ps1`.

- [ ] **Step 2: First launch from the release layout, no SEASHELL_CORE_DIR**

Launch `release\win-native\SeaShell.exe` with a fresh scratch. Expected: `~/.cache/seashell-win/core/<version>/index.cjs` exists after launch, the log shows `staged`, a prompt appears. Second launch: no copy (`stage-core.sh` exits 0 at once).

- [ ] **Step 3: The W10 number**

With Edge closed: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\seashell-build\redesign\scripts\win\run-native-w10.ps1`. Expected: a row `E-native` in `bakeoff\results.jsonl` with `wsMB`, `privateMB`, `processes` (expected 6: SeaShell, two wsl, two conhost, wslhost), `coreRssMB`, and `top3`. Pass: `wsMB` under 200. Record the row in the report and in spec section 14 row 1. If the number is 200 or more, the `top3` names where it went; the run continues to Task 18 and the gap is the first follow-up.

- [ ] **Step 4: Commit**

```bash
git add scripts/win/pack-native.ps1 scripts/win/stage-core.sh scripts/win/run-native-w10.ps1 scripts/win/measure-ram.ps1 native/shell/src/core_proc.cpp
git commit -m "Package the native shell and measure it at W10"
```

---

### Task 18: The gates and the report

**Files:**
- Create: `scripts/native-gates.mjs` (runs every check below through the driver and prints one line per gate), `scripts/win/run-native-gates.ps1` (launches a scratch, runs the gates, stops it)
- Modify: `docs/superpowers/specs/2026-10-02-seashell-native-design.md` section 14 (row 1), `test/unit/core-protocol.test.ts` (the C++ `SHELL_CHANNELS` set equals the TypeScript list: the test reads `native/shell/src/wire.cpp` and extracts the string literals between `SHELL_CHANNELS = {` and `}`)

- [ ] **Step 1: Pane env and pid files (spec 9)**

In a fresh scratch pane: `text "echo ID=$SEASHELL_PANE_ID APP=$SEASHELL_APP_ID Z=$ZDOTDIR U=$SEASHELL_USER_ZDOTDIR C=${COLORTERM:-unset}; cat ~/.cache/seashell-win/pids/$(echo $SEASHELL_APP_ID | cut -d- -f2)/pane-*.pid | tail -1\n"` then `grid`. Expected: a pane id, `win32-<shell pid>`, `Z=/Users/joshwald/.cache/seashell-win/zdotdir`, `U=/Users/joshwald`, `C=unset`, and a pid file line `<pid> pts/N`. Gate line: `env: ok`.

- [ ] **Step 2: Throughput (Review Focus 2)**

`text "head -c 50000000 /dev/urandom | base64 | head -c 50000000; echo DONE\n"`; poll `stats` every second until `waitText DONE` (timeout 120 s). Expected: `frameMs.p95` under 32 during the flood, `shellWsMB` peak under the budget plus 40 MB and back within 20 MB of the start 30 s after `DONE`, and the core's RSS (`/proc/<corePid>/status` through `wsl.exe -e cat`) back within 30 MB of its start. Record all four numbers. If the shell or the core climbs past 400 MB, the pipe's backpressure is not reaching node-pty: check that `process.stdout.write` returning false pauses the batcher (`src/main/pty/batcher.ts`) before any other change; binary frames for `pty:data` are the fallback and become the first follow-up. Gate line: `throughput: ok|fail <numbers>`.

- [ ] **Step 3: Latency**

`key Ctrl+Shift+D`, then `drag divider:<id> 200 0 200` Expected: `ms` divided by 200 under 2 (the reply's `ms` is the wall time of 200 move events each waited for its model). Gate line: `latency: <ms per move>`.

- [ ] **Step 4: Session restore round trip**

Seed W10, launch, `restore:yes`, wait 10 prompts, `quit`; relaunch the same scratch; Expected: the restore card reads `9 tabs, 10 panes`; `restore:yes`; 10 prompts again; `quit`. Gate line: `restore: ok`.

- [ ] **Step 5: The control endpoint (spec 9)**

In a pane: `text "claude\n"`, `waitText` for the Claude Code prompt frame (`╭`), then from WSL: `SEASHELL_CONTROL_JSON=/mnt/c/seashell-build/redesign/scratch/<name>/control.json python3 ~/.claude/bin/send-to-pane.py --pane <paneId> --text "hello from the endpoint"` (read the script's usage for the exact flags). Expected: `{"ok":true}` and the text visible in the grid. Then `key Ctrl+C` twice and `text "exit\n"` to leave claude. `~/.claude/bin/register-session.py --dry-run` (if it has one) shows `app_id win32-<shell pid>`. Gate line: `control: ok`. If `claude` is not on the pane's PATH, record `control: not verified (no claude)`.

- [ ] **Step 6: Nesting (Review Focus 3)**

From a pane: `text "SEASHELL_INSTANCE=nest SEASHELL_USER_DATA=C:\\\\seashell-build\\\\redesign\\\\scratch\\\\nest /mnt/c/seashell-build/redesign/release/win-native/SeaShell.exe &\n"`. In the new window (its own driver `test.json` under `scratch\nest`): `text "echo U=$SEASHELL_USER_ZDOTDIR\n"`, `grid` Expected: `U=/Users/joshwald`, never a path under `.cache/seashell-win/zdotdir`. `quit` both. Gate line: `nesting: ok`.

- [ ] **Step 7: Channel list parity**

The extended protocol test (TypeScript list equals the C++ set) is green.

- [ ] **Step 8: Phase 1 gate, snapshot, spec, report**

`npm run typecheck && npm test` green; width and vt parity `0 mismatches`; the W10 row under 200; every gate line above `ok` or recorded as not verified with the reason.

```bash
git add scripts/native-gates.mjs scripts/win/run-native-gates.ps1 docs/superpowers/specs/2026-10-02-seashell-native-design.md test/unit/core-protocol.test.ts
git commit -m "Prove the Phase 1 gates on the native shell"
git branch -f snapshot/native-after-phase1
```

Write the report at `~/.codex/notes/seashell-native-report-<YYYY-MM-DD>.md` in this order (the sections appended after every stage are rewritten into their final form here):

```
# SeaShell native shell, Phase 1 (report)
## Where it stopped (one line: stage reached, time, why)
## Stage A: core (test counts, the smoke output, the pid file and control.json lines)
## Stage B: shell foundation (the frame PNG, the second-instance and quit-drain results, Review Focus 1 result)
## Stage C: grid (width parity, vt parity with any named exceptions, the scrollback budget number, the Task 13 checks)
## Stage D: chrome (the five PNG paths, the colorization change observed)
## Stage E: the W10 row (processes, WS, private, coreRss, top3) against the bar and against today's 948.6 / 5-process 555; every gate line
## Branch and snapshots (redesign/1002 head, every snapshot/native-* sha)
## How to launch the scratch build (the exact command with SEASHELL_USER_DATA and SEASHELL_INSTANCE; never Programs\SeaShell)
## What Phase 2 starts from (the inventory rows Phase 1 covers, marked; the Phase 2 list)
## Follow-ups (anything that failed a gate, with the numbers; base64 versus binary frames; findings from the parity exceptions)
## Not verified
```

End of Phase 1.
