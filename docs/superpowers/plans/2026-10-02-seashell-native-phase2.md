# SeaShell Native Shell, Phase 2 (everything else) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every row of the renderer inventory works on the native build, or is listed as deferred with the spec section that defers it, so that Phase 3 has nothing left to port and can cut over.

**Architecture:** Unchanged from Phase 1: `SeaShell.exe` draws a view model and reports input; the core (`src/main` plus the headless controller) inside WSL owns every piece of application state. Phase 2 adds the remaining views (explorer, drawer, previews, sheets, popovers, menu, banner) to the model and the shell, moves the remaining `app.tsx` logic into the controller, hosts WebView2 only while a web or PDF pane exists, and first fixes the one Phase 1 gate the architecture missed: the event-to-model round trip, which the wsl.exe stdio relay made 8.8 ms when the core answers in 0.32.

**Tech Stack:** As Phase 1 (C++17, MSVC via `vcvars64.bat`, CMake, vcpkg `utf8proc` and `nlohmann-json`, Direct2D 1.1, DirectWrite, DWM, libvterm; TypeScript, esbuild, vitest; Node 26.10 in Ubuntu 24.04) plus the vcpkg `webview2` port (WebView2 SDK headers and loader; the Evergreen WebView2 Runtime that ships with Windows 11), WIC for images, XAudio2 for the attention ping, `IDropTarget` for drops, `shiki/core` with the JavaScript regex engine in the core bundle. (Amendment 10/03: the `webview2` port, WIC and `shiki/core` are not used.)

**Spec:** `docs/superpowers/specs/2026-10-02-seashell-native-design.md` (sections 4, 7, 8, 9, 10, 11, 12); scope `docs/superpowers/specs/2026-10-02-seashell-renderer-inventory.md` (every lettered row); Aero control values and the path matrix in `docs/superpowers/specs/2026-10-02-seashell-redesign.md` sections 6.3 and 7; what Phase 1 left in `~/.codex/notes/seashell-native-report-2026-10-02.md` ("What Phase 2 starts from", "Follow-ups", "Not verified").

**Decisions this plan makes, for Josh to see before the run** (each is also the conservative reading of the spec, and each can be reversed by a one-line note in the prompt):

1. **The wire moves to a loopback TCP socket if Task 1 shows the wsl.exe stdio relay costs over 1 ms per round trip.** Spec 4.2 says stdin and stdout; Phase 1 measured the relay at about 8.5 ms of an 8.8 ms divider move against the 2 ms bar, with the core itself at 0.32 ms. The core opens the socket and announces it on stdout; stdio stays as the bootstrap and the fallback. Task 2 amends spec 4.2 if it runs.
2. **Alt taps the menu open at the `≡` button instead of showing a menu bar.** A real menu bar does not fit under the DWM custom frame with the glass strip (spec 6 and 7). Alt+letter chords still reach the terminal.
3. **The other six themes, the pane frames and the CRT effects appear in Settings greyed with the tooltip `coming back`** (spec 12). Accent and terminal palette work, because the tokens and the grid palette already exist.
4. (Moot, see the amendment.) **File contents never ride in `ui:model`.** A new core-to-shell channel `view:cmd` carries a preview's text and highlight runs once per load, and a shell-to-core `view:event` carries saves and WebView2 navigation reports (the same split as `grid:cmd` and `term:event`).
5. (Moot, see the amendment.) **Images and PDFs are read by the shell from the Windows path** (`/mnt/c/x` as `C:\x`, anything else as `\\wsl.localhost\Ubuntu-24.04\...`), after the core's `fs:probe` route said `viewer` and the path guard accepted it. No base64 image across the pipe.
6. **The update check stays off on `wslhost` until Phase 3** (`update:state` is only `idle`), because today's checker would offer the Linux AppImage. The banner is built and tested with an injected state.
7. **Confirms are `MessageBox` through a shell-answered invoke `dialog:confirm`;** in test mode the driver pre-answers them so no dialog ever blocks a gate.

## Amendment, 10/03 04:30 (Josh): no file viewer, no code editor, no web or PDF panes

Josh, 10/03 04:30, while Stage G was closing: "skip adding file viewer, web browser, code editor". Consequences, binding on every task below:

- **Stage H (Tasks 8 to 11) is skipped in full.** No `view:cmd` or `view:event` channel, no Shiki in the core bundle, no `EDIT` editor, no WIC image view, no WebView2 for web or PDF panes, no `webview2` vcpkg port. Header decisions 4 and 5 are moot. Review Focus items 1 and 4 are moot.
- **Path double-click.** Plain double-click reveals (unchanged). Ctrl+double-click and the explorer's double-click on a file hand the file to the Windows default app through `open:withDefaultApp`, the same path Ctrl+Alt already takes (an executable is still refused with the Finder toast). Directories are only revealed and expanded. Task 7b below does this.
- **Preview commands.** `preview.file` (Ctrl+Alt+O) toasts `File previews are not in this build` and opens the explorer. `web:new` (Ctrl+Alt+U) toasts `Web previews are not in this build`. `pane.closeAll` keeps closing non-term panes and toasts `No preview panes open` when there are none. The menu items stay (Task 16) and run these commands.
- **Restored preview panes.** A saved session or project that holds a file or web pane restores it as the placeholder pane the shell already draws, with its copy changed to `Previews are not in this build`; `pane.closeAll` removes them. No skip logic.
- **Stage J.** The inventory walk prints `skipped (Josh 10/03)` for rows K and L and for every preview line in the other letters (B tab-close confirm for dirty previews, C close-all of previews, E Ctrl double-click preview, H find in a preview, I paste into a preview, J drop on a preview, W the four preview confirms, X the preview shortcuts). The path matrix (`scripts/native-matrix.mjs`) is created in Task 7b with four rows and no preview row. The restore gate's saved session still holds a file and a web pane, and passes when they come back as placeholders. W10 row (c) is dropped. The report's Stage H section is one line.
- **Spec.** `docs/superpowers/specs/2026-10-02-seashell-native-design.md` sections 4.1, 7, 8, 11 and 12 are amended in the same commit as this section, by the orchestrator, not by a task.

### Task 7b: Previews out (amendment 10/03)

**Files:**
- Create: `scripts/native-matrix.mjs`
- Modify: `src/core/controller/controller.ts` (`openDeps().onOpenInViewer`, `preview.file`, `web:new`), `test/unit/controller-pathclick.test.ts` (the Ctrl test), `native/shell/src/ui/panes.cpp` (the two placeholder strings)

**Interfaces:**
- Consumes: Task 7's `pathClick` and `openDeps()`, `openPath(fullPath, deps, force?)`, `open:withDefaultApp` (a `SHELL_CHANNELS` invoke; in test mode the shell logs `open:withDefaultApp <C:\ path>` to `shell.log` and returns ok without executing), the driver's `text`, `key`, `dblclick`, `model` and the tty check from `scripts/native-gates.mjs`.
- Produces: `onOpenInViewer(path)` calls the same code as the `'os'` route (`withDefaultApp`), so no `pane.newFile` is ever dispatched by the controller; `preview.file` → `toast('File previews are not in this build')` plus the explorer opening as before; `web:new` → `toast('Web previews are not in this build')`; `panes.cpp` draws `Previews are not in this build` for any non-term pane. `node scripts/native-matrix.mjs` launches scratch `g7b` with one zsh pane, waits for the prompt, and runs four rows, each typed as an `echo` through the driver after the tty check: (1) `echo /Users/joshwald/seashell-wt/redesign/README.md`, plain `dblclick` on the path → `sidebar.visible` and `revealRowId` = `row:/Users/joshwald/seashell-wt/redesign/README.md`; (2) the same path with `mods { ctrl: true }` → `shell.log` gains `open:withDefaultApp \\wsl.localhost\Ubuntu-24.04\Users\joshwald\seashell-wt\redesign\README.md` and `panes` are all `term`; (3) `echo /mnt/c/seashell-build/redesign/bakeoff/results.jsonl` with `mods { ctrl: true, alt: true }` → `open:withDefaultApp C:\seashell-build\redesign\bakeoff\results.jsonl`; (4) `echo "/Users/joshwald/seashell-wt/redesign/test/fixtures/width corpus.txt:12"` (create that file with a space in its name under `test/fixtures/` only if the matrix needs it, else use an existing path with a space under `/mnt/c/seashell-build/redesign/scratch/`) plain `dblclick` → the quoted path with the `:12` suffix resolves and reveals. It prints `matrix: <n> ok` lines and exits non-zero on any failure, quits the scratch through the driver.

- [ ] **Step 1: Change the Ctrl test, add the toast tests, run them to see them fail**

In `test/unit/controller-pathclick.test.ts` replace the test `Ctrl opens a file pane in the tab, retargeted by the next file` with:

```ts
  it('Ctrl hands the file to the default app and never creates a pane', async () => {
    const f = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.term({ type: 'pathclick', paneId: c.model().panes[0].id, line, index: idx, mods: { ctrl: true, alt: false, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    expect(f.sent.some(([ch, p]) => ch === 'open:withDefaultApp' && (p as { path: string }).path === '/w/README.md')).toBe(true)
    expect(c.model().panes.every((p) => p.kind === 'term')).toBe(true)
  })
  it('the preview commands toast and open nothing', async () => {
    const f = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('preview.file')
    expect(c.model().toast).toBe('File previews are not in this build')
    expect(c.model().sidebar.visible).toBe(true)
    c.command('web:new')
    expect(c.model().toast).toBe('Web previews are not in this build')
    expect(c.model().panes.every((p) => p.kind === 'term')).toBe(true)
  })
```

(If `web:new` arrives as a `ui:command` under another name in `controller.ts`, use that name; the controller's switch is the authority.) Run: `npx vitest run test/unit/controller-pathclick.test.ts --project unit` Expected: the two new tests FAIL.

- [ ] **Step 2: Implement**

Per Interfaces: `onOpenInViewer` routes to `withDefaultApp`; the two toasts; the placeholder copy in `panes.cpp`. Run: `npx vitest run test/unit/controller*.test.ts --project unit && npm run typecheck` Expected: PASS, clean.

- [ ] **Step 3: The matrix**

Write `scripts/native-matrix.mjs` per Interfaces (reuse the launch, wait, drive, quit and tty helpers from `scripts/native-gates.mjs`; export them from there if they are not exported yet). Rebuild (core, sync, shell, pack). Run: `node scripts/native-matrix.mjs` Expected: four `ok` lines. `shot` the revealed state to `bakeoff\P2-matrix.png`.

- [ ] **Step 4: Commit**

```bash
git add src/core/controller/controller.ts test/unit/controller-pathclick.test.ts native/shell/src/ui/panes.cpp scripts/native-matrix.mjs scripts/native-gates.mjs
git commit -m "Hand previews to the default app and drop the preview panes"
```

Then Stage I (Tasks 12 to 17) and Stage J (18 to 20) as written, read with this amendment.

## Global Constraints

- Work only in the worktree `~/seashell-wt/redesign` on branch `redesign/1002`. Never commit on `main` (`~/Desktop/seashell` stays at `3746bfe`). Never push anything. Snapshot branches `snapshot/native-<stage>` with `git branch -f` after each stage gate; never pushed.
- Commit messages are ONE line, no attribution of any kind, no trailers. No em dashes anywhere: code, comments, docs, commit messages, UI copy.
- NEVER kill, quit, restart or replace the running `C:\Users\josh\AppData\Local\Programs\SeaShell\SeaShell.exe` or anything holding Josh's panes. Never launch that exe or `~/.local/bin/SeaShell-LEGACY.AppImage`. Never `taskkill /IM`. Never write `%APPDATA%\seashell` or `~/.config/seashell`. Scratch instances only, each with its own `SEASHELL_USER_DATA` under `C:\seashell-build\redesign\scratch\<name>` (Linux form `/mnt/c/seashell-build/redesign/scratch/<name>`), launched with `SEASHELL_TEST_PORT=0` so they never take focus.
- The kill guard (`~/.claude/bin/seashell-kill-guard.sh`) blocks any kill verb in a command whose text mentions "seashell" unless the command also mentions `release/`. Stop a scratch shell through the driver's `quit` command, or by pid with `scripts/win/stop-tree.ps1 -RootPid <pid>` in a command that names its `release/win-native` path, never by image name. Scratch shells launch only from `C:\seashell-build\redesign\release\win-native\`.
- Never type into a pane while a `claude` process is on its tty unless the step says so (Phase 1 follow-up 4: two scratch Claude Code sessions received gate text). `scripts/native-gates.mjs` has the tty check; every new gate that types reuses it.
- Windows work runs from WSL through `powershell.exe -NoProfile` or `cmd.exe /c`, every command starting with `cd /d C:\...` or `Set-Location C:\...` and using absolute `C:\` paths (a WSL cwd is UNC to Windows and silently becomes `C:\Windows`). The build tree is `C:\seashell-build\redesign\`, an rsync of the worktree by `scripts/win/sync-tree.sh`; run it before every Windows-side build. Nothing under `C:\AI\`. Nothing copied into `Programs\SeaShell`.
- Native builds: `cmd.exe /c C:\seashell-build\redesign\scripts\win\build-shell.cmd` (vcvars64 from `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools`, vcpkg toolchain `C:\Users\josh\dev\vcpkg\scripts\buildsystems\vcpkg.cmake`, build directory `C:\seashell-build\redesign\shell-build`). Package with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\seashell-build\redesign\scripts\win\pack-native.ps1`; the next launch restages the core because `BUILD` changed. The full rebuild is `node scripts/build-core.mjs && scripts/win/sync-tree.sh && <build-shell.cmd> && <pack-native.ps1>`.
- The core is built and run with WSL's own node (`/usr/bin/node`, 26.10). `node-pty` is the Linux build in `node_modules/node-pty/build/Release/pty.node`.
- Gates before any snapshot: `npm run typecheck && npm test` clean in the worktree, plus the stage's Windows gate named in the task. Run one vitest file as `npx vitest run <path> --project unit` (or `--project dom` for `test/dom`). Do not `git add -A`; add files by name.
- The core imports pure renderer modules in place (`src/renderer/layout/*`, `store.ts`, `links/*`, `projects/serialize.ts`, `session/offer.ts`, `term/zoom.ts`, `term/osc7.ts`, `term/inputline.ts`, `panes/{paneTitle,attention,colors,drop,link}.ts`, `settings/settings.ts`, `explorer/{open,chain,ignored}.ts`, `drawer/{cd,id}.ts`, `viewer/highlight.ts`, `theme/tokens.ts`); nothing moves, the renderer keeps building for the other platforms. A renderer module that drags in `document`, `window`, `localStorage`, `React` or `AudioContext` at import time is not imported; its pure functions and its data are copied into `src/core/controller/` with a comment naming the source file and lines.
- Every subagent dispatched by this plan is given `model: "opus"` explicitly unless the ultracode-lite ladder assigns a cheaper tier for a mechanical step.
- Microsoft Edge must be closed during any RAM measurement; `measure-ram.ps1` refuses otherwise. Close nothing you did not start: if Edge is open, record "not measured, Edge was open" and continue. A WebView2 pane starts `msedgewebview2.exe` processes under the shell's tree; the W10 rows are measured with no web or PDF pane open (spec 4.1: no Chromium unless such a pane is open), and a separate row with one web pane is reported, never compared with the bar. (Amendment 10/03: no web pane exists, so no such row.)
- After every task that ends a stage, append a section to `~/.codex/notes/seashell-native-phase2-report-<date>.md` (Task 20 defines the sections) so a cut-off run still reports.
- The W10 workload, counting rules and the 200 MB bar are redesign spec section 2 and spec section 4.7 and are not reinterpreted. The latency bar is spec 10: a divider move to its model, median under 2 ms over 200 moves.
- Target ids keep the Phase 1 grammar in `src/core/controller/model.ts` and extend it only with the ids this plan names. The shell computes no application layout: every rect in a view comes from the model in DIP, except the shell's own view state (hover, scroll offsets, carets, the active drag, the strip's scroll).

## Review Focus

1. (Moot, Stage H skipped.) **A previewed file changes on disk while it is being edited.** Saving must never overwrite silently: `fs:writeTextFile` with `expectedMtimeMs` answers `ECONFLICT`, the banner `Reload from disk` appears, and reloading asks first. Task 8 step 1 tests the controller path; Task 9 step 2 drives it on a real file.
2. **An expanded explorer directory disappears or grows past the listing cap.** The row must show `(ENOENT)` or `… too many entries to list` and the watcher's `lost` must not throw or spin. Task 4 step 1 tests both.
3. **A drop or paste of a path with spaces, quotes or non-ASCII, and a `\\wsl.localhost` path.** The pty must receive one shell-quoted, `/mnt`-mapped path with a trailing space, never a half-escaped one. Task 17 step 1 tests `CF_HDROP` to `drop` conversion; `dropText` keeps its own tests.
4. (Moot, Stage H skipped.) **A web pane asked to go to `javascript:`, `file:` or `about:` or to open a popup.** Navigation must be cancelled, the popup must open in the system browser, and the pane must still answer. Task 10 step 3 drives it.
5. **Alt held for a terminal chord while the menu exists.** A bare Alt tap opens the menu; `Alt+.` and every other Alt+key reach the pty unchanged, and an open edit widget or sheet swallows the tap. Task 16 step 3 drives it.

---

## Stage F: the wire and the two missed bars (Tasks 1 to 3)

### Task 1: Measure the relay

**Files:**
- Modify: `native/shell/src/driver.cpp`, `native/shell/src/driver.h` (new command `pingCore`), `src/core/index.ts` (answer `core:ping`), `scripts/native-gates.mjs` (print the number)
- Test: `test/unit/core-index-ping.test.ts`

**Interfaces:**
- Consumes: `Wire::invoke(ch, p, cb)` (Phase 1 `wire.h`), the shim's `dispatch` (an `invoke` envelope for a channel with no `ipcMain.handle` is answered by `index.ts` before the shim sees it; see Task 6 of the Phase 1 plan: `index.ts` routes `shell:geometry`, `ui:event`, `ui:command`, `term:event`, `shell:colorization`).
- Produces: `core:ping` (shell to core, `invoke`, `p: { t: number }`), answered at once with `reply { t }` from `src/core/index.ts` without touching the controller. Driver command `pingCore { n }` → `{ ok: true, n, medianMs, p95Ms, maxMs }` measured on the shell's connection thread with `QueryPerformanceCounter` around each invoke, sequentially (the next ping leaves when the previous reply arrived).

- [ ] **Step 1: Failing test for the core's answer**

`test/unit/core-index-ping.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { answerEarly } from '../../src/core/index-routes.js'

describe('core:ping', () => {
  it('is answered before the shim sees it, with the same t', () => {
    const out: string[] = []
    const handled = answerEarly({ k: 'invoke', ch: 'core:ping', id: 3, p: { t: 12.5 } }, (line) => out.push(line))
    expect(handled).toBe(true)
    expect(JSON.parse(out[0])).toEqual({ k: 'reply', ch: 'core:ping', id: 3, p: { t: 12.5 } })
  })
  it('leaves every other channel alone', () => {
    const out: string[] = []
    expect(answerEarly({ k: 'invoke', ch: 'fs:probe', id: 1, p: {} }, (line) => out.push(line))).toBe(false)
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/unit/core-index-ping.test.ts --project unit`
Expected: FAIL, `index-routes.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/core/index-routes.ts` with `export function answerEarly(e: Envelope, write: (line: string) => void): boolean` that answers only `core:ping` (`encodeEnvelope({ k: 'reply', ch: 'core:ping', id: e.id, p: e.p })`) and returns false otherwise. In `src/core/index.ts`, call it first in the stdin line handler, before the controller routes and before `shim.dispatch`. In `driver.cpp`, add `pingCore` to `handle()` on the connection thread: it posts `n` sequential `Wire::invoke('core:ping', {t}, cb)` calls through the UI thread (each one a `DriverCall` whose UI step issues the invoke and whose reply arrives on the UI thread as a `WM_APP_CORE_LINE`; the connection thread waits on an event the callback sets), timing each from just before the post to the callback. Report median, p95 and max in ms. Add the line `relay: <medianMs> ms per core:ping round trip (n=200)` to `scripts/native-gates.mjs` after the latency gate.

- [ ] **Step 4: Measure**

Rebuild (core, sync, shell, pack). Launch a scratch `f1`. Run `node scripts/native-driver.mjs 'C:\seashell-build\redesign\scratch\f1' pingCore '{"n":200}'` three times. Record the three medians in the report under Stage F. Then `drag divider:<id> 200 0 200` once for the Phase 1 latency figure on the same build.

Decision rule (write the branch taken in the report): if the `pingCore` median is **over 1.0 ms**, the relay is the cost and Task 2 runs in full. If it is **1.0 ms or under**, Task 2's socket steps are skipped (the task's step 7 instrumentation runs instead) because the time is in the shell's own handling.

- [ ] **Step 5: Commit**

```bash
git add src/core/index-routes.ts src/core/index.ts test/unit/core-index-ping.test.ts native/shell/src/driver.cpp native/shell/src/driver.h scripts/native-gates.mjs
git commit -m "Time a bare core round trip from the driver"
```

---

### Task 2: The loopback socket wire

**Files:**
- Create: `src/core/socket-bridge.ts`, `test/unit/core-socket-bridge.test.ts`
- Modify: `src/core/index.ts`, `src/core/stdio-bridge.ts` (export the line codec so both bridges share it), `src/main/pty/flow.ts` (no change needed if the socket satisfies `PipeLike`; listed because `gatedWriter` is what the socket replaces stdout in), `native/shell/src/core_proc.h`, `native/shell/src/core_proc.cpp`, `docs/superpowers/specs/2026-10-02-seashell-native-design.md` section 4.2
- Test: the file above, plus the driver's `pingCore` and `drag` numbers

**Interfaces:**
- Consumes: `startStdio(onLine, write)` from Phase 1's `stdio-bridge.ts`; `CoreProc::Run` (a reader thread, a writer thread, a waiter thread over pipe handles); `Wire::onCoreLine`.
- Produces: `startSocket(opts: { onLine: (line: string) => void; onClose: () => void; token: string }): Promise<{ port: number; write: (line: string) => boolean; close(): void }>` in `socket-bridge.ts`: a `net.Server` on `127.0.0.1`, port 0, one client only; the first line from the client must be `{"k":"send","ch":"core:hello","p":{"token":"<token>"}}` within 5 s or the socket closes and the server keeps listening; after hello, every line is `onLine`, `write` returns the socket's `write()` result (false when over the high-water mark, which `flow.ts` uses to pause the ptys), `onClose` fires when the client goes away.
- Produces: the bootstrap line the core prints on stdout when `SEASHELL_WIRE=tcp` is in its env: `{"k":"on","ch":"core:wire","p":{"port":<n>,"token":"<32 hex>"}}`. After the shell's hello, the core writes nothing more to stdout; stdin EOF still means quit (Phase 1 drain), and so does the socket closing.
- Produces: `CoreProc` connects to `127.0.0.1:<port>` with Winsock when the bootstrap line arrives, sends the hello, then reads and writes the socket from the same two threads that handled the pipes (one `Run` carries either a pipe pair or a `SOCKET`). If the connect fails within 3 s (logged), the run continues on stdio exactly as Phase 1 did. `commandLine()` adds `SEASHELL_WIRE=tcp` to the `env` arguments.

- [ ] **Step 1: Failing bridge test**

```ts
import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { startSocket } from '../../src/core/socket-bridge.js'

function client(port: number): Promise<import('node:net').Socket> {
  return new Promise((res, rej) => { const s = connect({ host: '127.0.0.1', port }); s.once('connect', () => res(s)); s.once('error', rej) })
}
const line = (s: import('node:net').Socket) => new Promise<string>((res) => { let buf = ''; s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) res(buf.slice(0, i)) }) })

describe('socket bridge', () => {
  it('accepts one client after a hello with the right token and relays lines both ways', async () => {
    const seen: string[] = []
    const b = await startSocket({ token: 'tok', onLine: (l) => seen.push(l), onClose: () => {} })
    const s = await client(b.port)
    s.write(JSON.stringify({ k: 'send', ch: 'core:hello', p: { token: 'tok' } }) + '\n')
    s.write(JSON.stringify({ k: 'send', ch: 'ui:command', p: { command: 'tab.new' } }) + '\n')
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual([JSON.stringify({ k: 'send', ch: 'ui:command', p: { command: 'tab.new' } })])
    expect(b.write('{"k":"on","ch":"ui:model","p":{}}')).toBe(true)
    expect(await line(s)).toBe('{"k":"on","ch":"ui:model","p":{}}')
    s.destroy(); b.close()
  })
  it('drops a client whose first line is not the hello', async () => {
    const b = await startSocket({ token: 'tok', onLine: () => {}, onClose: () => {} })
    const s = await client(b.port)
    s.write('{"k":"send","ch":"ui:command","p":{}}\n')
    await new Promise<void>((r) => s.once('close', () => r()))
    const s2 = await client(b.port)   // the server still listens
    expect(s2.destroyed).toBe(false)
    s2.destroy(); b.close()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/unit/core-socket-bridge.test.ts --project unit`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the core side**

`socket-bridge.ts` per Interfaces, reusing the line splitter from `stdio-bridge.ts` (export it as `splitLines`). In `index.ts`: when `process.env.SEASHELL_WIRE === 'tcp'`, mint a token with `crypto.randomBytes(16).toString('hex')`, `await startSocket(...)`, print the bootstrap envelope on stdout, and route every incoming line through the same handler the stdio bridge used; `shim`'s `write` becomes the socket's `write` once a client said hello (until then, lines queue in memory, capped at 16 MB as the shell does). `flow.ts` already takes any `PipeLike` (`write(chunk): boolean` plus `once('drain')`): `index.ts` builds `gatedWriter(process.stdout)` today and swaps to `gatedWriter(socket)` once the client said hello, so a socket over its high-water mark holds the same `ptyReadGate`. The quit drain runs on stdin EOF or on socket close, whichever comes first.

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/core-socket-bridge.test.ts test/unit/pty-flow.test.ts --project unit`
Expected: PASS.

- [ ] **Step 5: Implement the shell side**

`core_proc.cpp`: `Run` gains `SOCKET sock = INVALID_SOCKET` and a flag `usingSocket`. The stdout reader thread, on a line whose `ch` is `core:wire`, calls `connectWire(port, token)`: `WSAStartup` (already done for the driver), `socket`, `connect` to `127.0.0.1:port` with a 3 s `select` timeout, sends the hello line, sets `usingSocket`, then keeps reading from the socket (the pipe reader keeps draining stdout into the log in case the core prints anything). The writer thread writes to the socket when `usingSocket`, the pipe otherwise; a failed connect logs `wire: socket connect failed (<WSAGetLastError>), staying on stdio` and leaves everything as it was. `stop()` closes the socket after the drain. `commandLine()` adds `SEASHELL_WIRE=tcp`. The byte cap on queued lines (Phase 1, 16 MB) applies to either path.

- [ ] **Step 6: Measure**

Rebuild (core, sync, shell, pack). Scratch `f2`: `shell.log` shows `wire: socket connected 127.0.0.1:<port>`. `pingCore {n:200}` three times; `drag divider:<id> 200 0 200` three times (after `key Ctrl+Shift+D`); the throughput gate (`scripts/win/run-native-gates.ps1`, the `throughput` line) once. Expected: `pingCore` median under 0.5 ms, the drag under 2 ms per move, throughput still `p95` under 32 with the shell's peak under 110. Record all in the report. If the drag is still over 2 ms with the ping under 0.5, run step 7.

- [ ] **Step 7: Instrument the shell's half (only if step 6 or Task 1 says the shell is the cost)**

Add to `App::onCoreLine` timing (QPC) of: JSON parse, `UiModel::parse`, `Ui::setModel` (relayout), and the invalidate-to-paint gap; print the medians over the last 200 models in the driver's `stats` as `modelMs: { parse, build, layout, paint }`. The step that dominates is the one to fix in place: a parse over 1 ms means the model is too big for a drag (send `ui:model` deltas for divider moves: the core emits `{ panes: [...], dividers: [...] }` only, flagged `partial: true`, and the shell merges); a relayout over 1 ms means `Ui::layout()` re-registers every hit rect per model (cache the strip's layout when `tabs` did not change). Do the one that dominates, re-measure, record.

- [ ] **Step 8: Spec and commit**

In the design spec section 4.2, replace the first sentence's "talks to it over stdin and stdout" with: "talks to it over a loopback TCP socket the core opens on `127.0.0.1` and announces on its stdout as `{k:'on', ch:'core:wire', p:{port, token}}`; the shell connects, says `core:hello` with the token, and from then on stdin carries only EOF at quit and stdout only the core's log. If the connect fails the shell stays on the pipes, which remain the fallback wire." Add one row to section 14's notes column for Phase 2: "wire: socket (Task 2) or stdio (Task 1 rule)".

```bash
git add src/core/socket-bridge.ts src/core/stdio-bridge.ts src/core/index.ts src/main/pty/flow.ts test/unit/core-socket-bridge.test.ts native/shell/src/core_proc.h native/shell/src/core_proc.cpp docs/superpowers/specs/2026-10-02-seashell-native-design.md
git commit -m "Carry the wire over a loopback socket the core announces on stdout"
```

---

### Task 3: The core's heap after a flood

**Files:**
- Modify: `src/core/index.ts` (the idle collector), `native/shell/src/core_proc.cpp` (`--expose-gc` on the node command line), `scripts/native-gates.mjs` (the throughput line already prints the four numbers)
- Test: `test/unit/core-idle-gc.test.ts`

**Interfaces:**
- Produces: `startIdleCollector(opts: { rss: () => number; lastPtyActivity: () => number; now: () => number; gc: (() => void) | undefined; setInterval: (fn: () => void, ms: number) => unknown; log: (s: string) => void }): { stop(): void }` in `src/core/idle-gc.ts`: every 5 s, `baseline` = the lowest RSS seen so far (so a quiet core sets it in its first minute); when `rss() > baseline + 30 MB` and `now() - lastPtyActivity() > 3000` and `gc` exists, call `gc()` once, log `idle gc: <before> -> <after> MB`, and do not call again until RSS has grown by another 30 MB. `src/main/pty/manager.ts` exposes `lastDataAt(): number` (set in the data handler; one assignment).

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { startIdleCollector } from '../../src/core/idle-gc.js'

function harness(rssSeq: number[]) {
  let i = 0; let t = 0; let lastPty = 0; const gcs: number[] = []; const ticks: Array<() => void> = []
  const c = startIdleCollector({
    rss: () => rssSeq[Math.min(i, rssSeq.length - 1)] * 1024 * 1024,
    lastPtyActivity: () => lastPty, now: () => t, gc: () => gcs.push(t),
    setInterval: (fn) => { ticks.push(fn); return 0 }, log: () => {},
  })
  const tick = (ms: number, pty = false) => { t += ms; if (pty) lastPty = t; ticks[0](); i++ }
  return { tick, gcs, stop: c.stop }
}

describe('idle collector', () => {
  it('collects once when RSS sits 30 MB over its floor with no pty traffic for 3 s', () => {
    const h = harness([70, 70, 120, 120, 120])
    h.tick(5000); h.tick(5000); h.tick(5000)
    expect(h.gcs).toHaveLength(1)
    h.tick(5000); h.tick(5000)
    expect(h.gcs).toHaveLength(1)   // not again until it grows another 30 MB
  })
  it('waits while bytes are still flowing', () => {
    const h = harness([70, 120, 120, 120])
    h.tick(5000, true); h.tick(2000, true)
    expect(h.gcs).toHaveLength(0)
    h.tick(5000)
    expect(h.gcs).toHaveLength(1)
  })
  it('does nothing without a gc function', () => {
    let called = 0
    const c = startIdleCollector({ rss: () => 500e6, lastPtyActivity: () => 0, now: () => 10_000, gc: undefined, setInterval: (fn) => { fn(); return 0 }, log: () => { called++ } })
    expect(called).toBe(0); c.stop()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/unit/core-idle-gc.test.ts --project unit`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`idle-gc.ts` per Interfaces; wire it in `index.ts` after boot with `global.gc` (defined only under `--expose-gc`), `process.memoryUsage().rss`, and the manager's `lastDataAt`. In `core_proc.cpp` the node command line becomes `/usr/bin/node --expose-gc <core>/index.cjs`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/core-idle-gc.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Measure**

Rebuild and run the throughput gate on a scratch `f3` twice. Expected: `coreRss after30s` within 30 MB of `start` (the bar), peak under 140. Record both runs. If the 30 s point still misses, add `--max-semi-space-size=16` to the command line and measure once more; record the result either way and keep whichever command line met the bar, or the plain one if neither did, and write the miss as a Phase 2 follow-up.

- [ ] **Step 6: Stage F gate, snapshot, report**

`npm run typecheck && npm test` green; `scripts/win/run-native-gates.ps1` on a fresh scratch: `latency` under 2 ms per move (or the step 7 result recorded with the number), `throughput` ok, `relay` printed, every Phase 1 gate line still ok. Append "Stage F" to the Phase 2 report (the three medians, the branch taken, the drag figure before and after, the throughput numbers). Then:

```bash
git add src/core/idle-gc.ts src/core/index.ts src/main/pty/manager.ts test/unit/core-idle-gc.test.ts native/shell/src/core_proc.cpp
git commit -m "Collect the core's heap when it idles 30 MB over its floor"
git branch -f snapshot/native-after-wire
```

---
## Stage G: explorer, drawer, path click (Tasks 4 to 7)

### Task 4: The explorer in the controller

**Files:**
- Create: `src/core/controller/explorer.ts`, `test/unit/controller-explorer.test.ts`
- Modify: `src/core/controller/model.ts` (sidebar model and target ids), `src/core/controller/controller.ts` (commands `explorer.toggle`, `explorer.refresh`; events for `sidebar:*` targets; `watch:*` pushes; width persistence; the `reveal` path for Task 7), `src/core/controller/layout.ts` (the grid area shrinks by the sidebar when visible, as `app.tsx:1562-1586` and `layout/sidebar.ts` do)

**Interfaces:**
- Consumes: `fs:readDir { path, respectGitignore: true }` → `Result<{ entries: FsDirEntry[], truncated }>` (`src/shared/ipc.ts`); `watch:subscribe` / `watch:unsubscribe` / `watch:touch` (`send`, `{ dir }`); pushes `watch:changed` / `watch:lost` (`{ dir }`); `expandChain(p, root, isDir)`, `ancestorsOf`, `parentOf` from `src/renderer/explorer/chain.ts`; `isIgnoredDir` from `explorer/ignored.ts`; the store actions `explorer.toggle`, `explorer.setRoot`, `explorer.reveal { path, isDir }` (`store.ts:294-296`, `704-716`); `clampSidebar`, `SIDEBAR_MIN`, `SIDEBAR_MAX`, `widthFromDrag(pointerX, uiScale)` from `layout/sidebar.ts`; `UiState.sidebarWidth`.
- Produces in `model.ts`:

```ts
export interface SidebarRow {
  id: string            // 'row:' + path
  path: string
  name: string          // 'Home' for the root
  depth: number
  isDir: boolean
  expanded: boolean
  selected: boolean
  ignored: boolean      // dim to 45 percent
  flashing: boolean     // the reveal flash, 2.5 s
  chip: string | null   // '#rrggbb' for a file's extension (icons.tsx:33-63 table, copied into explorer.ts)
  error: string | null  // '(ENOENT)' style text for a directory that failed to list
  truncatedAfter: boolean   // this row is followed by the '… too many entries to list' line
}
export interface SidebarModel {
  visible: boolean
  rect: Rect            // the column, DIP, including the path strip
  gripRect: Rect        // the 6 DIP grip between the column and the grid
  width: number         // DIP, 170 to 620 at uiScale 1
  rows: SidebarRow[]
  revealSeq: number     // bumps when the shell should scroll `revealRowId` to the centre
  revealRowId: string | null
  strip: string         // the selected path, or the root; the shell truncates it from the left
  menu: { rowId: string; x: number; y: number; items: Array<{ id: 'open-outside' | 'reveal'; label: string; enabled: boolean }> } | null
}
```

  `UiModel` gains `sidebar: SidebarModel`. Target ids: `sidebar:row:<path>` (click selects, dblclick toggles a dir or opens a file), `sidebar:twisty:<path>` (click toggles without selecting), `sidebar:grip` (`down`/`move`/`up` resize; `dblclick` resets to 260), `sidebar:refresh`, `sidebar:strip` (click copies with the toast `Copied path`), `sidebar:menu:<id>` (a context menu item), `sidebar:empty`. A right button `click` on a row (`button: 2`) opens the menu at the event's point. `Escape` as `key sidebar:menu` closes it, as does any click elsewhere (the controller closes it on the next `down` not inside `sidebar:menu:*`).
- Produces in `explorer.ts`: `class ExplorerState` with `root`, `dirs: Record<path, { entries, truncated, error? }>`, `expanded: Set<string>`, `selected: string | null`, `subscribed: Set<string>`, `flash: { path, until } | null`, and the methods `rows(): SidebarRow[]` (DFS over expanded directories, the root row first), `toggle(path)`, `select(path)`, `applyListing(path, result)`, `markLost(path)`, `revealChain(path, isDir, root): string[]` (the directories to re-read, from `expandChain`), `watchDiff(prev): { subscribe: string[]; unsubscribe: string[] }` (expanded, non-ignored directories; `node_modules` and `.git` never listed, so never here). Pure: no IO, so the tests need no fakes beyond listings.
- Produces in the controller: `explorer.toggle` flips `sidebarVisible` (root set to `home` at boot, `app.tsx:328-365`); the first show reads the root; expanding reads that directory; every listing change recomputes watches and sends the subscribe and unsubscribe sends; `watch:changed { dir }` re-reads `dir` if still expanded; `watch:lost` does nothing (`Explorer.tsx:151-202`); `explorer.refresh` re-reads every expanded directory; `reveal(path, isDir)` (used by Task 7) sets `sidebarVisible`, re-reads every directory on the chain, expands them, selects the row, sets `revealRowId` and bumps `revealSeq`, flashes for 2.5 s (a timer clears `flashing`), and when `path` is outside `root` toasts `<path> is outside the file explorer` (`app.tsx:820-830`); the sidebar width lives in `UiState.sidebarWidth` (saved on `up`); the grid area is the client area minus the sidebar column and grip when visible.

- [ ] **Step 1: Failing tests**

`test/unit/controller-explorer.test.ts` (the ones that matter; add the rest as you go):

```ts
import { describe, expect, it } from 'vitest'
import { ExplorerState } from '../../src/core/controller/explorer.js'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const entry = (name: string, isDir: boolean, ignored = false) => ({ name, isDir, isSymlink: false, size: 0, mtimeMs: 0, ignored })

describe('explorer rows', () => {
  it('lists the root as Home and dims ignored entries', () => {
    const x = new ExplorerState('/Users/joshwald')
    x.applyListing('/Users/joshwald', { ok: true, entries: [entry('dist', true, true), entry('a.ts', false)], truncated: false })
    x.toggle('/Users/joshwald')
    const rows = x.rows()
    expect(rows.map((r) => [r.name, r.depth, r.ignored, r.chip !== null])).toEqual([['Home', 0, false, false], ['dist', 1, true, false], ['a.ts', 1, false, true]])
  })
  it('shows an error row for a directory that failed and the truncated line', () => {
    const x = new ExplorerState('/r')
    x.applyListing('/r', { ok: true, entries: [entry('gone', true), entry('big', true)], truncated: false })
    x.toggle('/r'); x.toggle('/r/gone'); x.toggle('/r/big')
    x.applyListing('/r/gone', { ok: false, error: 'ENOENT' })
    x.applyListing('/r/big', { ok: true, entries: [entry('x', false)], truncated: true })
    const rows = x.rows()
    expect(rows.find((r) => r.path === '/r/gone')?.error).toBe('(ENOENT)')
    expect(rows.find((r) => r.path === '/r/big/x')?.truncatedAfter).toBe(true)
  })
  it('watches expanded directories that are not ignored and unsubscribes on collapse', () => {
    const x = new ExplorerState('/r')
    x.applyListing('/r', { ok: true, entries: [entry('src', true), entry('dist', true, true)], truncated: false })
    x.toggle('/r')
    expect(x.watchDiff(new Set())).toEqual({ subscribe: ['/r'], unsubscribe: [] })
    x.toggle('/r/src'); x.toggle('/r/dist')
    expect(x.watchDiff(new Set(['/r'])).subscribe).toEqual(['/r/src'])   // dist is ignored
    x.toggle('/r/src')
    expect(x.watchDiff(new Set(['/r', '/r/src'])).unsubscribe).toEqual(['/r/src'])
  })
})

describe('explorer in the controller', () => {
  it('toggles the sidebar, reads home, and re-reads a changed directory while it is expanded', async () => {
    const f = fakeDeps()
    const reads: string[] = []
    f.handlers['fs:readDir'] = (p) => { reads.push((p as { path: string }).path); return { ok: true, entries: [entry('src', true)], truncated: false } }
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    await Promise.resolve(); await Promise.resolve()
    expect(reads).toEqual(['/Users/joshwald'])
    expect(c.model().sidebar.visible).toBe(true)
    expect(c.model().sidebar.rows[0]).toMatchObject({ name: 'Home', depth: 0 })
    expect(f.sent.filter(([ch]) => ch === 'watch:subscribe').map(([, p]) => p)).toEqual([{ dir: '/Users/joshwald' }])
    c.push('watch:changed', { dir: '/Users/joshwald' })
    await Promise.resolve(); await Promise.resolve()
    expect(reads).toHaveLength(2)
    c.push('watch:lost', { dir: '/Users/joshwald' })   // nothing happens, nothing throws
    expect(c.model().sidebar.rows).toHaveLength(2)
  })
  it('reveal opens the sidebar, expands the chain, selects and flashes the row, then toasts for a path outside the root', async () => {
    const f = fakeDeps()
    f.handlers['fs:readDir'] = (p) => {
      const path = (p as { path: string }).path
      return { ok: true, entries: path === '/Users/joshwald' ? [entry('seashell-wt', true)] : path === '/Users/joshwald/seashell-wt' ? [entry('redesign', true)] : [entry('README.md', false)], truncated: false }
    }
    const c = new Controller(f.deps, { home: '/Users/joshwald', version: '0', chords: [] })
    await c.boot(GEO)
    await c.reveal('/Users/joshwald/seashell-wt/redesign/README.md', false)
    const sb = c.model().sidebar
    expect(sb.visible).toBe(true)
    expect(sb.revealRowId).toBe('row:/Users/joshwald/seashell-wt/redesign/README.md')
    expect(sb.rows.find((r) => r.id === sb.revealRowId)).toMatchObject({ selected: true, flashing: true })
    f.advance(2600)
    expect(c.model().sidebar.rows.find((r) => r.id === sb.revealRowId)?.flashing).toBe(false)
    await c.reveal('/etc/hosts', false)
    expect(c.model().toast).toBe('/etc/hosts is outside the file explorer')
  })
  it('the grip resizes between 170 and 620 DIP and double-click resets to 260', async () => {
    const f = fakeDeps()
    f.handlers['fs:readDir'] = () => ({ ok: true, entries: [], truncated: false })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('explorer.toggle')
    const mods = { ctrl: false, alt: false, shift: false }
    c.event({ type: 'down', target: 'sidebar:grip', x: 260, y: 100, button: 0, mods })
    c.event({ type: 'move', target: 'sidebar:grip', x: 900, y: 100, button: 0, mods })
    c.event({ type: 'up', target: 'sidebar:grip', x: 900, y: 100, button: 0, mods })
    expect(c.model().sidebar.width).toBe(620)
    c.event({ type: 'dblclick', target: 'sidebar:grip', x: 0, y: 0, button: 0, mods })
    expect(c.model().sidebar.width).toBe(260)
    expect(c.model().panes[0].rect.x).toBeGreaterThanOrEqual(266)   // the grid area starts after the column and grip
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/controller-explorer.test.ts --project unit`
Expected: FAIL, `explorer.js` missing and `c.reveal` undefined.

- [ ] **Step 3: Implement**

Per Interfaces. The extension chip table is copied from `src/renderer/explorer/icons.tsx:33-63` into `explorer.ts` as `CHIP_BY_EXT` with the source comment. `Controller.reveal(path, isDir): Promise<void>` is public and resolves after the chain's directories are read (Task 7 and the drawer call it). The context menu's two items: `Open Outside SeaShell` (files only; `open:withDefaultApp` through the same `openPath` route Task 7 uses with `force: 'os'`) and `Reveal in Finder` (`open:revealInFinder`). The strip click copies through `clip:write` (an `invokeShell`) and toasts `Copied path`. The `fs:readDir` call passes `respectGitignore: true` as `Explorer.tsx` does.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/controller-explorer.test.ts test/unit/controller*.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/controller/explorer.ts src/core/controller/model.ts src/core/controller/controller.ts src/core/controller/layout.ts test/unit/controller-explorer.test.ts
git commit -m "Run the file explorer in the controller"
```

---

### Task 5: The sidebar in the shell

**Files:**
- Create: `native/shell/src/ui/sidebar.cpp`, `native/shell/src/ui/scrollbar.h`, `native/shell/src/ui/scrollbar.cpp`, `native/shell/src/ui/popup.h`, `native/shell/src/ui/popup.cpp`
- Modify: `native/shell/src/model.h` (parse `sidebar`), `native/shell/src/ui/ui.h`, `native/shell/src/ui/ui.cpp` (the new view, hit rects, wheel over the sidebar, the grip drag with capture like the divider's), `native/shell/src/ui/painter.h`, `native/shell/src/ui/painter.cpp` (`folderGlyph`, `fileGlyph`, `twisty`), `native/shell/src/driver.cpp` (new commands `wheel`, `scrollTo`, `rows`)

**Interfaces:**
- Consumes: `SidebarModel` (Task 4), `Painter`, `Tokens`, the redesign spec 6.3 scrollbar and menu values.
- Produces `scrollbar.h`:

```cpp
// The Win7 scrollbar (redesign spec 6.3): 17 DIP wide, arrow buttons with the
// button face, track #f0f0f0 with a 1 px inset #e3e3e3 line, thumb #f0f0f0 to
// #e3e3e3 with a #a0a0a0 border, 2 px radius and three grip lines; hover thumb
// #dcebfc with a #7da2ce border. One per scrolling view; the view owns the offset.
struct ScrollState { float offset = 0; float content = 0; float viewport = 0; bool dragging = false; float grab = 0; };
class ScrollBar {
public:
  void layout(D2D1_RECT_F track, float scale);          // the bar's rect in device pixels (right edge of the view)
  void draw(Painter& p, const ScrollState& s, const std::string& hoverTarget, const std::string& base);   // registers base + ":up", ":down", ":thumb", ":track"
  // Returns true when consumed; `s.offset` updated and clamped. Line = one row height.
  bool mouse(UINT msg, float x, float y, ScrollState& s, float lineDip, const std::string& target);
  static float clampOffset(float offset, float content, float viewport);
};
```

- Produces `popup.h`: `class Popup` drawing a 6.3 menu (`#f0f0f0` face, 1 px `#979797` border, highlight `#dcebfc` with 1 px `#7da2ce` and 3 px radius, separators `#e0e0e0` over `#ffffff`, 2 px drop shadow) from `items: { id, label, enabled, separator }` at a DIP point clamped inside the body; it registers `prefix + id` hit rects; keyboard: Up, Down, Enter, Escape (sends `key <prefix> Escape`). Used by the sidebar's context menu here, by the color and link pickers in Task 15, and by the menu button in Task 16.
- Produces `sidebar.cpp` `Ui::viewSidebar(Painter&)`: the column at `sidebar.rect` on `panel` with a 1 px `panelBorder` right edge; the grip (`sidebar:grip`, 6 DIP, `IDC_SIZEWE`); the header row with `File Browser` left and `⟳` right (`sidebar:refresh`); rows 22 DIP high at `uiScale` (Segoe UI 9 pt): indent 14 DIP per depth, the twisty (`▸` rotated 90 degrees when expanded, drawn as a path, `sidebar:twisty:<path>`), the folder glyph (a Direct2D path of the `icons.tsx` folder outline, open or closed tint) or the file glyph with the extension chip (a 6 DIP square in `chip`), the name ellipsised; `ignored` at 45 percent alpha; `error` text after the name in `badgeText`; the `… too many entries to list` line after a row with `truncatedAfter`; `selected` on the Windows selection fill (`selection` at 25 percent with a 1 px `selection` border); `flashing` a green `#28fe14` fill fading over 1.4 s inside the 2.5 s window (Task 15's animation timer, which already runs for attention); the scrollbar when rows overflow; hover on rows; tooltips with the full path. The bottom strip (`sidebar:strip`, 22 DIP): the path drawn right-aligned and clipped so its end stays visible (the renderer's RTL trick becomes a right-aligned clip), click copies. The context menu through `Popup` with prefix `sidebar:menu:`. A `revealSeq` change scrolls so the reveal row is centred (view state: the shell keeps `sidebarScroll_` and the last `revealSeq` it honoured). The wheel over the column scrolls three rows per notch.
- Produces driver commands: `wheel { target?, x?, y?, dy }` (a `WM_MOUSEWHEEL` at the target's centre or the point, `dy` in notches times 120, through the window procedure); `scrollTo { view: 'sidebar' | 'file:<paneId>', offset }`; `rows` → the sidebar rows as the shell drew them (`{ id, y, h, visible }`), so a gate can check the reveal centring.

- [ ] **Step 1: Implement**

Per Interfaces. `model.h` parses `sidebar` with the Phase 1 tolerance (missing fields default, `rows` an empty list).

- [ ] **Step 2: Driver checks**

Rebuild. Scratch `g5` (one pane at home). `key Ctrl+Shift+B`; `wait /sidebar/visible true`; `shot` to `bakeoff\P2-sidebar.png` Expected by eye: the column on the left, `File Browser` header, the `Home` row with an open folder glyph, the home listing indented one level with folder glyphs and extension chips, the path strip at the bottom reading `/Users/joshwald`, the grid area starting right of the grip. `click sidebar:twisty:/Users/joshwald/seashell-wt` then `wait` for a row with `depth 2`. `wheel { target: 'sidebar:row:/Users/joshwald', dy: -3 }` three times, `rows` Expected: the first row's `y` negative (scrolled). `click sidebar:row:/Users/joshwald/seashell-wt` with `button: 2` Expected: `model.sidebar.menu` non-null; `shot` Expected: the popup with `Open Outside SeaShell` disabled (a directory) and `Reveal in Finder`; `key Escape` closes it. `click sidebar:strip` Expected: toast `Copied path` (save and restore Josh's clipboard around it as the Phase 1 gate did; never print it). `drag sidebar:grip 200 0 20` Expected: `model.sidebar.width` grew by about 200 and the pane rects moved right. `dblclick sidebar:grip` Expected: width 260.

- [ ] **Step 3: Commit**

```bash
git add native/shell/src/ui/sidebar.cpp native/shell/src/ui/scrollbar.h native/shell/src/ui/scrollbar.cpp native/shell/src/ui/popup.h native/shell/src/ui/popup.cpp native/shell/src/model.h native/shell/src/ui/ui.h native/shell/src/ui/ui.cpp native/shell/src/ui/painter.h native/shell/src/ui/painter.cpp native/shell/src/driver.cpp
git commit -m "Draw the file explorer, its scrollbar and its context menu"
```

---

### Task 6: The shell drawer

**Files:**
- Create: `test/unit/controller-drawer.test.ts`, `native/shell/src/ui/drawer.cpp`
- Modify: `src/core/controller/model.ts` (drawer model), `src/core/controller/controller.ts` (`drawer.toggle`, one pty per pane, lazy spawn, header, `cd to pane`, close returns focus, height persistence, drawer death with the pane), `src/core/controller/layout.ts` (the drawer overlays the bottom of the grid area only; pane rects do not change), `native/shell/src/model.h`, `native/shell/src/ui/ui.h`, `native/shell/src/ui/ui.cpp`, `native/shell/src/app.cpp` (draw the drawer's grid; route input to it when the pointer or focus is in the drawer), `native/shell/src/grid_input.cpp` (the hit test includes the drawer's view when `drawer.open`)

**Interfaces:**
- Consumes: `drawerPtyId(paneId)` and `DRAWER_PTY_PREFIX` from `src/renderer/drawer/id.ts`; `cdCommandFor(path)` from `drawer/cd.ts` (returns the `cd '<quoted>'` line or null for a path with control characters); `clampDrawer`, `DRAWER_MIN`, `DRAWER_MAX`, `drawerHeightFromDrag` from `layout/drawer.ts`; `UiState.drawerHeight`; the Phase 1 spawn path (`Controller.spawn`), `grid:cmd create/dispose/focus`, `pty:kill`.
- Produces in `model.ts`:

```ts
export interface DrawerModel {
  open: boolean
  rect: Rect            // the panel over the bottom of the grid area, DIP
  gripRect: Rect        // the 6 DIP top grip
  gridRect: Rect
  height: number        // DIP, 120 to 800 at uiScale 1
  paneId: string | null // the pane whose shell is shown (the focused term pane)
  ptyId: string | null  // 'drawer:<paneId>'
  cols: number
  rows: number
  fontPx: number
  header: { label: string; title: string; showCd: boolean }   // 'Shell · <pane label>'; the OSC title or cwd; cd shown when the drawer cwd differs
  status: 'starting' | 'live' | 'exited'
  focused: boolean      // keyboard focus is in the drawer
}
```

  `UiModel` gains `drawer: DrawerModel`. Target ids: `drawer:grip` (`down`/`move`/`up`), `drawer:cd`, `drawer:close`, `drawer:grid`. The drawer's grid is an ordinary grid to the shell: `grid:cmd create` with `paneId: 'drawer:<paneId>'`; `pty:data` for it arrives under that id; its title and cwd `term:event`s carry that id and update the header.
- Produces in the controller: `drawer.toggle` opens over the focused term pane (toasts `No terminal pane to open a shell for` when none); the first open for a pane spawns `zsh -l` in the pane's live cwd under `drawer:<paneId>` with the real cols and rows (`app.tsx:1296-1304`); switching pane focus switches `paneId` (spawning lazily); closing the drawer returns focus to the pane (`grid:cmd focus` for the pane); a pane closing kills its drawer pty and disposes its grid (`app.tsx:1318-1329`); after the drawer shell exits, the next open respawns (`DrawerShell.tsx:154-178`); `drawer:cd` types `\x15` (Ctrl+U), the `cdCommandFor(paneCwd)` line and `\r` into the drawer pty, refusing a null; the height is `UiState.drawerHeight` (saved on `up`); the drawer tracks its own cwd from its OSC 7 events for `showCd`; path double-clicks in the drawer go through Task 7's path click with the drawer's cwd.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }

describe('drawer', () => {
  it('spawns one shell per pane lazily in the pane cwd and shows it under the grid area', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const pane = c.model().panes[0]
    c.term({ type: 'cwd', paneId: pane.id, cwd: '/h/proj' })
    c.command('drawer.toggle')
    await Promise.resolve()
    const spawns = f.sent.filter(([ch]) => ch === 'pty:spawn').map(([, p]) => p as { paneId: string; cwd: string })
    expect(spawns.at(-1)).toMatchObject({ paneId: `drawer:${pane.id}`, cwd: '/h/proj' })
    const d = c.model().drawer
    expect(d.open).toBe(true)
    expect(d.ptyId).toBe(`drawer:${pane.id}`)
    expect(d.header.label).toBe(`Shell · ${pane.label}`)
    expect(d.rect.y + d.rect.h).toBeCloseTo(pane.rect.y + pane.rect.h, 0)   // flush with the bottom of the grid area
    expect(c.model().panes[0].rect).toEqual(pane.rect)                       // pane rects do not change
    c.command('drawer.toggle'); c.command('drawer.toggle')
    expect(f.sent.filter(([ch]) => ch === 'pty:spawn')).toHaveLength(spawns.length)   // no second spawn
  })
  it('cd to pane types Ctrl+U, the quoted cd and CR, and only when the cwds differ', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const pane = c.model().panes[0]
    c.term({ type: 'cwd', paneId: pane.id, cwd: "/h/it's here" })
    c.command('drawer.toggle')
    await Promise.resolve()
    c.term({ type: 'cwd', paneId: `drawer:${pane.id}`, cwd: '/h' })
    expect(c.model().drawer.header.showCd).toBe(true)
    c.event({ type: 'click', target: 'drawer:cd', x: 0, y: 0, button: 0, mods })
    const writes = f.sent.filter(([ch]) => ch === 'pty:write').map(([, p]) => p as { paneId: string; data: string })
    expect(writes.at(-1)).toEqual({ paneId: `drawer:${pane.id}`, data: "\x15cd '/h/it'\\''s here'\r" })
    c.term({ type: 'cwd', paneId: `drawer:${pane.id}`, cwd: "/h/it's here" })
    expect(c.model().drawer.header.showCd).toBe(false)
  })
  it('a closing pane kills its drawer shell, and the grip clamps the height', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const pane = c.model().panes[0]
    c.command('drawer.toggle')
    await Promise.resolve()
    c.event({ type: 'down', target: 'drawer:grip', x: 0, y: 500, button: 0, mods })
    c.event({ type: 'move', target: 'drawer:grip', x: 0, y: 0, button: 0, mods })
    c.event({ type: 'up', target: 'drawer:grip', x: 0, y: 0, button: 0, mods })
    expect(c.model().drawer.height).toBe(800)
    c.command('pane.close')
    await Promise.resolve(); await Promise.resolve()
    const kills = f.sent.filter(([ch]) => ch === 'pty:kill').map(([, p]) => (p as { paneId: string }).paneId)
    expect(kills).toContain(`drawer:${pane.id}`)
    expect(f.grid().some((g) => g.op === 'dispose' && g.paneId === `drawer:${pane.id}`)).toBe(true)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/controller-drawer.test.ts --project unit`
Expected: FAIL, `drawer` undefined on the model.

- [ ] **Step 3: Implement the controller**

Per Interfaces. The drawer's spawn uses the same `spawn()` as panes with `paneId: 'drawer:<id>'` and the drawer's `cols`/`rows` from its `gridRect` and the window cell. `pty:exit` for a drawer id sets `status: 'exited'` on the drawer (no exit overlay; the next open respawns). The `pane.exited` dispatch must not be sent for drawer ids (the store has no such pane).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/controller-drawer.test.ts test/unit/controller*.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Implement the shell**

`drawer.cpp` `Ui::viewDrawer(Painter&)`: the panel at `drawer.rect` on `panel` with a 1 px `panelBorder` top line and the 6 DIP grip (`IDC_SIZENS`); a 24 DIP header: `header.label` bold, then `header.title` in `badgeText`, `cd to pane` as a `win7Button` when `showCd` (`drawer:cd`), `✕` right (`drawer:close`); the grid area below is `drawer:grid`. `App::paintBody` draws the drawer's grid (by `drawer.ptyId`) after the panes and before `Ui::drawBody`'s overlays, clipped to `drawer.gridRect`; `GridInput::hitTest` considers the drawer's view first when `drawer.open` and the point is inside `drawer.rect` (the drawer floats over panes). Keyboard focus: a `down` in `drawer:grid` sends `grid:cmd`-free focus through the model (`drawer.focused`); the shell routes keys to the drawer's grid when `drawer.focused`. The cursor blink and the selection work as for any grid (the maps are keyed by id).

- [ ] **Step 6: Driver checks**

Rebuild. Scratch `g6`. `key Ctrl+Shift+J`; `wait /drawer/open true`; `waitText` for `%` in `grid drawer:<paneId>`; `shot` to `bakeoff\P2-drawer.png` Expected by eye: the panel over the bottom of the pane with the header `Shell · ~`, the prompt in the drawer grid, the pane's own grid still visible above. `text "cd /tmp"` then `key Enter` (the focus is in the drawer after the toggle); `wait /drawer/header/showCd true`; `click drawer:cd`; `waitText` for the pane cwd in the drawer's `grid`. `drag drawer:grip 0 -150 15` Expected: `drawer.height` grew by about 150. `click drawer:close` Expected: `drawer.open false` and the pane's grid has the cursor (`stats.focusedGrid` equals the pane id; add that field to `stats` if missing). `key Ctrl+Shift+J` again Expected: the same drawer pty (no new `pty:spawn` in `core.log`).

- [ ] **Step 7: Commit**

```bash
git add src/core/controller/model.ts src/core/controller/controller.ts src/core/controller/layout.ts test/unit/controller-drawer.test.ts native/shell/src/ui/drawer.cpp native/shell/src/model.h native/shell/src/ui/ui.h native/shell/src/ui/ui.cpp native/shell/src/app.cpp native/shell/src/grid_input.cpp
git commit -m "Add the shell drawer with one lazy shell per pane"
```

---

### Task 7: Path click, every gesture

**Files:**
- Create: `test/unit/controller-pathclick.test.ts`
- Modify: `src/core/controller/controller.ts` (`pathClick` routes by modifiers; `openPath` from `explorer/open.ts` with controller deps; the explorer double-click on a file; `preview.file` command), `src/core/controller/model.ts` (nothing new; the file pane kind exists), `native/shell/src/grid_input.cpp` (the `pathclick` term event carries `mods` already; confirm Ctrl and Ctrl+Alt arrive)

**Interfaces:**
- Consumes: `tokenizeLine`, `resolvePathClick` (already used in Phase 1), `openPath(fullPath, deps, force?)` with `OpenDeps { probe, withDefaultApp, revealInFinder, onOpenInViewer, onToast }` (`src/renderer/explorer/open.ts`), `Controller.reveal` (Task 4), the store action `pane.newFile` (`store.ts:440-473`: one file pane per tab, retargeted when another file opens), `fs:probe`.
- Produces: `pathClick(paneId, line, index, mods)`: a hit resolves as in Phase 1; then plain double-click → `reveal(resolved, isDir)` (never opens); Ctrl → `openPath(resolved, deps)` whose `onOpenInViewer` dispatches `pane.newFile` in the active tab (Stage H draws it; until then the pane shows `Loading…` and its label is the basename); Ctrl+Alt → `openPath(resolved, deps, 'os')`; a directory is only revealed and expanded whatever the modifiers (`PaneView.tsx:364-387`); a miss toasts as before. The drawer's clicks (`paneId` starting `drawer:`) resolve against the drawer's cwd. The explorer's double-click on a file row goes through the same `openPath`. `preview.file` (Ctrl+Alt+O) toasts `Double-click a path in a pane, or a file in the explorer, to preview it` and opens the explorer (`app.tsx:935`).

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

function setup() {
  const f = fakeDeps()
  f.handlers['fs:statBatch'] = (p) => ({ results: (p as { candidates: string[] }).candidates.map((c, i) => ({ i, resolved: c.startsWith('/') ? c : `/w/${c}`, kind: /\/src\/?$/.test(c) ? 'dir' : 'file', size: 10, exec: false })) })
  f.handlers['fs:findBySuffix'] = () => ({ paths: [], truncated: false })
  f.handlers['fs:probe'] = (p) => ({ exists: true, isDir: false, size: 10, ext: 'md', route: 'viewer', path: (p as { path: string }).path })
  const e = (name: string, isDir: boolean) => ({ name, isDir, isSymlink: false, size: 0, mtimeMs: 0, ignored: false })
  f.handlers['fs:readDir'] = (p) => ({ ok: true, entries: (p as { path: string }).path === '/w' ? [e('src', true), e('README.md', false), e('notes.txt', false)] : [], truncated: false })
  f.handlers['open:withDefaultApp'] = () => ({ ok: true })
  return f
}
const line = 'see /w/README.md for details'
const idx = line.indexOf('README')

describe('path click gestures', () => {
  it('a plain double-click reveals and never opens', async () => {
    const f = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.term({ type: 'pathclick', paneId: c.model().panes[0].id, line, index: idx, mods: { ctrl: false, alt: false, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    expect(c.model().sidebar.visible).toBe(true)
    expect(c.model().sidebar.revealRowId).toBe('row:/w/README.md')
    expect(c.model().panes.every((p) => p.kind === 'term')).toBe(true)
  })
  it('Ctrl opens a file pane in the tab, retargeted by the next file', async () => {
    const f = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    const term = c.model().panes[0].id
    c.term({ type: 'pathclick', paneId: term, line, index: idx, mods: { ctrl: true, alt: false, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    let files = c.model().panes.filter((p) => p.kind === 'file')
    expect(files).toHaveLength(1)
    expect(files[0].label).toBe('README.md')
    c.term({ type: 'pathclick', paneId: term, line: 'open /w/notes.txt now', index: 6, mods: { ctrl: true, alt: false, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    files = c.model().panes.filter((p) => p.kind === 'file')
    expect(files).toHaveLength(1)
    expect(files[0].label).toBe('notes.txt')
  })
  it('Ctrl+Alt hands the file to the default app and toasts for an executable', async () => {
    const f = setup()
    f.handlers['open:withDefaultApp'] = () => ({ ok: false, error: 'refused-executable' })
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.term({ type: 'pathclick', paneId: c.model().panes[0].id, line, index: idx, mods: { ctrl: true, alt: true, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    expect(f.sent.some(([ch]) => ch === 'open:withDefaultApp')).toBe(true)
    expect(c.model().toast).toBe('That file is executable, revealed in Finder instead')
  })
  it('a directory is revealed and expanded whatever the modifiers', async () => {
    const f = setup()
    f.handlers['fs:probe'] = () => ({ exists: true, isDir: true, size: 0, ext: '', route: 'reveal' })
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.term({ type: 'pathclick', paneId: c.model().panes[0].id, line: 'in /w/src/ now', index: 4, mods: { ctrl: true, alt: false, shift: false } })
    await new Promise((r) => setTimeout(r, 0))
    expect(c.model().panes.every((p) => p.kind === 'term')).toBe(true)
    expect(c.model().sidebar.rows.find((r) => r.path === '/w/src')?.expanded).toBe(true)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/controller-pathclick.test.ts --project unit`
Expected: FAIL, the plain click still toasts the path and `pane.newFile` is never dispatched.

- [ ] **Step 3: Implement**

Per Interfaces. `openDeps()` on the controller builds the `OpenDeps` from `this.deps.invoke` for `fs:probe`, `open:withDefaultApp` and `open:revealInFinder` (the latter two are `SHELL_CHANNELS`, so they go through `invokeShell`; the shell converts the Linux path), `onOpenInViewer` → `pane.newFile` in the active tab plus `pane.focus`, `onToast` → `toast`. The `grid_input.cpp` `pathclick` already sends `mods`; check that `Ctrl` double-click reaches the shell's double-click path rather than the mouse-report path when the program has no tracking on, and that `Alt` double-click under tracking keeps the second click from the pty (`terminal.ts:475-492`, Phase 1 Task 13).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/controller-pathclick.test.ts test/unit/controller*.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Driver checks and the Stage G gate**

Rebuild. Scratch `g7` with the pane cwd at `/Users/joshwald/seashell-wt/redesign` (`text "cd ~/seashell-wt/redesign"`, Enter). `text "echo /Users/joshwald/seashell-wt/redesign/README.md"`, Enter; `dblclick` at the printed path's cell (the driver's `dblclick` takes `paneId`, `absRow`, `col`, as Phase 1 Task 13 used) Expected: `sidebar.visible`, `revealRowId` = `row:/Users/joshwald/seashell-wt/redesign/README.md`, the row selected, `rows` shows it in the visible band; `shot` to `bakeoff\P2-reveal.png`. `text "echo /mnt/c/seashell-build/redesign/bakeoff/results.jsonl"`, Enter, `dblclick` on it with `mods: { ctrl: true, alt: true }` Expected: `shell.log` shows `open:withDefaultApp C:\seashell-build\redesign\bakeoff\results.jsonl` (the shell converts and calls `ShellExecute`; whatever app opens it is outside the scratch and is closed by the gate through its own pid only if the gate started it; prefer a `.jsonl` association check in `shell.log` over opening anything: in test mode, `open:*` log and return ok without executing). `text "echo src/main/index.ts:45"`, Enter, `dblclick` Expected: reveal of `index.ts` in the explorer. The Ctrl rows of the matrix wait for Stage H (Task 11).

Stage G gate: `npm run typecheck && npm test` green; the Task 5, 6 and 7 driver checks green; W10 still restores (`run-native-gates.ps1` `restore: ok`). Append "Stage G" to the report (the PNG paths, the drawer and reveal results, decisions taken). Then:

```bash
git add src/core/controller/controller.ts test/unit/controller-pathclick.test.ts native/shell/src/grid_input.cpp native/shell/src/hostapi.cpp
git commit -m "Route path double-clicks to reveal, preview and the default app"
git branch -f snapshot/native-after-explorer
```

---
## Stage H: previews (Tasks 8 to 11)

**SKIPPED in full by the amendment of 10/03 04:30 (Josh). Do not run Tasks 8 to 11. Task 7b replaces them.**

### Task 8: The view channel and the file preview in the core

**Files:**
- Create: `src/core/controller/preview.ts`, `src/core/highlight.ts`, `test/unit/controller-preview.test.ts`, `test/unit/core-highlight.test.ts`
- Modify: `src/core/protocol.ts` (`CORE_PUSH_TO_SHELL` adds `view:cmd`; `SHELL_CHANNELS` adds `dialog:confirm`), `test/unit/core-protocol.test.ts` (the lists), `native/shell/src/wire.cpp` (the C++ sets, kept equal by the Phase 1 parity test), `src/core/controller/model.ts` (`FileViewModel`, `ViewCmd`, `ViewEvent`), `src/core/controller/controller.ts` (file pane lifecycle, `view:event` routing, the confirms on close), `src/core/index.ts` (route `view:event` to the controller; stage `shiki` beside the bundle), `scripts/build-core.mjs` (`shiki` external, copied to `out/core/node_modules/shiki` with only the 27 grammars, `github-dark-default` and the two engine entry points), `scripts/win/pack-native.ps1` and `scripts/win/stage-core.sh` (carry `node_modules/shiki`)

**Interfaces:**
- Consumes: `fs:readTextFile { path, maxBytes: 8 MiB }` → `Result<{ text, lines, size, truncated, mtimeMs }, EBINARY | ETOOBIG | ENOENT | EACCES>`; `fs:writeTextFile { path, text, expectedMtimeMs }` → `Result<{ mtimeMs }, ECONFLICT | EBINARY | ESCOPE | ETOOBIG | ENOENT | EACCES>`; `fs:probe`; the store actions `pane.newFile`, `pane.setRawSource`, `pane.close`, `tab.close`; `languageFor(filePath)` and the `LANGS` loaders and `createHighlighterCore` usage in `src/renderer/viewer/highlight.ts` (import `languageFor` in place; the loader table is copied into `src/core/highlight.ts` because the renderer's dynamic `import()`s are Vite chunks).
- Produces in `protocol.ts`: `CORE_PUSH_TO_SHELL = ['pty:data', 'ui:model', 'grid:cmd', 'view:cmd']`; `SHELL_CHANNELS` gains `dialog:confirm` (`invoke`, `p: { title, message, ok, cancel }` → `{ ok: boolean }`; in test mode the shell answers from the driver's queue, see Task 9).
- Produces in `model.ts`:

```ts
export interface FileViewModel {
  paneId: string
  path: string
  state: 'loading' | 'ready' | 'error'
  error: string | null          // 'Could not read this file (ENOENT)'
  truncated: boolean            // 'truncated at 8 MB', editing disabled
  raw: boolean                  // Plain (true) or Highlight (false): pane.rawSource
  highlighted: boolean          // runs were produced (size under 512 KB and a known language)
  editing: boolean
  dirty: boolean
  conflict: boolean             // the mtime banner with Reload from disk
  saveError: string | null      // 'Could not save this file - it may be read-only or outside your home folder'
  kind: 'text' | 'image' | 'pdf'
  find: { open: boolean; query: string; index: number; total: number } | null   // the preview's own find (no regex, no cap)
  seq: number                   // bumps on every view:cmd text so the shell knows a reload happened
}
export type ViewCmd =
  | { paneId: string; op: 'text'; text: string; runs: HighlightRun[] | null; truncated: boolean; mtimeMs: number }
  | { paneId: string; op: 'image'; path: string }        // the Linux path; the shell converts and decodes with WIC
  | { paneId: string; op: 'pdf'; path: string }
  | { paneId: string; op: 'web'; url: string }           // Task 10
  | { paneId: string; op: 'webBack' | 'webForward' | 'webReload' | 'webStop' }
  | { paneId: string; op: 'edit'; on: boolean }
  | { paneId: string; op: 'dispose' }
export interface HighlightRun { line: number; col: number; len: number; color: string }   // '#rrggbb'; UTF-16 units
export type ViewEvent =
  | { type: 'save'; paneId: string; text: string }
  | { type: 'dirty'; paneId: string; dirty: boolean }
  | { type: 'webNavigated'; paneId: string; url: string; title: string }
  | { type: 'webLoading'; paneId: string; loading: boolean }
  | { type: 'webFailed'; paneId: string; code: number; description: string }
```

  `PaneModel` gains `file: FileViewModel | null` (set for `kind: 'file'`). Target ids: `pane:<id>:raw` (the Plain/Highlight toggle), `pane:<id>:edit`, `pane:<id>:reveal`, `pane:<id>:open`, `pane:<id>:save`, `pane:<id>:discard`, `pane:<id>:done`, `pane:<id>:reload`, `pane:<id>:find:query|next|prev|close`.
- Produces in `src/core/highlight.ts`: `highlightRuns(text: string, filePath: string): Promise<HighlightRun[] | null>`: `null` above 512 KB or for an unknown language; otherwise `createHighlighterCore({ themes: [githubDarkDefault], langs: [loader], engine: createJavaScriptRegexEngine({ forgiving: true }) })` once per language (cached), `codeToTokens(text, { lang, theme: 'github-dark-default' })`, flattened to runs with the token color (skipping the theme's default foreground). Grammars load from `require.resolve('shiki/langs/<name>.mjs')` next to the bundle.
- Produces in `preview.ts`: `class PreviewState` per file pane: `open(path)` → `loading`, invokes `fs:probe` then `fs:readTextFile` (or marks `image`/`pdf` by extension: png jpg jpeg gif webp bmp ico, pdf), on success sends `view:cmd text` with the runs (or `image`/`pdf`) and sets `ready`; `EBINARY`/`ETOOBIG` route to the OS app with the toast (`open.ts`); `toggleRaw()`; `edit()` → `view:cmd edit on` (refused when `truncated`); `save(text)` → `fs:writeTextFile` with the loaded `mtimeMs`; `ECONFLICT` → `conflict: true`; other errors → `saveError`; success → `dirty false`, the new mtime, a `view:cmd text` reload is NOT sent (the editor keeps its buffer); `reload()` after the confirm `Reload from disk and discard your edits?` → re-read, `view:cmd text`; `discard()` after `Discard unsaved changes?` → `view:cmd edit off` with a `view:cmd text` reload; `done()` → `edit off` (allowed only when not dirty, else behaves like discard with the confirm); `find(query)`, `findStep(dir)`: a literal, case-insensitive search over the text producing `index/total` (the shell highlights from the same algorithm, Task 9); `dispose()`.
- Produces in the controller: `pane.close` on a dirty file pane asks `Discard unsaved changes in this file?` (`app.tsx:418`); `tab.close` with a dirty file pane asks `This tab has a file with unsaved changes. Discard them?` (`app.tsx:440`); `pane.closeAll` closes only the non-term panes of the active tab, toasting `No preview panes open` when there are none (`app.tsx:832-840`), asking the same confirm per dirty pane; `edit.find` in a file pane opens the preview's find; in a web pane toasts `Find is not available in a web preview`.

- [ ] **Step 1: Failing tests**

`test/unit/controller-preview.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

function setup(text = 'hello\nworld\n') {
  const f = fakeDeps()
  let mtime = 1000
  const confirms: boolean[] = []
  f.handlers['fs:probe'] = (p) => ({ exists: true, isDir: false, size: text.length, ext: 'txt', route: 'viewer', path: (p as { path: string }).path })
  f.handlers['fs:readTextFile'] = () => ({ ok: true, text, lines: 2, size: text.length, truncated: false, mtimeMs: mtime })
  f.handlers['fs:writeTextFile'] = (p) => { const r = p as { expectedMtimeMs: number }; if (r.expectedMtimeMs !== mtime) return { ok: false, error: 'ECONFLICT' }; mtime += 1; return { ok: true, mtimeMs: mtime } }
  f.deps.invokeShell = async <T,>(ch: string): Promise<T> => (ch === 'dialog:confirm' ? ({ ok: confirms.shift() ?? false } as T) : ({ ok: true } as T))
  const bump = () => { mtime += 5 }
  return { f, confirms, bump }
}
const views = (f: ReturnType<typeof fakeDeps>) => f.shellOut.filter(([ch]) => ch === 'view:cmd').map(([, p]) => p as { op: string; paneId: string; text?: string })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('file preview', () => {
  it('opens a file pane, reads it, sends the text once and marks it ready', async () => {
    const { f } = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.openFile('/w/a.txt')
    await flush()
    const pane = c.model().panes.find((p) => p.kind === 'file')!
    expect(pane.file).toMatchObject({ state: 'ready', path: '/w/a.txt', kind: 'text', raw: false, highlighted: false })
    expect(views(f)).toEqual([expect.objectContaining({ op: 'text', paneId: pane.id, text: 'hello\nworld\n' })])
  })
  it('a save against a changed mtime raises the conflict banner and reload asks first', async () => {
    const { f, confirms, bump } = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.openFile('/w/a.txt'); await flush()
    const id = c.model().panes.find((p) => p.kind === 'file')!.id
    c.event({ type: 'click', target: `pane:${id}:edit`, x: 0, y: 0, button: 0, mods: { ctrl: false, alt: false, shift: false } })
    c.view({ type: 'dirty', paneId: id, dirty: true })
    bump()
    c.view({ type: 'save', paneId: id, text: 'hello\nthere\n' }); await flush()
    expect(c.model().panes.find((p) => p.id === id)!.file).toMatchObject({ conflict: true, dirty: true, editing: true })
    confirms.push(false)
    c.event({ type: 'click', target: `pane:${id}:reload`, x: 0, y: 0, button: 0, mods: { ctrl: false, alt: false, shift: false } }); await flush()
    expect(views(f).filter((v) => v.op === 'text')).toHaveLength(1)   // declined: no reload
    confirms.push(true)
    c.event({ type: 'click', target: `pane:${id}:reload`, x: 0, y: 0, button: 0, mods: { ctrl: false, alt: false, shift: false } }); await flush()
    expect(views(f).filter((v) => v.op === 'text')).toHaveLength(2)
    expect(c.model().panes.find((p) => p.id === id)!.file).toMatchObject({ conflict: false, dirty: false })
  })
  it('closing a dirty pane and a tab with a dirty pane ask first', async () => {
    const { f, confirms } = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.openFile('/w/a.txt'); await flush()
    const id = c.model().panes.find((p) => p.kind === 'file')!.id
    c.view({ type: 'dirty', paneId: id, dirty: true })
    confirms.push(false)
    c.command('pane.close'); await flush()
    expect(c.model().panes.some((p) => p.id === id)).toBe(true)
    confirms.push(false)
    c.command('tab.close'); await flush()
    expect(c.model().tabs).toHaveLength(1)
    confirms.push(true)
    c.command('tab.close'); await flush()
    expect(c.model().tabs).toHaveLength(0)
  })
  it('Close All Panes closes only previews and toasts when there are none', async () => {
    const { f } = setup()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.closeAll')
    expect(c.model().toast).toBe('No preview panes open')
    c.openFile('/w/a.txt'); await flush()
    c.command('pane.closeAll'); await flush()
    expect(c.model().panes.map((p) => p.kind)).toEqual(['term'])
    expect(views(f).some((v) => v.op === 'dispose')).toBe(true)
  })
})
```

`test/unit/core-highlight.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { highlightRuns } from '../../src/core/highlight.js'

describe('highlight runs', () => {
  it('colors a TypeScript keyword and leaves plain text without a run', async () => {
    const runs = await highlightRuns('const x = 1\n', '/w/a.ts')
    expect(runs).not.toBeNull()
    expect(runs!.some((r) => r.line === 0 && r.col === 0 && r.len === 5)).toBe(true)   // 'const'
    expect(runs!.every((r) => /^#[0-9a-f]{6}$/i.test(r.color))).toBe(true)
  })
  it('returns null for an unknown language and for a large file', async () => {
    expect(await highlightRuns('x', '/w/a.unknownext')).toBeNull()
    expect(await highlightRuns('a'.repeat(512 * 1024 + 1), '/w/a.ts')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/controller-preview.test.ts test/unit/core-highlight.test.ts --project unit`
Expected: FAIL, `openFile`, `view` and `highlight.js` missing.

- [ ] **Step 3: Implement**

Per Interfaces. `Controller.openFile(path)` is the public entry Task 7's `onOpenInViewer` and the explorer's double-click use; `Controller.view(e: ViewEvent)` is the public entry `index.ts` routes `view:event` to. The esbuild script marks `shiki` external and copies `node_modules/shiki/dist/core.mjs`, `engine-javascript.mjs`, `themes/github-dark-default.mjs`, the 27 `langs/*.mjs` files the table names and `package.json` into `out/core/node_modules/shiki/` (the same relative layout, so `require.resolve` from the bundle finds them); `stage-core.sh` and `pack-native.ps1` copy `node_modules` along with `index.cjs`. Confirms go through `this.deps.invokeShell('dialog:confirm', {...})`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/controller-preview.test.ts test/unit/core-highlight.test.ts test/unit/core-protocol.test.ts test/unit/controller*.test.ts --project unit && npm run typecheck && node scripts/build-core.mjs && ls out/core/node_modules/shiki/langs | wc -l`
Expected: PASS, clean, the bundle builds, 27 grammars.

- [ ] **Step 5: Commit**

```bash
git add src/core/protocol.ts src/core/highlight.ts src/core/controller/preview.ts src/core/controller/model.ts src/core/controller/controller.ts src/core/index.ts scripts/build-core.mjs scripts/win/pack-native.ps1 scripts/win/stage-core.sh test/unit/controller-preview.test.ts test/unit/core-highlight.test.ts test/unit/core-protocol.test.ts native/shell/src/wire.cpp
git commit -m "Read, highlight and save previewed files from the core"
```

---

### Task 9: The file view in the shell

**Files:**
- Create: `native/shell/src/ui/fileview.h`, `native/shell/src/ui/fileview.cpp`, `native/shell/src/ui/editor.h`, `native/shell/src/ui/editor.cpp`, `native/shell/src/ui/imageview.h`, `native/shell/src/ui/imageview.cpp`
- Modify: `native/shell/src/model.h` (`file` on a pane, `ViewCmd` parsing), `native/shell/src/wire.h`, `native/shell/src/wire.cpp` (`onViewCmd`, `sendView`), `native/shell/src/app.cpp` (one `FileView` per file pane, drawn in the pane's `gridRect`), `native/shell/src/ui/ui.h`, `native/shell/src/ui/ui.cpp` (the toolbar and banners view; routing input in a file pane), `native/shell/src/hostapi.cpp` (`dialog:confirm`), `native/shell/src/driver.cpp` (`confirm`, `fileText`, `editorText`, `editorType`)

**Interfaces:**
- Consumes: `FileViewModel`, `ViewCmd` (Task 8), `ScrollBar` (Task 5), `Painter`, `Gfx::wic()`.
- Produces `fileview.h`: `class FileView` holding the text as lines (UTF-16), the runs, a `ScrollState`, a `DWRITE` layout per visible line cached until the text or font changes (Consolas at the pane's `fontPx`), line numbers in a 5-character gutter in `badgeText`, the find highlights (`#255A1E` every match, `#3C5A8A` the current one, from the same case-insensitive literal search the core ran, so the counts agree), `draw(Painter&, rect, const FileViewModel&, bool focused)`, `wheel(dy)`, `mouse(...)` for the scrollbar and selection (drag-select with copy on `Ctrl+Shift+C` through the clipboard; no edit), `scrollToLine(n)` (centres it; used when the path carried `:line`, Task 11), `setText(text, runs, truncated)`.
- Produces `editor.h`: `class Editor` wrapping a child `EDIT` control (`WS_CHILD | ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN | WS_VSCROLL`, Consolas at the pane's `fontPx`, `ES_NOHIDESEL`), created in the body window at the pane's text rect when `view:cmd edit on` and destroyed on `edit off` or dispose; `EN_CHANGE` → `view:event dirty` (once per transition); `Ctrl+S` (subclassed `WM_KEYDOWN`) → `view:event save` with the whole text as UTF-8; `Escape` → nothing (Done and Discard are buttons); `WM_SETFOCUS` tells `Ui` an edit has focus so the grid stops blinking and chords still work (the subclass passes app chords to `GridInput::key` first, as `EditWidget::key` does); the control's background `0x1E1E1E` and text `#D4D4D4` through `WM_CTLCOLOREDIT`.
- Produces `imageview.h`: `class ImageView` decoding the Windows path with WIC into an `ID2D1Bitmap` (recreated after `D2DERR_RECREATE_TARGET`), centred and scaled down to fit (never up), the file's dimensions in the toolbar; a GIF's frames with their delays through `IWICBitmapDecoder` frame metadata (`/grctlext/Delay`) played on a timer; `Could not read this file` when WIC fails.
- Produces the toolbar view in `ui.cpp` (`Ui::viewFileToolbar`): a 28 DIP bar under the pane title with `Plain`/`Highlight` as a two-state `win7Button` (`pane:<id>:raw`, disabled when not `highlighted`), `Edit` (`pane:<id>:edit`, disabled when `truncated`), `Reveal`, `Open`; in edit mode `Save` (disabled unless `dirty`), `Discard`, `Done`, and the `● unsaved changes` flag in `danger`; the `truncated at 8 MB` flag; the conflict banner (`The file changed on disk.` with `Reload from disk`, `pane:<id>:reload`) and `saveError` text in `danger`; the preview find bar reusing Phase 1's find bar painter with the preview targets (no `Aa`, no `.*`, counter `N of M`); `Loading…` and the error text centred when not `ready`. An image pane shows only `Reveal` and `Open`; a PDF pane (Task 10) the same.
- Produces `hostapi.cpp` `dialog:confirm`: `MessageBoxW(hwnd, message, title, MB_OKCANCEL | MB_ICONQUESTION)` with the button labels from `ok`/`cancel` through `TaskDialogIndirect` when they differ from OK and Cancel; in test mode the answer comes from the driver's `confirm` queue (`{ answer: true|false }`, FIFO; an empty queue answers false and logs `confirm with no queued answer`), and the shell logs `confirm: <message> -> <answer>`.
- Produces driver commands: `confirm { answer }` (queue one answer), `fileText { paneId }` → `{ lines, first: <first 3 lines>, scrollLine, matches }`, `editorText { paneId }` → the EDIT control's text, `editorType { paneId, text }` (sends `WM_CHAR`s to the control so `EN_CHANGE` fires as it would for typing), `editorKey { paneId, chord }` (`Ctrl+S`).

- [ ] **Step 1: Implement**

Per Interfaces. `App` keeps `std::map<paneId, FileView>`, `Editor` and `ImageView` instances keyed by pane, created on the first `view:cmd` for that pane and dropped on `dispose` or when the pane leaves the model.

- [ ] **Step 2: Driver checks**

Rebuild. Scratch `h9`; make a test file through the pane: `text "printf 'const x = 1\\nlet y = \"two\"\\n' > /tmp/p2-a.ts && echo /tmp/p2-a.ts"`, Enter; `dblclick` on the printed path with `mods: { ctrl: true }`; `wait /panes/1/file/state ready`; `shot` to `bakeoff\P2-file.png` Expected by eye: the file pane titled `p2-a.ts` with the `file` badge, the toolbar with `Highlight` pressed, two numbered lines with `const` and `let` coloured and `"two"` in the string colour. `click pane:<id>:raw`, `shot` Expected: the same text uncoloured. `click pane:<id>:edit`; `editorType { text: 'x' }`; `wait /panes/1/file/dirty true` Expected: `● unsaved changes` and `Save` enabled. From the pane: `text "echo appended >> /tmp/p2-a.ts"`, Enter (the file changes under the editor); `editorKey Ctrl+S`; `wait /panes/1/file/conflict true`; `shot` to `bakeoff\P2-conflict.png` Expected: the banner with `Reload from disk`. `confirm { answer: true }`; `click pane:<id>:reload`; `wait /panes/1/file/conflict false`; `fileText` Expected: three lines, the third `appended`. `click pane:<id>:edit`; `editorType { text: 'z' }`; `confirm { answer: false }`; `click pane:<id>:close` Expected: the pane stays and `shell.log` has `confirm: Discard unsaved changes in this file? -> false`. `confirm { answer: true }`; `click pane:<id>:close` Expected: the pane is gone. Image: `text "echo /mnt/c/seashell-build/redesign/bakeoff/E-native.png"`, Enter, Ctrl double-click; `wait /panes/1/file/kind image`; `shot` to `bakeoff\P2-image.png` Expected: the screenshot centred in the pane, scaled to fit, its dimensions in the toolbar. Preview find: open the `.ts` file again, `key Ctrl+Shift+F`, `text "x"` Expected: `file.find` reads `1 of 1` (the counter counts `x` once in `const x`; `let y` has none), `fileText.matches` 1.

- [ ] **Step 3: Commit**

```bash
git add native/shell/src/ui/fileview.h native/shell/src/ui/fileview.cpp native/shell/src/ui/editor.h native/shell/src/ui/editor.cpp native/shell/src/ui/imageview.h native/shell/src/ui/imageview.cpp native/shell/src/model.h native/shell/src/wire.h native/shell/src/wire.cpp native/shell/src/app.cpp native/shell/src/ui/ui.h native/shell/src/ui/ui.cpp native/shell/src/hostapi.cpp native/shell/src/driver.cpp
git commit -m "Draw file previews with highlighting, an editor, images and confirms"
```

---

### Task 10: WebView2 for web and PDF panes

**Files:**
- Create: `native/shell/src/ui/webview.h`, `native/shell/src/ui/webview.cpp`, `test/unit/controller-web.test.ts`
- Modify: `native/shell/vcpkg.json` (add `webview2`), `native/shell/CMakeLists.txt` (`find_package(unofficial-webview2 CONFIG REQUIRED)` and link `unofficial::webview2::webview2`, or the port's exported name after `vcpkg install` prints it; record the exact name in the report), `src/core/controller/model.ts` (`WebViewModel`), `src/core/controller/controller.ts` (`preview.web`, the URL bar logic, `pane.setUrl`, `pane.newWeb`, the host:port label, the error banner), `native/shell/src/model.h`, `native/shell/src/app.cpp` (one `WebPane` per web or PDF pane), `native/shell/src/ui/ui.cpp` (the URL bar view; the empty state), `native/shell/src/driver.cpp` (`web { paneId }`)

**Interfaces:**
- Consumes: `normalizeUrl(input)` (`src/renderer/panes/WebPreview.tsx:41-59`, a pure function in a React file: copy it into `src/core/controller/web.ts` with the source comment and its tests from `test/dom` if any exist, else write them); the store actions `pane.newWeb`, `pane.setUrl` (`store.ts:230-237` sets the label to host:port); `open:externalHttp`.
- Produces in `model.ts`:

```ts
export interface WebViewModel {
  url: string                 // the committed URL, '' for the empty state
  draft: string               // the URL field's text (the edit widget target 'pane:<id>:url')
  loading: boolean
  canBack: boolean
  canForward: boolean
  error: string | null        // 'Could not load - <description>'
  empty: boolean              // 'Enter an address to preview' / 'a dev server, e.g. localhost:3000'
}
```

  `PaneModel` gains `web: WebViewModel | null`. Target ids: `pane:<id>:back`, `pane:<id>:forward`, `pane:<id>:reload` (stop while loading), `pane:<id>:url` (the edit widget; `Enter` navigates through `normalizeUrl`, a null toasts `Enter an http:// or https:// address`; `Escape` reverts the draft), `pane:<id>:external` (`open:externalHttp` with the committed URL).
- Produces `webview.h`: `class WebPane`: `create(HWND body, rect, userDataFolder)` through `CreateCoreWebView2EnvironmentWithOptions(nullptr, L"<userData>\\webview2", nullptr, ...)` then `CreateCoreWebView2Controller(body, ...)`; `setRect(rect)` (`put_Bounds`; hidden with `put_IsVisible(FALSE)` when the pane is not in the active tab or is covered by a zoomed pane); `navigate(url)`; `back()`, `forward()`, `reload()`, `stop()`; `destroy()` with the controller closed and the environment released when the last pane goes. Events: `NavigationStarting` cancels any URI whose scheme is not `http` or `https` (for a PDF pane the one allowed `file:///` URI is its own file); `NewWindowRequested` sets `Handled` and sends the URI out through `open:externalHttp`'s rule (http and https only, else dropped); `SourceChanged`, `DocumentTitleChanged`, `HistoryChanged` and `NavigationCompleted` (success, or `WebErrorStatus` to text) → `view:event webNavigated | webLoading | webFailed`. `-3`-style aborts (`COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED`) are not errors. Settings: `AreDevToolsEnabled` only when `SEASHELL_CDP_PORT` is set, `IsStatusBarEnabled` false, `AreDefaultContextMenusEnabled` true, `IsZoomControlEnabled` false. The user data folder is `<userData>\webview2` (the `persist:seashell-preview` partition's native form). A PDF pane navigates to `file:///C:/...` (the shell's path conversion) and gets `Reveal` and `Open` in its toolbar, no URL bar.
- Produces the URL bar view (`Ui::viewWebBar`): 28 DIP under the title: `‹` `›` `⟳`/`✕` as `win7Button`s, the URL edit widget with the placeholder `localhost:3000`, `↗`; the empty state text centred in the pane when `empty`; the `Could not load - <desc>` banner in `danger` under the bar when `error`.
- Produces driver command `web { paneId }` → `{ url, title, loading, canBack, canForward, procs }` (`procs` from `ICoreWebView2Environment8::GetProcessInfos`, or the count of `msedgewebview2.exe` children).

- [ ] **Step 1: Failing controller test**

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { normalizeUrl } from '../../src/core/controller/web.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const views = (f: ReturnType<typeof fakeDeps>) => f.shellOut.filter(([ch]) => ch === 'view:cmd').map(([, p]) => p as { op: string; url?: string })

describe('web pane', () => {
  it('normalizes dev-server forms and refuses other schemes', () => {
    expect(normalizeUrl(':3000')).toBe('http://localhost:3000/')
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
  })
  it('opens empty, navigates on Enter, labels by host:port, and toasts a bad address', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('preview.web')
    const pane = c.model().panes.find((p) => p.kind === 'web')!
    expect(pane.web).toMatchObject({ empty: true, url: '', loading: false })
    c.event({ type: 'text', target: `pane:${pane.id}:url`, text: ':3000' })
    c.event({ type: 'key', target: `pane:${pane.id}:url`, key: 'Enter', mods })
    expect(views(f).at(-1)).toEqual({ paneId: pane.id, op: 'web', url: 'http://localhost:3000/' })
    c.view({ type: 'webLoading', paneId: pane.id, loading: true })
    expect(c.model().panes.find((p) => p.id === pane.id)!.web!.loading).toBe(true)
    c.view({ type: 'webNavigated', paneId: pane.id, url: 'http://localhost:3000/app', title: 'App' })
    const after = c.model().panes.find((p) => p.id === pane.id)!
    expect(after.label).toBe('localhost:3000')
    expect(after.web).toMatchObject({ url: 'http://localhost:3000/app', empty: false })
    c.event({ type: 'text', target: `pane:${pane.id}:url`, text: 'ftp://x' })
    c.event({ type: 'key', target: `pane:${pane.id}:url`, key: 'Enter', mods })
    expect(c.model().toast).toBe('Enter an http:// or https:// address')
    c.view({ type: 'webFailed', paneId: pane.id, code: 12007, description: 'ERR_NAME_NOT_RESOLVED' })
    expect(c.model().panes.find((p) => p.id === pane.id)!.web!.error).toBe('Could not load - ERR_NAME_NOT_RESOLVED')
  })
  it('find in a web pane toasts and the pane counts toward the six', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/w', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('preview.web')
    c.command('edit.find')
    expect(c.model().toast).toBe('Find is not available in a web preview')
    for (let i = 0; i < 5; i++) c.command('preview.web')
    expect(c.model().panes).toHaveLength(6)
    expect(c.model().toast).toMatch(/^Tab is full \(6 panes\)/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/unit/controller-web.test.ts --project unit`
Expected: FAIL, `web.js` missing.

- [ ] **Step 3: Implement**

Controller per Interfaces (`web.ts` holds `normalizeUrl` and the `WebViewModel` builder). Shell per Interfaces: `vcpkg install` through the manifest on the next `build-shell.cmd` run; if the port's CMake target name differs from the one written here, use what `vcpkg` prints and record it. The `WebPane`'s rect follows the pane's `gridRect` each model; `put_IsVisible(FALSE)` when the pane is not visible (inactive tab or zoomed elsewhere). Then the driver checks, which are Review Focus 4:

Rebuild. Scratch `h10`. Serve something local from a pane: `text "cd /tmp && python3 -m http.server 8765 >/dev/null 2>&1 &"`, Enter (the pane's own child; the scratch quit ends it). `key Ctrl+Alt+U`; `wait /panes/1/web/empty true`; `shot` to `bakeoff\P2-web-empty.png` Expected: the URL bar with the placeholder and the two-line empty state. `click pane:<id>:url`; `text ":8765"`; `key Enter`; `wait /panes/1/web/loading false` (timeout 15 s); `web` Expected: `url` `http://localhost:8765/`, `title` `Directory listing for /`, `procs` at least 1; `shot` to `bakeoff\P2-web.png` Expected: Edge's directory listing inside the pane, the label `localhost:8765`. Guards: `click pane:<id>:url`, `text "javascript:alert(1)"`, Enter Expected: the toast, no navigation (the `web` url unchanged). From the pane: `text "printf '<a target=_blank href=https://example.com>x</a><a href=file:///C:/Windows/win.ini>y</a>' > /tmp/g.html"`, Enter; navigate the web pane to `:8765/g.html`; `webClick { paneId, selector: 'a' }` (add this driver command: `ExecuteScript("document.querySelector(sel).click()")`) Expected: `shell.log` shows `open:externalHttp https://example.com/` (in test mode logged, not executed) and the pane's `web.url` unchanged; `webClick` on the second link Expected: `shell.log` `NavigationStarting cancelled file:///C:/Windows/win.ini`, the pane still answering `web`. `key Ctrl+Shift+F` Expected: toast `Find is not available in a web preview`. Close the pane: `click pane:<id>:close`; `web` Expected: `ENOPANE`; `stats` Expected: no `msedgewebview2.exe` under the shell's tree after 3 s. PDF: `text "echo /mnt/c/Windows/Help/en-US/credits.rtf"` is not a PDF; find one with `text "ls /mnt/c/Program\\ Files/Microsoft\\ Office 2>/dev/null | head -1"` or make one: `text "python3 -c \"print('%PDF-1.4\\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\\ntrailer<</Root 1 0 R>>')\" > /tmp/p2.pdf && echo /tmp/p2.pdf"`, Enter, Ctrl double-click Expected: a pane with the `file` badge, `file.kind pdf`, Edge's PDF viewer inside (`shot` to `bakeoff\P2-pdf.png`), `Reveal` and `Open`, no URL bar.

- [ ] **Step 4: Run the tests and commit**

Run: `npx vitest run test/unit/controller-web.test.ts test/unit/controller*.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

```bash
git add native/shell/vcpkg.json native/shell/CMakeLists.txt native/shell/src/ui/webview.h native/shell/src/ui/webview.cpp native/shell/src/model.h native/shell/src/app.cpp native/shell/src/ui/ui.cpp native/shell/src/driver.cpp src/core/controller/web.ts src/core/controller/model.ts src/core/controller/controller.ts test/unit/controller-web.test.ts
git commit -m "Host web and PDF panes in WebView2 with the navigation guards"
```

---

### Task 11: The path matrix and the Stage H gate

**Files:**
- Create: `scripts/native-matrix.mjs` (the four rows through the driver, one line each)
- Modify: `src/core/controller/controller.ts` (a `:line` suffix on a Ctrl double-click scrolls the preview to that line: the tokenizer already splits it; pass `line` to `openFile(path, { line })` and send `view:cmd text` with `scrollToLine`), `src/core/controller/model.ts` (`ViewCmd text` gains `scrollToLine?: number`), `native/shell/src/ui/fileview.cpp` (honour it)

**Interfaces:**
- Consumes: everything in Tasks 7 to 10; the redesign spec section 7 table.
- Produces: the gate lines `matrix: row <n>: ok|fail <detail>` for:
  1. `/Users/joshwald/seashell-wt/redesign/README.md` printed by `echo`: double-click → the explorer row `row:/Users/joshwald/seashell-wt/redesign/README.md` selected (the native form of the `data-path` check); Ctrl double-click → a file pane labelled `README.md` with `file.state ready`.
  2. `/mnt/c/seashell-build/redesign/bakeoff/results.jsonl`: double-click → `row:/mnt/c/seashell-build/redesign/bakeoff/results.jsonl` selected (the explorer root is home, so this path is outside it: the expected result is the toast `/mnt/c/seashell-build/redesign/bakeoff/results.jsonl is outside the file explorer`, exactly as the renderer behaves; the row reads `outside root, toasted` and counts as ok); Ctrl double-click → a file pane (JSON Lines highlighted as `json`).
  3. `src/main/index.ts:45` printed with the pane cwd at the worktree: double-click → `row:/Users/joshwald/seashell-wt/redesign/src/main/index.ts` selected; Ctrl double-click → a file pane with `fileText.scrollLine` within 20 of 45 (line 45 visible).
  4. `'/tmp/p2 dir/with space.txt:12'` (a quoted path with a space and a line suffix, created by the script): double-click → revealed (or `outside root` toasted, since `/tmp` is outside home; the row says which); Ctrl double-click → a file pane labelled `with space.txt` scrolled to line 12.

- [ ] **Step 1: Implement and run the matrix**

Rebuild. `node scripts/native-matrix.mjs` launches scratch `h11`, prints the four lines and `shot`s `bakeoff\P2-matrix-<n>.png` after each Ctrl row, quits the scratch, and exits non-zero on any `fail`.

- [ ] **Step 2: Stage H gate, snapshot, report**

`npm run typecheck && npm test` green; `run-native-gates.ps1` all ok (the restore round trip now includes a file pane: seed the W10 session with one `file` pane pointing at `/Users/joshwald/seashell-wt/redesign/README.md` and one `web` pane with `url: ''`, so restore re-creates both kinds; `make-session.mjs` gains the two panes); the matrix green; the W10 row measured with the file pane open and no web pane (`run-native-w10.ps1`), reported against the bar; a second row with one web pane at `:8765` reported, not compared. Append "Stage H" to the report (PNG paths, the matrix lines, the WebView2 process count and its working set, decisions). Then:

```bash
git add scripts/native-matrix.mjs scripts/bakeoff/make-session.mjs src/core/controller/controller.ts src/core/controller/model.ts native/shell/src/ui/fileview.cpp
git commit -m "Prove the path matrix on the native build"
git branch -f snapshot/native-after-previews
```

---
## Stage I: sheets, popovers, the menu, drops (Tasks 12 to 17)

### Task 12: Sheets, and the Settings sheet

**Files:**
- Create: `src/core/controller/sheets.ts`, `test/unit/controller-settings.test.ts`, `native/shell/src/ui/sheet.h`, `native/shell/src/ui/sheet.cpp`, `native/shell/src/ui/settings.cpp`
- Modify: `src/core/controller/model.ts` (`SheetModel`), `src/core/controller/controller.ts` (`app.settings`, the settings actions, the accent and palette application, `Escape` closes, `settings` button), `src/core/controller/colorization.ts` (accent override on the token table), `native/shell/src/model.h`, `native/shell/src/ui/ui.h`, `native/shell/src/ui/ui.cpp`, `native/shell/src/app.cpp` (`window.palette` to the grids)

**Interfaces:**
- Consumes: `Settings`, `DEFAULT_SETTINGS`, `coerceSettings` (`settings/settings.ts`); `THEME_ORDER`, `THEMES[k].name` and the per-theme note, `ACCENTS`, `PALETTE_ORDER`, `PALETTE_LABELS`, `PALETTES`, `PANE_STYLE_ORDER`, `CRT` (`theme/tokens.ts`, pure); the accent rule in `theme/apply.ts:84-91` (`--accent`, `--select`, `--primaryBg`, `--primaryBorder` and the tab mark take the chosen hex; `readableOn(accent)` picks the text colour by luminance; the function is copied into `colorization.ts` with the comment, since `apply.ts` touches `document`); `ACCENTS` keys are hex strings (`#0a84ff`), so the option id is the hex without `#`, and `default` is `Theme default`; `UiState.settings`; `GridView::setPalette(TermPalette)` (Phase 1).
- Produces in `model.ts`:

```ts
export interface SheetField { id: string; kind: 'buttons' | 'check' | 'text' | 'button' | 'note'; label: string; value?: string | boolean; options?: Array<{ id: string; label: string; selected: boolean; disabled: boolean; tooltip: string | null; swatch: string | null }>; placeholder?: string; maxLen?: number; note?: string }
export interface SheetSection { title: string; fields: SheetField[] }
export interface SheetModel { kind: 'settings' | 'projects' | 'tutorial'; title: string; width: number; sections: SheetSection[]; buttons: Array<{ id: string; label: string; isDefault: boolean; disabled: boolean }>; focusField: string | null }
```

  `UiModel` gains `sheet: SheetModel | null` and `window.palette: Record<string, string> | null` (the terminal palette override, `PALETTES[key]`, null for `native`). Target ids: `sheet:<kind>:<fieldId>` for a check or text field, `sheet:<kind>:<fieldId>:<optionId>` for a buttons option, `sheet:<kind>:btn:<id>` for a bottom button, `sheet:close`. `Escape` as `key sheet:<kind> Escape` closes. Only one sheet at a time; a sheet dims the window like the restore card and takes the keyboard.
- Produces the Settings sheet (`sheets.ts` `settingsSheet(settings, platform)`), from inventory P: section `Appearance`: `Theme` buttons from `THEME_ORDER` with `THEMES[k].name`, only `aero` enabled (selected, labelled `Current`), the others disabled with tooltip `coming back`; `Accent`: `Theme default` plus the six `ACCENTS` swatches; `Terminal palette`: `PALETTE_ORDER` with `PALETTE_LABELS`; `Pane frame`: `PANE_STYLE_ORDER`, all disabled, tooltip `coming back`; `CRT glass`: `Theme`, `On`, `Off`, all disabled, tooltip `coming back`. Section `Panes`: checks `attentionGlow` (`Glow when a pane wants attention`), `attentionSound` (`Ping when a pane starts asking`), `autoColorPanes` (`Colour new panes automatically`), `autoTitlePanes` (`Name panes from the running program`) with the labels the renderer's `SettingsPanel.tsx` uses (read them there and copy verbatim). Section `New panes`: text `newPaneCommand` (`Start new panes with`, max 200, control characters stripped). Section `Help`: button `tutorial` (`Show`). Bottom button `Done`.
- Produces in the controller: every change saves `UiState.settings` and emits; `accent` rewrites `tokens.accent`, `tokens.selection` and `tokens.accentText` over the colorization table (and `default` restores the table's own); `palette` sets `window.palette`; the `☾` toggle and the sheet's `attentionGlow` check are the same field.
- Produces `sheet.h`: `Ui::viewSheet(Painter&)`: the dim, a centred `toastBg` card with a 1 px `#a0a0a0` border and 6 DIP radius (6.3 cards), the title bold, sections with their titles in `badgeText`, `buttons` options as a row of `win7Button`s (pressed when selected, disabled greyed, a 10 DIP colour swatch when `swatch`), checks as 13 DIP Win7 check boxes (a `#8e8f8f` border, the check glyph), a text field through `EditWidget`, a `note` as plain text, the bottom button row right-aligned with the default button's glow ring; Tab and Shift+Tab move focus between fields; the sheet scrolls with the Task 5 scrollbar when taller than the body.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, target: string) => c.event({ type: 'click', target, x: 0, y: 0, button: 0, mods })

describe('settings sheet', () => {
  it('opens with Aero current and the other themes greyed with the tooltip', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.settings')
    const sheet = c.model().sheet!
    expect(sheet.kind).toBe('settings')
    const theme = sheet.sections[0].fields.find((x) => x.id === 'theme')!
    expect(theme.options!.filter((o) => !o.disabled).map((o) => o.id)).toEqual(['aero'])
    expect(theme.options!.find((o) => o.id === 'retro')).toMatchObject({ disabled: true, tooltip: 'coming back' })
  })
  it('accent and palette apply to the tokens and the model, and persist', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const before = c.model().tokens.accent
    c.command('app.settings')
    click(c, 'sheet:settings:accent:0a84ff')
    expect(c.model().tokens.accent).not.toBe(before)
    expect(c.model().tokens.accent).toBe('#0a84ff')
    expect(c.model().tokens.selection).toBe('#0a84ff')
    expect(c.model().tokens.accentText).toMatch(/^#(ffffff|1d0f22)$/i)
    click(c, 'sheet:settings:palette:solar')
    expect(c.model().window.palette).not.toBeNull()
    expect(c.uiState().settings).toMatchObject({ accent: '#0a84ff', palette: 'solar' })
    click(c, 'sheet:settings:accent:default')
    expect(c.model().tokens.accent).toBe(before)
  })
  it('the new-pane command strips control characters and caps at 200, and Escape closes', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.settings')
    c.event({ type: 'text', target: 'sheet:settings:newPaneCommand', text: 'cla\x07ude ' + 'x'.repeat(300) })
    expect(c.uiState().settings.newPaneCommand).toBe(('claude ' + 'x'.repeat(300)).slice(0, 200))
    c.event({ type: 'key', target: 'sheet:settings', key: 'Escape', mods })
    expect(c.model().sheet).toBeNull()
  })
})
```

  (`Controller.uiState()` is a small public getter added for the tests; `saveUi()` already writes the file.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/controller-settings.test.ts --project unit`
Expected: FAIL, `sheet` undefined.

- [ ] **Step 3: Implement the controller, then the shell**

Per Interfaces. The shell's `App` applies `window.palette` to every `GridView` when it changes (`TermPalette` from the 16 ANSI keys plus `foreground`, `background`, `cursor`, `selectionBackground`; unknown keys ignored).

- [ ] **Step 4: Tests, driver checks**

Run: `npx vitest run test/unit/controller-settings.test.ts test/unit/controller*.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

Rebuild. Scratch `i12`. `key Ctrl+,`; `wait /sheet/kind settings`; `shot` to `bakeoff\P2-settings.png` Expected by eye: the dimmed window, the card with the five Appearance rows (Aero pressed and labelled Current, the others greyed), the four check boxes, the text field, the Show button, Done with the glow ring. `click sheet:settings:palette:amber`, `shot` Expected: the pane's prompt in the amber palette. `click sheet:settings:palette:native`. `click sheet:settings:accent:e5533d` Expected: the active tab's accent line and the focused pane's border turn signal red (`tokens.accent` in `model` reads `#e5533d`). `click sheet:settings:btn:done` Expected: `sheet` null.

- [ ] **Step 5: Commit**

```bash
git add src/core/controller/sheets.ts src/core/controller/model.ts src/core/controller/controller.ts src/core/controller/colorization.ts test/unit/controller-settings.test.ts native/shell/src/ui/sheet.h native/shell/src/ui/sheet.cpp native/shell/src/ui/settings.cpp native/shell/src/model.h native/shell/src/ui/ui.h native/shell/src/ui/ui.cpp native/shell/src/app.cpp
git commit -m "Open the settings sheet with accent and palette live"
```

---

### Task 13: The Projects sheet

**Files:**
- Create: `src/core/controller/projects.ts`, `test/unit/controller-projects.test.ts`
- Modify: `src/core/controller/sheets.ts` (`projectsSheet(state)`), `src/core/controller/controller.ts` (`app.projects`, `app.saveProject`, `app.saveTab`, the sheet's events), `native/shell/src/ui/sheet.cpp` (a `rows` section kind: name, meta, inline buttons)

**Interfaces:**
- Consumes: `projects:list`, `projects:save { id?, name, tabs }`, `projects:delete { id }`, `projects:sessionIds`, `projects:resumeModes` (`src/shared/ipc.ts`); `serializeTabs`, `restoreTabs` and the rest of `src/renderer/projects/serialize.ts` as `app.tsx:486-749` uses them (`openProject` replaces the window and kills every live pane, `addProject` appends tabs, `saveProject` by scope, `deleteProject`); the store actions `tabs.replace`, `tabs.append`; the Phase 1 spawn and launch-command path (restored claude panes type `claude [flag] [-r <uuid>]`).
- Produces: the sheet from inventory N: section `Save` with scope buttons `Whole window` and `This tab`, the `Save "<current>"` button when a project is current and scope is window, the name text (max 60, Enter saves), the save button labelled `Save`, `Save as project` or `Overwrite` (a case-insensitive match on an existing name), and the description note `N tabs, M panes`; section `Open` with one row per project: name, meta `N tabs · M panes · saved <ago>`, buttons `Delete` (becomes inline `Delete` / `Cancel` confirm), `Add`, `Open`. Bottom button `Done`. Toasts `Opened`, `Added`, `Saved project`, `Saved tab as`, `Nothing to save`, `Could not save project (CODE)`. `app.saveProject` opens the sheet on window scope, `app.saveTab` on tab scope. `SheetField` gains `kind: 'rows'` with `rows: Array<{ id, name, meta, confirming }>` and the targets `sheet:projects:row:<id>:delete|confirm|cancel|add|open`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, t: string) => c.event({ type: 'click', target: t, x: 0, y: 0, button: 0, mods })
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup() {
  const f = fakeDeps()
  const projects: Array<{ id: string; name: string; savedAt: string; tabs: unknown[] }> = []
  f.handlers['projects:list'] = () => ({ projects })
  f.handlers['projects:save'] = (p) => { const r = p as { id?: string; name: string; tabs: unknown[] }; const proj = { id: r.id ?? `p${projects.length + 1}`, name: r.name, savedAt: new Date(1_700_000_000_000).toISOString(), tabs: r.tabs }; const i = projects.findIndex((x) => x.id === proj.id); if (i >= 0) projects[i] = proj; else projects.push(proj); return { ok: true, project: proj } }
  f.handlers['projects:delete'] = (p) => { const i = projects.findIndex((x) => x.id === (p as { id: string }).id); if (i >= 0) projects.splice(i, 1); return { ok: true } }
  f.handlers['projects:sessionIds'] = () => ({ ids: {}, sources: {} })
  f.handlers['projects:resumeModes'] = () => ({ modes: {}, bypassConsented: false })
  return { f, projects }
}

describe('projects sheet', () => {
  it('saves the window under a name, lists it, and Overwrite appears for the same name', async () => {
    const { f, projects } = setup()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('tab.new')
    c.command('app.saveProject'); await flush()
    expect(c.model().sheet?.kind).toBe('projects')
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'Work' })
    click(c, 'sheet:projects:save'); await flush()
    expect(projects.map((p) => p.name)).toEqual(['Work'])
    expect(c.model().toast).toBe('Saved project')
    const rows = c.model().sheet!.sections[1].fields[0].rows!
    expect(rows[0].meta).toMatch(/^2 tabs · 2 panes · saved /)
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'work' })
    expect(c.model().sheet!.sections[0].fields.find((x) => x.id === 'save')!.label).toBe('Overwrite')
  })
  it('Open replaces the window and kills live panes; Add appends; Delete asks inline', async () => {
    const { f, projects } = setup()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('app.saveProject'); await flush()
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'One' })
    click(c, 'sheet:projects:save'); await flush()
    const id = projects[0].id
    c.command('tab.new'); c.command('tab.new')
    click(c, `sheet:projects:row:${id}:open`); await flush(); await flush()
    expect(c.model().tabs).toHaveLength(1)
    expect(f.sent.filter(([ch]) => ch === 'pty:kill').length).toBeGreaterThanOrEqual(3)
    expect(c.model().toast).toBe('Opened')
    click(c, `sheet:projects:row:${id}:add`); await flush(); await flush()
    expect(c.model().tabs).toHaveLength(2)
    click(c, `sheet:projects:row:${id}:delete`)
    expect(c.model().sheet!.sections[1].fields[0].rows![0].confirming).toBe(true)
    click(c, `sheet:projects:row:${id}:cancel`)
    expect(projects).toHaveLength(1)
    click(c, `sheet:projects:row:${id}:delete`); click(c, `sheet:projects:row:${id}:confirm`); await flush()
    expect(projects).toHaveLength(0)
  })
  it('tab scope saves only the active tab and toasts Saved tab as', async () => {
    const { f, projects } = setup()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('tab.new')
    c.command('app.saveTab'); await flush()
    c.event({ type: 'text', target: 'sheet:projects:name', text: 'Just this' })
    c.event({ type: 'key', target: 'sheet:projects:name', key: 'Enter', mods }); await flush()
    expect(projects[0].tabs).toHaveLength(1)
    expect(c.model().toast).toBe('Saved tab as')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/controller-projects.test.ts --project unit`
Expected: FAIL.

- [ ] **Step 3: Implement**

`projects.ts` ports `app.tsx:486-749` and `803-810` (read them; keep the names `openProject`, `addProject`, `saveProject`, `deleteProject`, `currentProject`) over the controller's deps. The sheet rebuilds from state on every change. The shell's `rows` field kind draws each row as name bold, meta in `badgeText`, the three buttons right-aligned (`Delete` swaps to `Delete` in `danger` and `Cancel` while confirming).

- [ ] **Step 4: Tests, driver checks, commit**

Run: `npx vitest run test/unit/controller-projects.test.ts test/unit/controller*.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

Rebuild. Scratch `i13` with the W10 session restored. `key Ctrl+Alt+P`; `wait /sheet/kind projects`; `text "W10"`; `key Enter`; `wait /toast "Saved project"`; `shot` to `bakeoff\P2-projects.png` Expected by eye: the Save section with `Whole window` pressed, the Open section with one row `W10`, `9 tabs · 10 panes · saved just now`, the three buttons. `click sheet:projects:row:<id>:open` Expected: the window rebuilt with 9 tabs (a `wait /tabs/8/id`), the toast `Opened`; `projects.json` in the scratch userData holds one project with `schemaVersion`-compatible tabs (open it and check the `SavedTab` keys).

```bash
git add src/core/controller/projects.ts src/core/controller/sheets.ts src/core/controller/controller.ts test/unit/controller-projects.test.ts native/shell/src/ui/sheet.cpp
git commit -m "Save, open, add and delete projects from the sheet"
```

---

### Task 14: The tutorial and the update banner

**Files:**
- Create: `src/core/controller/tutorial-steps.ts`, `test/unit/controller-tutorial.test.ts`, `test/unit/controller-update.test.ts`
- Modify: `src/core/controller/sheets.ts` (`tutorialSheet`), `src/core/controller/controller.ts` (`help.tutorial`, first-run, the keys; `update:state` push, the banner, `update:download`, `update:install`, `dismissedUpdate`), `src/core/controller/model.ts` (`UpdateBannerModel`), `src/main/platform/wslhost.ts` (`updater: 'off'`, read by `src/main/index.ts` where the updater starts: no check on this platform in Phase 2), `src/core/index.ts` (a `test:update` envelope in test mode becomes an `update:state` push), `native/shell/src/model.h`, `native/shell/src/ui/overlays.cpp` (the banner strip above the status bar), `native/shell/src/ui/sheet.cpp` (the tutorial layout: dots, key tables), `native/shell/src/driver.cpp` (`coreSend { ch, p }` writes a `send` envelope to the core; test mode only)

**Interfaces:**
- Consumes: the 12 steps in `src/renderer/tutorial/Tutorial.tsx:63-233` (`buildSteps(platform)`: title, body paragraphs, key rows; copied into `tutorial-steps.ts` as `export function STEPS(platform: string): TutorialStep[]` with `interface TutorialStep { title: string; body: string[]; keys: Array<[chord: string, action: string]> }`, the source comment, and the chords spelled through `src/shared/keys.ts` for the platform); `UiState.tutorialSeen`, `UiState.dismissedUpdate`; the `UpdateState` union (`src/shared/ipc.ts`: `idle`, `available { version, pageUrl, canInstall }`, `downloading { version, received, total }`, `ready { version }`, `error { version, message }`); `update:download` and `update:install` sends; `open:externalHttp` for the release page.
- Produces: the tutorial as a `SheetModel` of kind `tutorial` with one section per step shown (title, body `note`s, a `keys` table as a `rows` field with `name` the chord and `meta` the action), the dots as a `buttons` field `step` (12 options, the current selected), the check `dontShow` (`Don't show this again`, default checked), bottom buttons `Skip`, `Back` (disabled on the first), `Next` (`Get started` on the last, default). Keys as `key sheet:tutorial <k>`: `Escape` closes, `ArrowLeft` back, `ArrowRight` next (the sheet owns the keyboard, so the terminal never sees them). Closing with `dontShow` checked sets `tutorialSeen`. Shown on first run after boot when `!tutorialSeen` and no restore card is up (and after the card is answered when one was), and from `help.tutorial` (Ctrl+Shift+/) or the Settings `Show` button.
- Produces in `model.ts`: `export interface UpdateBannerModel { phase: 'available' | 'downloading' | 'ready' | 'error'; text: string; buttons: Array<{ id: 'download' | 'page' | 'later' | 'install' | 'retry' | 'dismiss'; label: string }>; progress: number | null }`; `UiModel` gains `update: UpdateBannerModel | null`; the body layout leaves 28 DIP above the status bar for it while it shows (`layout.ts`). Texts: `SeaShell <v> is available.` with `Download` when `canInstall` else `Release page`, plus `Later`; `Downloading <v>: <N>%` (or `<N> MB` without a total); `Install and Relaunch` plus `Later` when `ready`; the error's message with `Try again` and `Dismiss`. `Later` stores the version in `dismissedUpdate`; a dismissed error lasts the session. `wslhost` sets `updater: 'off'` and `index.ts` skips the periodic check when the platform says so (one line where the updater starts; a unit test on the platform object).
- Produces driver command `coreSend { ch, p }` (test mode): the shell writes `{ k: 'send', ch, p }` to the core. `index.ts` maps `test:update` to a `update:state` push only when `SEASHELL_TEST_PORT` was in the shell's environment (the shell passes `SEASHELL_TEST_MODE=1` in the core's env).

- [ ] **Step 1: Failing tests**

`test/unit/controller-tutorial.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { STEPS } from '../../src/core/controller/tutorial-steps.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const key = (c: Controller, k: string) => c.event({ type: 'key', target: 'sheet:tutorial', key: k, mods })

describe('tutorial', () => {
  it('has twelve steps with Windows spellings and shows on first run only', async () => {
    expect(STEPS('win32')).toHaveLength(12)
    expect(JSON.stringify(STEPS('win32'))).toContain('Ctrl+Shift+D')
    expect(JSON.stringify(STEPS('win32'))).not.toContain('Cmd+')
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    expect(c.model().sheet?.kind).toBe('tutorial')
    key(c, 'ArrowRight'); key(c, 'ArrowRight')
    expect(c.model().sheet!.sections[0].title).toBe(STEPS('win32')[2].title)
    key(c, 'ArrowLeft')
    expect(c.model().sheet!.sections[0].title).toBe(STEPS('win32')[1].title)
    key(c, 'Escape')
    expect(c.model().sheet).toBeNull()
    expect(c.uiState().tutorialSeen).toBe(true)
    const c2 = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c2.boot(GEO)
    expect(c2.model().sheet).toBeNull()   // ui-state.json in the shared temp userData says seen
  })
})
```

  The test's `fakeDeps()` must point `app:getPaths` at a real temp directory so `ui-state.json` round trips: at the top of the file, `const ud = mkdtempSync(join(tmpdir(), 'ss-tut-'))` and `f.handlers['app:getPaths'] = () => ({ home: '/h', hostname: 'jarvis', userData: ud, defaultShell: '/usr/bin/zsh', cwdOfLaunch: '/h', platform: 'win32', host: 'native' })` before each `boot` (the Phase 1 controller loads `UiState` from `<userData>/ui-state.json` at boot and `saveUi()` writes it there).

`test/unit/controller-update.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, t: string) => c.event({ type: 'click', target: t, x: 0, y: 0, button: 0, mods })

describe('update banner', () => {
  it('shows available, downloads, shows progress and ready, and Later remembers the version', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.push('update:state', { phase: 'available', version: '0.6.0', pageUrl: 'https://x/r', canInstall: true })
    expect(c.model().update).toMatchObject({ phase: 'available', text: 'SeaShell 0.6.0 is available.' })
    expect(c.model().update!.buttons.map((b) => b.id)).toEqual(['download', 'later'])
    click(c, 'update:download')
    expect(f.sent.some(([ch]) => ch === 'update:download')).toBe(true)
    c.push('update:state', { phase: 'downloading', version: '0.6.0', received: 50, total: 200 })
    expect(c.model().update).toMatchObject({ text: 'Downloading 0.6.0: 25%', progress: 0.25 })
    c.push('update:state', { phase: 'ready', version: '0.6.0' })
    expect(c.model().update!.buttons.map((b) => b.id)).toEqual(['install', 'later'])
    click(c, 'update:later')
    expect(c.model().update).toBeNull()
    expect(c.uiState().dismissedUpdate).toBe('0.6.0')
    c.push('update:state', { phase: 'available', version: '0.6.0', pageUrl: 'https://x/r', canInstall: true })
    expect(c.model().update).toBeNull()
    c.push('update:state', { phase: 'available', version: '0.7.0', pageUrl: 'https://x/r', canInstall: false })
    expect(c.model().update!.buttons.map((b) => b.id)).toEqual(['page', 'later'])
  })
  it('an error offers Try again and Dismiss, and Dismiss lasts the session', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.push('update:state', { phase: 'error', version: '0.6.0', message: 'checksum' })
    expect(c.model().update!.buttons.map((b) => b.id)).toEqual(['retry', 'dismiss'])
    click(c, 'update:dismiss')
    expect(c.model().update).toBeNull()
    expect(c.uiState().dismissedUpdate).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/controller-tutorial.test.ts test/unit/controller-update.test.ts --project unit`
Expected: FAIL.

- [ ] **Step 3: Implement**

Per Interfaces. The banner view in `overlays.cpp`: a 28 DIP strip above the status bar on `toastBg` with a 1 px `#a0a0a0` top line, the text left, the buttons right as `win7Button`s, a thin accent progress bar along the bottom when `progress` is set.

- [ ] **Step 4: Tests, driver checks, commit**

Run: `npx vitest run test/unit/controller-tutorial.test.ts test/unit/controller-update.test.ts test/unit/controller*.test.ts test/unit/platform*.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

Rebuild. Scratch `i14` with a fresh userData: `wait /sheet/kind tutorial`; `shot` to `bakeoff\P2-tutorial.png` Expected by eye: the card with `Welcome to SeaShell`, the twelve dots, `Skip`, `Back` greyed, `Next` with the ring, the checkbox checked. `key ArrowRight` three times, `shot` to `bakeoff\P2-tutorial-4.png` Expected: `Double-click a path to find it` with its key table in Windows spelling. `key Escape`; `quit`; relaunch the same scratch Expected: no tutorial. `coreSend { ch: 'test:update', p: { phase: 'available', version: '9.9.9', pageUrl: 'https://github.com/voidharbor/seashell/releases', canInstall: false } }`; `wait /update/phase available`; `shot` to `bakeoff\P2-update.png` Expected: the strip above the status bar reading `SeaShell 9.9.9 is available.` with `Release page` and `Later`, the panes 28 DIP shorter. `click update:later` Expected: gone; `ui-state.json` has `"dismissedUpdate": "9.9.9"`.

```bash
git add src/core/controller/tutorial-steps.ts src/core/controller/sheets.ts src/core/controller/controller.ts src/core/controller/model.ts src/core/controller/layout.ts src/main/platform/wslhost.ts src/main/index.ts src/core/index.ts test/unit/controller-tutorial.test.ts test/unit/controller-update.test.ts native/shell/src/model.h native/shell/src/ui/overlays.cpp native/shell/src/ui/sheet.cpp native/shell/src/driver.cpp
git commit -m "Show the tutorial and the update banner from the model"
```

---

### Task 15: Pane colour, links, and the attention ping

**Files:**
- Create: `test/unit/controller-pickers.test.ts`, `native/shell/src/audio.h`, `native/shell/src/audio.cpp`
- Modify: `src/core/protocol.ts` (`CORE_PUSH_TO_SHELL` adds `shell:cmd`), `test/unit/core-protocol.test.ts`, `native/shell/src/wire.cpp`, `src/core/controller/model.ts` (`PopoverModel`, `ShellCmd`), `src/core/controller/controller.ts` (the two pickers, link flow, the ping decision), `native/shell/src/model.h`, `native/shell/src/ui/ui.cpp` (popovers through `Popup`, the pane border and accent stripe in the tag colour exist from Phase 1), `native/shell/src/app.cpp` (`shell:cmd ping`), `native/shell/CMakeLists.txt` (link `xaudio2`)

**Interfaces:**
- Consumes: `PANE_COLORS` (7 keys with hex and label), `paneColorHex`, `isPaneColorKey`, `nextAutoColor`, `FIRST_PANE_COLOR` (`panes/colors.ts`); store actions `pane.setColor`, `pane.link`, `pane.unlink`; `links:ensure { linkId }` → `{ path | null }`; `linkBriefing(notesPath)`, `canBrief(foregroundProcess)`, `newLinkId(mint)` (`panes/link.ts`); `app.tsx:766-801` (the link flow: ensure, then type `\x15`, the briefing sentence and `\r` into both panes; toasts `Panes are sharing notes` and `Both panes need to be running an agent to link`); the attention transitions in `panes/attention.ts` and `store.ts:726-785` (Phase 1 drives `attention`); `ping.ts:56-98` (two sine tones, 880 Hz then 587.33 Hz, 90 ms apart, the exponential gain envelopes; copy the durations and the envelope constants into `audio.cpp` with the source comment).
- Produces in `model.ts`:

```ts
export interface PopoverModel { kind: 'color' | 'link'; paneId: string; anchor: Rect; items: Array<{ id: string; label: string; swatch: string | null; selected: boolean; disabled: boolean; note: string | null }> }
export type ShellCmd = { op: 'ping' } | { op: 'menu'; items: MenuItemModel[] }   // Task 16 adds the menu
```

  `UiModel` gains `popover: PopoverModel | null`. Targets: `pane:<id>:color` opens the colour popover anchored at the dot (`items`: the seven swatches plus `No colour`; the current one `selected`; picking the current clears); `pane:<id>:link` opens the link popover `Share notes with` (one item per other term pane in the tab, `label` `<index> <label>`, `disabled` with `note: 'no agent'` when `!canBrief(foreground)` of either side, `note: 'linked'` when already linked, plus `Stop sharing` when this pane is linked); `popover:<id>` click picks, where `<id>` is the colour key (`red`, `amber`, `green`, `cyan`, `blue`, `purple`, `pink`) or `none` for the colour popover, and the other pane's id or `unlink` for the link popover; `Escape` (`key popover Escape`) and any `down` outside close it.
- Produces `audio.h`: `class Audio { static bool init(); static void ping(); }`: XAudio2 (`XAudio2Create`, a mastering voice, one source voice), the buffer rendered once at 48 kHz mono float from the `ping.ts` constants; `ping()` submits it; failures log once and go silent. The core sends `shell:cmd { op: 'ping' }` on the transition into `waiting` or `done` when `settings.attentionGlow && settings.attentionSound` and at least 1800 ms since the last ping.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

const mods = { ctrl: false, alt: false, shift: false }
const click = (c: Controller, t: string) => c.event({ type: 'click', target: t, x: 0, y: 0, button: 0, mods })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('pickers and the ping', () => {
  it('the colour popover tags a pane, and picking the same colour clears it', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0].id
    click(c, `pane:${id}:color`)
    expect(c.model().popover).toMatchObject({ kind: 'color', paneId: id })
    expect(c.model().popover!.items).toHaveLength(8)
    click(c, 'popover:blue')
    expect(c.model().popover).toBeNull()
    expect(c.model().panes[0].color).toMatch(/^#/)
    click(c, `pane:${id}:color`); click(c, 'popover:blue')
    expect(c.model().panes[0].color).toBeNull()
  })
  it('linking two agent panes ensures the notes file and briefs both; a non-agent pane is disabled', async () => {
    const f = fakeDeps()
    f.handlers['links:ensure'] = () => ({ path: '/mnt/c/ud/links/abc.md' })
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const [a, b] = c.model().panes.map((p) => p.id)
    c.push('metrics:tick', { panes: [{ paneId: a, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'claude', procCount: 1, cwd: '/h' }, { paneId: b, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'zsh', procCount: 1, cwd: '/h' }], system: null })
    click(c, `pane:${a}:link`)
    expect(c.model().popover!.items[0]).toMatchObject({ disabled: true, note: 'no agent' })
    c.push('metrics:tick', { panes: [{ paneId: a, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'claude', procCount: 1, cwd: '/h' }, { paneId: b, footprintBytes: 0, cpuFrac: 0, state: 'PROMPT', foregroundProcess: 'claude', procCount: 1, cwd: '/h' }], system: null })
    click(c, `pane:${a}:link`); click(c, `popover:${b}`); await flush()
    const writes = f.sent.filter(([ch]) => ch === 'pty:write').map(([, p]) => p as { paneId: string; data: string })
    expect(writes.filter((w) => w.data.startsWith('\x15') && w.data.endsWith('\r') && w.data.includes('abc.md')).map((w) => w.paneId).sort()).toEqual([a, b].sort())
    expect(c.model().toast).toBe('Panes are sharing notes')
    expect(c.model().panes.every((p) => p.linked)).toBe(true)
    click(c, `pane:${a}:link`)
    expect(c.model().popover!.items.at(-1)!.id).toBe('unlink')
  })
  it('pings once per 1.8 s on the way into attention, only with glow and sound on', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const unfocused = c.model().panes.find((p) => !p.focused)!.id
    const pings = () => f.shellOut.filter(([ch, p]) => ch === 'shell:cmd' && (p as { op: string }).op === 'ping').length
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(0)   // sound is off by default
    const focused = c.model().panes.find((p) => p.focused)!.id
    const focus = (id: string) => c.event({ type: 'down', target: `pane:${id}:grid`, x: 0, y: 0, button: 0, mods })
    c.command('app.settings'); click(c, 'sheet:settings:attentionSound'); c.event({ type: 'key', target: 'sheet:settings', key: 'Escape', mods })
    focus(unfocused); focus(focused)   // clears the first bell's attention
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(1)
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(1)
    f.advance(2000)
    focus(unfocused); focus(focused)
    c.term({ type: 'bell', paneId: unfocused })
    expect(pings()).toBe(2)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/controller-pickers.test.ts --project unit`
Expected: FAIL.

- [ ] **Step 3: Implement**

Per Interfaces. The popovers draw through `Popup` (Task 5) with swatches (a 12 DIP square) and the `note` right-aligned in `badgeText`. `shell:cmd` is routed by `Wire` to `App::onShellCmd`.

- [ ] **Step 4: Tests, driver checks, commit**

Run: `npx vitest run test/unit/controller-pickers.test.ts test/unit/core-protocol.test.ts test/unit/controller*.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

Rebuild. Scratch `i15` with two panes. `click pane:<a>:color`; `shot` to `bakeoff\P2-color.png` Expected by eye: the popover with seven swatches and `No colour` under the dot. `click popover:purple` Expected: the pane's border and the title stripe purple. `click pane:<a>:link`; `shot` to `bakeoff\P2-link.png` Expected: `Share notes with`, the other pane listed greyed `no agent`. The ping: `confirm`-free: set `attentionSound` through the sheet, then from pane b `text "sleep 1; printf '\\a'"`, Enter and focus pane a before the second passes (`click pane:<a>:grid`) Expected: `shell.log` has `audio: ping` once (the sound plays through the default device; Josh may hear it once; the gate runs it once only) and pane b's border breathes amber.

```bash
git add src/core/protocol.ts test/unit/core-protocol.test.ts native/shell/src/wire.cpp src/core/controller/model.ts src/core/controller/controller.ts test/unit/controller-pickers.test.ts native/shell/src/audio.h native/shell/src/audio.cpp native/shell/src/model.h native/shell/src/ui/ui.cpp native/shell/src/app.cpp native/shell/CMakeLists.txt
git commit -m "Add the colour and link pickers and the attention ping"
```

---

### Task 16: The menu, Alt, and the tab strip overflow

**Files:**
- Create: `test/unit/core-menu.test.ts`, `native/shell/src/ui/menu.h`, `native/shell/src/ui/menu.cpp`
- Modify: `src/core/electron-shim.ts` (`Menu.setApplicationMenu` serializes the template to `shell:cmd { op: 'menu' }`; `menu:click { path }` from the shell runs the item's `click`), `src/core/index.ts` (route `menu:click` to the shim), `src/core/controller/model.ts` (`MenuItemModel`), `native/shell/src/model.h`, `native/shell/src/ui/ui.cpp` (`menu` target pops it; the strip scroll), `native/shell/src/ui/tabs.cpp` (overflow), `native/shell/src/window.cpp` (the Alt tap: `WM_SYSKEYUP` for `VK_MENU` with no other key pressed since `WM_SYSKEYDOWN`), `native/shell/src/driver.cpp` (`menu` → the items; `menuPick { path }`)

**Interfaces:**
- Consumes: `buildMenu(getWindow, platform)` in `src/main/menu.ts` (unchanged; it runs in the core against the shim), `MenuShim` (`buildFromTemplate`, `setApplicationMenu`), `test/unit/keys.test.ts` (keeps passing because the template is unchanged).
- Produces: `MenuItemModel = { label: string; accelerator: string | null; role: string | null; type: 'normal' | 'separator' | 'submenu'; enabled: boolean; path: number[]; submenu: MenuItemModel[] | null }`; the shim pushes `shell:cmd { op: 'menu', items }` whenever `setApplicationMenu` runs (once at boot) and answers `menu:click { path }` by calling the template item's `click()` (which sends `ui:command` as today) or, for `role: 'quit'`, `app.quit()`. The shell builds an `HMENU` tree from the items (accelerators as the `\t` right text; roles `about` → a `MessageBox` `SeaShell <version>`; `quit` → `menu:click`; `togglefullscreen` → toggle maximize; `toggleDevTools` and the Mac roles omitted; `windowMenu`/`help` are plain submenus), pops it with `TrackPopupMenuEx(TPM_RETURNCMD)` under the `≡` button or at the pointer, and sends `menu:click { path }` for the picked item. An Alt tap (down and up with no other key between, no edit widget or sheet focused) pops the menu the same way; `Alt+<key>` is untouched (Review Focus 5). The driver's `menu` returns the items as built; `menuPick { path }` acts as a pick without showing anything.
- Produces the strip overflow (`tabs.cpp`): when the tabs' total width exceeds the strip's tab area, the strip scrolls (`stripScroll_` in device pixels), `◂` and `▸` buttons appear at the ends (`strip:left`, `strip:right`, repeat on hold), the wheel over the strip scrolls it, and a model whose active tab changed scrolls that tab into view. The `+`, `◍`, badge, `☾`, `⚙` and the caption area stay fixed.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { createShim } from '../../src/core/electron-shim.js'

describe('menu over the wire', () => {
  it('serializes the template with paths and runs a click by path', async () => {
    const lines: string[] = []
    const pushes: Array<[string, unknown]> = []
    const shim = createShim({ write: (l) => lines.push(l), hostPid: 1, userData: '/tmp/ud', version: '0', onPush: (ch, p) => pushes.push([ch, p]) })
    let clicked = 0
    const menu = shim.Menu.buildFromTemplate([
      { label: 'File', submenu: [{ label: 'New Tab', accelerator: 'Ctrl+Shift+T', click: () => { clicked++ } }, { type: 'separator' }, { role: 'quit' }] },
    ])
    shim.Menu.setApplicationMenu(menu)
    const out = lines.map((l) => JSON.parse(l)).find((e) => e.ch === 'shell:cmd' && e.p.op === 'menu')
    expect(out.p.items[0].submenu[0]).toMatchObject({ label: 'New Tab', accelerator: 'Ctrl+Shift+T', path: [0, 0], type: 'normal' })
    expect(out.p.items[0].submenu[1].type).toBe('separator')
    expect(out.p.items[0].submenu[2]).toMatchObject({ role: 'quit', path: [0, 2] })
    await shim.dispatch({ k: 'send', ch: 'menu:click', p: { path: [0, 0] } })
    expect(clicked).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/unit/core-menu.test.ts --project unit`
Expected: FAIL, no `shell:cmd` line.

- [ ] **Step 3: Implement**

Per Interfaces. Then the driver checks, which include Review Focus 5:

Rebuild. Scratch `i16`. `menu` Expected: six top-level items `SeaShell`, `File`, `Edit`, `View`, `Navigate`, `Window`, `Help` (seven with Help) and `File` holding `New Tab	Ctrl+Shift+T`. `menuPick { path: [1, 0] }` Expected: a second tab. `click menu`; `shot` to `bakeoff\P2-menu.png` Expected by eye: the 6.3 popup under `≡` (the menu is a real `HMENU`, so it takes the system's menu look; record that in the report). Alt: `key Alt` (the driver sends `WM_SYSKEYDOWN`/`WM_SYSKEYUP` for `VK_MENU` alone) Expected: `stats.menuOpen true` (add it), then `key Escape` closes; in a pane `text "echo "` then `key Alt+.` Expected: the grid shows `\x1b.` handled by zsh (the last argument of the previous command inserted, or nothing if none), and `stats.menuOpen` stays false. Overflow: `key Ctrl+Shift+T` until 14 tabs; `shot` to `bakeoff\P2-tabs-overflow.png` Expected: the strip scrolled so the active (last) tab is visible with `◂` at the left; `click strip:left` three times, `shot` Expected: earlier tabs visible, `▸` at the right.

- [ ] **Step 4: Tests and commit**

Run: `npx vitest run test/unit/core-menu.test.ts test/unit/keys.test.ts test/unit/core-shim*.test.ts --project unit && npm run typecheck`
Expected: PASS, clean.

```bash
git add src/core/electron-shim.ts src/core/index.ts src/core/controller/model.ts test/unit/core-menu.test.ts native/shell/src/ui/menu.h native/shell/src/ui/menu.cpp native/shell/src/model.h native/shell/src/ui/ui.cpp native/shell/src/ui/tabs.cpp native/shell/src/window.cpp native/shell/src/driver.cpp
git commit -m "Pop the application menu from the core's template and scroll the tab strip"
```

---

### Task 17: Drag and drop

**Files:**
- Create: `native/shell/src/droptarget.h`, `native/shell/src/droptarget.cpp`, `test/unit/controller-drop.test.ts`
- Modify: `native/shell/src/app.cpp` (`OleInitialize` instead of `CoInitializeEx`, `RegisterDragDrop` on the body, `RevokeDragDrop` at destroy), `src/core/controller/controller.ts` (the `drop` event), `native/shell/src/driver.cpp` (`drop { paneId, paths, text }`)

**Interfaces:**
- Consumes: `dropText({ paths, text }, platform)` (`panes/drop.ts`: shell quoting, space joining, the trailing space, Windows paths mapped to `/mnt/c` form, `\\wsl.localhost\Ubuntu-24.04\...` mapped to the Linux path, `file://` URIs decoded), the store's focus action, `grid:cmd paste`.
- Produces `droptarget.h`: `class DropTarget : public IDropTarget` on the body window: `DragEnter`/`DragOver` answer `DROPEFFECT_COPY` when the point is over a term pane's `gridRect` (or the drawer's grid) and the data has `CF_HDROP`, `CF_UNICODETEXT` or the `UniformResourceLocatorW` format, else `DROPEFFECT_NONE` (no drop on previews, the explorer, the strip); `Drop` sends `ui:event { type: 'drop', target: 'pane:<id>:grid' | 'drawer:grid', paths: [Windows paths from CF_HDROP], text: the text or URL or null }`. The controller runs `dropText` over `windowsToWsl`-mapped paths and sends `grid:cmd paste` to that grid, then focuses the pane (`PaneView.tsx:525-545`).
- Produces driver command `drop { paneId, paths?, text? }` that sends the same event.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { Controller } from '../../src/core/controller/controller.js'
import { fakeDeps, GEO } from './controller-fakes.js'

describe('drop', () => {
  it('pastes quoted, mapped, space-joined paths with a trailing space and focuses the pane', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    c.command('pane.new')
    const other = c.model().panes.find((p) => !p.focused)!.id
    c.event({ type: 'drop', target: `pane:${other}:grid`, paths: ['C:\\Users\\josh\\My Docs\\a b.txt', '\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\x\'y.md'], text: null })
    const paste = f.grid().find((g) => g.op === 'paste' && g.paneId === other) as { text: string }
    expect(paste.text).toBe("/mnt/c/Users/josh/My\\ Docs/a\\ b.txt /Users/joshwald/x\\'y.md ")
    expect(c.model().panes.find((p) => p.id === other)!.focused).toBe(true)
  })
  it('plain text that is a path is treated as one; other text is pasted as is; previews refuse', async () => {
    const f = fakeDeps()
    const c = new Controller(f.deps, { home: '/h', version: '0', chords: [] })
    await c.boot(GEO)
    const id = c.model().panes[0].id
    c.event({ type: 'drop', target: `pane:${id}:grid`, paths: [], text: 'file:///C:/t/one%20two.txt' })
    expect((f.grid().at(-1) as { text: string }).text).toBe('/mnt/c/t/one\\ two.txt ')
    c.event({ type: 'drop', target: `pane:${id}:grid`, paths: [], text: 'hello' })
    expect((f.grid().at(-1) as { text: string }).text).toBe('hello')
    const n = f.grid().length
    c.event({ type: 'drop', target: `sidebar:empty`, paths: ['C:\\x'], text: null })
    expect(f.grid()).toHaveLength(n)
  })
})
```

  (Match the exact strings `dropText` produces; its own tests in `test/unit` are the authority. If `dropText` quotes with single quotes rather than backslashes, change the expected strings to its output, never the function.)

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/unit/controller-drop.test.ts --project unit`
Expected: FAIL (the controller ignores `drop`).

- [ ] **Step 3: Implement, test, driver checks**

Per Interfaces. Run: `npx vitest run test/unit/controller-drop.test.ts test/unit/drop*.test.ts --project unit && npm run typecheck` Expected: PASS.

Rebuild. Scratch `i17`. `drop { paneId, paths: ['C:\\seashell-build\\redesign\\bakeoff\\E-native.png'] }` Expected: the grid shows `/mnt/c/seashell-build/redesign/bakeoff/E-native.png ` at the prompt (`grid`), nothing executed. A real OLE drop cannot be driven without a second window; the `DropTarget` class is exercised by hand once in the report's "Not verified" unless a helper (`tools/drop-source.cpp`, a tiny console program that `DoDragDrop`s a `CF_HDROP` to a screen point) is cheap to add; add it if under an hour, else record.

- [ ] **Step 4: Stage I gate, snapshot, report**

`npm run typecheck && npm test` green; every Task 12 to 17 driver check green; `run-native-gates.ps1` all ok; the W10 row measured again (the sheets and popovers are closed; the Aero screenshot set: the strip on glass, the sidebar, a sheet, a popover, per spec 10). Append "Stage I" to the report. Then:

```bash
git add native/shell/src/droptarget.h native/shell/src/droptarget.cpp native/shell/src/app.cpp native/shell/src/driver.cpp src/core/controller/controller.ts test/unit/controller-drop.test.ts
git commit -m "Accept file and text drops onto terminal panes"
git branch -f snapshot/native-after-chrome2
```

---
## Stage J: the inventory walk, parity hardening, the gate (Tasks 18 to 20)

### Task 18: Driver completions and the inventory walk

**Files:**
- Create: `scripts/native-inventory.mjs` (one check per inventory row, one printed line per row), `docs/superpowers/specs/2026-10-02-seashell-inventory-status.md` (generated by the script: the table of rows with `ok`, `fail <detail>` or `deferred (spec 12)`)
- Modify: `native/shell/src/driver.cpp` (`dragSelect { paneId, fromRow, fromCol, toRow, toCol }`, `wheel` from Task 5 over a grid, `selection { paneId }` → the text, `appBar { paneId }` → `{ on, offset, range }`, `shot` stamps the capture: the time and the model `seq` drawn in the bottom right corner in test mode, Phase 1 follow-up 13)

**Interfaces:**
- Consumes: every driver command from Phase 1 and this plan; `scripts/native-gates.mjs` (its launch, wait and quit helpers, exported for reuse); the inventory's rows A to X.
- Produces: `node scripts/native-inventory.mjs` launches scratch `j18` seeded with the W10 session (the session file Phase 1's `run-native-w10.ps1` uses), runs one check per row (each check a function returning `{ row: 'B3', ok, detail }`; the rows are numbered in document order inside each letter), writes the status document, prints every line, quits the scratch, and exits non-zero when any row is `fail`. Rows the amendment of 10/03 skips print `skipped (Josh 10/03)`: K, L, and the preview lines of B, C, E, H, I, J, W and X. Rows that spec 12 defers print `deferred (spec 12)`: R (the six themes, pane frames, CRT), Y (not ported by design), the Mac-only items in D and V (Option as Meta, traffic lights), drag out and reordering in J, IME. Checks that Phase 1 left undriven run here: D wheel ramp (a `seq 1 500` then three `wheel` notches at increasing speed: the scrolled distance per notch grows), D app scrollbar (a pane in `less` with mouse tracking on: `appBar.on true`, `click` on the track pages, `wheel` moves `offset`), D drag-select (`dragSelect` over two rows, `selection` returns the text with the line break), H paste into the find field (`key Ctrl+Shift+F`, `editorType`-like `text`, then the find `query`).

- [ ] **Step 1: Implement and run**

Per Interfaces. Run until every row is `ok` or `deferred`; a `fail` that is a product bug is fixed in the owning code with its own one-line commit before the walk is re-run; a `fail` that is a check bug is fixed in the script.

- [ ] **Step 2: Commit**

```bash
git add scripts/native-inventory.mjs docs/superpowers/specs/2026-10-02-seashell-inventory-status.md native/shell/src/driver.cpp scripts/native-gates.mjs
git commit -m "Walk the renderer inventory on the native build"
```

---

### Task 19: Parity hardening

**Files:**
- Modify: `scripts/vt-parity.mjs`, `test/dom/vt-corpus.test.ts` (the expected files gain SGR attributes, colours, cursor shape, the OSC title and link ids, and the mode flags), `native/shell/tools/grid-test.cpp` (dumps the same fields), `native/shell/src/width.cpp` (the three overrides that cite xterm.js source gain the corpus line that exercises them, added to `test/fixtures/width-corpus.txt` when none does; the expected file is regenerated by the dom test, never edited), `docs/superpowers/specs/2026-10-02-seashell-native-design.md` section 4.1 (the plumbing row reads "two wsl.exe, two conhost.exe and one wslhost.exe")

**Interfaces:**
- Consumes: Phase 1's corpus files `test/fixtures/vt-corpus/*`, the dom test that writes `*.expected.json` from xterm.js, `grid-test.exe`.
- Produces: per corpus file, the comparison covers for every cell: the text, the width, the foreground and background as resolved RGB or palette index, bold, italic, underline (style), strikethrough, inverse, dim, blink, the OSC 8 link id (equal when the uri strings are equal), plus the cursor position and shape (`DECSCUSR` block, underline, bar; blinking), the OSC 0/2 title, and the modes (application cursor keys, bracketed paste, mouse tracking mode, alternate screen, origin, autowrap). `vt-parity.mjs` prints `0 mismatches` or the first ten with the file, row, column and field. The 13-resize exception stays named and scoped to the viewport offset.

- [ ] **Step 1: Extend the dumps and the comparison, regenerate, run**

Run: `npx vitest run test/dom/vt-corpus.test.ts --project dom && node scripts/vt-parity.mjs && node scripts/width-parity.mjs`
Expected: the dom test rewrites the expected files; the parity scripts print `0 mismatches` (13-resize excepted as before). Every mismatch the richer comparison surfaces is a real difference: fix it in `grid.cpp`, `grid_store.cpp` or `palette.h` with its own commit, or name it as a new exception with the reason in the report (only if it is cosmetic and invisible in Claude Code's frames; a colour or attribute difference is not cosmetic).

- [ ] **Step 2: Commit**

```bash
git add scripts/vt-parity.mjs test/dom/vt-corpus.test.ts test/fixtures/vt-corpus test/fixtures/width-corpus.txt test/fixtures/width-expected.json native/shell/tools/grid-test.cpp native/shell/src/width.cpp docs/superpowers/specs/2026-10-02-seashell-native-design.md
git commit -m "Compare attributes, cursor, titles, links and modes in the VT parity gate"
```

---

### Task 20: The Phase 2 gate, snapshot, spec row and report

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-seashell-native-design.md` section 14 (row 2), `scripts/win/run-native-gates.ps1` (adds the Phase 2 lines: `latency`, `relay`, `matrix`, `inventory`, the W10 rows)

- [ ] **Step 1: The gate**

On the final build (rebuild everything once more from the branch head):

1. `npm run typecheck && npm test` green (record the counts against Phase 1's 112 files, 1161 tests).
2. `node scripts/width-parity.mjs` and `node scripts/vt-parity.mjs`: `0 mismatches` (named exceptions listed).
3. `scripts/win/run-native-gates.ps1` on a fresh scratch: `env`, `throughput` (the core back within 30 MB at 30 s, or the Task 3 result recorded), `latency` (under 2 ms per move, or the Stage F result recorded), `relay`, `nesting`, `control`, `restore` (the saved session also holds a file and a web pane; they come back as placeholder panes reading `Previews are not in this build`) all ok.
4. `node scripts/native-matrix.mjs` (Task 7b): four rows ok.
5. `node scripts/native-inventory.mjs`: no `fail`.
6. The W10 rows with `run-native-w10.ps1`, Edge closed, five samples each: (a) W10 as Phase 1 measured it (no sidebar, no drawer, no previews): the row against the 200 bar and against Phase 1's 110.8; (b) W10 with the sidebar open at home expanded two levels and the drawer open on one pane; (c) dropped by the amendment of 10/03: no web pane exists. The core RSS for each as its own column.
7. The Aero screenshots at 1x: `P2-glass-strip.png` (the strip on glass with the menu button, 9 tabs and the overflow arrows), `P2-sidebar.png`, `P2-settings.png` (a sheet), `P2-color.png` (a popover), `P2-menu.png`, all already produced by the stages; re-shoot the strip on the final build.
8. Every scratch closed through its driver; no `msedgewebview2.exe`, run-owned `wsl.exe`, core or scratch `SeaShell.exe` left; Josh's SeaShell pids untouched; `%APPDATA%\seashell` and `~/.config/seashell` untouched; nothing on main; nothing pushed.

- [ ] **Step 2: Spec row, snapshot, commit**

Fill section 14 row 2: Phase 2, the night(s), the gate result (pass, or pass with the named bars not met), the three W10 figures, the core RSS, `snapshot/native-after-phase2`, and in the notes the wire decision (socket or stdio).

```bash
git add docs/superpowers/specs/2026-10-02-seashell-native-design.md scripts/win/run-native-gates.ps1
git commit -m "Prove the Phase 2 gates on the native shell"
git branch -f snapshot/native-after-phase2
```

- [ ] **Step 3: The report**

Write `~/.codex/notes/seashell-native-phase2-report-<YYYY-MM-DD>.md` (the sections appended after every stage are rewritten into their final form here), in this order:

```
# SeaShell native shell, Phase 2 (report)
## Where it stopped (one line: stage reached, time, why)
## Stage F: the wire (the relay medians, the branch taken, the drag figure before and after, the throughput numbers, the heap settle result)
## Stage G: explorer, drawer, path click (PNG paths, the reveal and drawer checks, decisions)
## Stage H: skipped (Josh 10/03 04:30, one line naming what was not built; the Task 7b matrix lines)
## Stage I: sheets, popovers, menu, drops (PNG paths, the ping result, the Alt result, the overflow result)
## Stage J: the inventory walk (every row's line, the deferred list with spec 12 cited), parity hardening (what the richer comparison found)
## The W10 rows (a, b, c) against the bar and against Phase 1's 110.8; every gate line
## Branch and snapshots (redesign/1002 head, every snapshot/native-* sha)
## How to launch the scratch build (the exact command; never Programs\SeaShell)
## What Phase 3 starts from (the cutover list from spec 11: Aero exactness pass, colorization edge cases, no-glass fallback, packaging, the updater on win-native, the WorkPanel.cs and pane-hook.zsh edits, replacing Programs\SeaShell with Josh's go)
## Follow-ups (anything that failed a gate, with the numbers; the drop source helper if skipped; anything the inventory walk deferred that spec 12 does not cover)
## Not verified
```

End of Phase 2.
