# SeaShell redesign: off Electron, Windows 7 Aero chrome

Date: 2026-10-02. Written at 03:45 EDT for an unattended run that starts at 08:00 EDT the same day.

This document extends `2026-07-31-seashell-design.md` (the authority, cited below as D§n) and `2026-09-07-seashell-0.5-design.md` (cited as F§n). Where this document is silent, those two hold. Nothing here contradicts them. Where a D§ rule was written in Electron terms it is restated for the new host; the rule itself does not change.

Repo state at writing: `main == origin/main` at `3746bfe`, v0.5.0, clean. Work happens on branch `redesign/1002` in the worktree `~/seashell-wt/redesign`. Main is never committed to and nothing is pushed.

## 0. Decisions, as answered (Josh, 10/02 02:40 to 02:55)

1. **Stack**: measure first. Stage 0 builds a throwaway prototype per candidate and the numbers pick the winner (§3).
2. **RAM bar**: under 200 MB working set at the 9-tab / 10-pane workload (§2).
3. **08:00**: unattended kickoff. Spec, plan and a one-shot cron line exist before 08:00; the run reads them and goes.
4. **Platforms**: Windows only this run. Mac dmg and Linux AppImage are deferred (§12), not built.
5. **Scope**: stack plus skin. Every feature survives 1:1, nothing added, nothing dropped.
6. **Aero scope**: chrome only. The terminal area keeps the Homebrew green on black (D§4.4).
7. **Install**: a parallel dev build under `C:\seashell-build\redesign`. Never copied into `Programs\SeaShell`. Josh switches by hand after reading the report.
8. **path:line** (checked in code, not asked): `src/renderer/links/tokenizer.ts` already splits off a trailing `:line[:col]` or `(line,col)` suffix. Preserved, not new work.

## 1. Goals and non-goals

Goals:

- **G1 RAM.** Median working set under 200 MB at workload W10 (§2), measured by the one script every candidate is measured with.
- **G2 Aero chrome.** Tab bar, pane borders, explorer, status bar, cards, menus, scrollbars and buttons drawn by the app in the Windows 7 Aero visual language, matched to the live desktop colorization (§6). The title bar stays a real DWM frame so OpenGlass keeps drawing it.
- **G3 Features 1:1.** Tabs and the tiled pane grid with drag, resize and zoom; file explorer with path double-click reveal; file and web preview panes; Ctrl+F find; zoom ladder; shell drawer; first-run tutorial; bell pane glow; "Restore last session?" card; in-house updater channel; Ctrl+A select-input-line in agent panes; Ctrl+Shift+V image paste; claude badge and live memory per pane; the Windows key respelling in `src/shared/keys.ts`.
- **G4 Path double-click** survives and is verified on the rebuilt app with real pane output (§7).
- **G5 Contracts** other tools depend on do not change (§8).

Non-goals: Mac and Linux builds; replacing the installed exe; editing the SC Cockpit matcher or `~/.config/seashell-work/pane-hook.zsh`; repointing `~/autopilot/restart/restart_seashell.py`; any new feature; any change to the terminal palette or font; any change to the session file format.

## 2. Baseline and the measurement protocol

Measured 10/02 03:08 EDT on the live exe (`C:\Users\josh\AppData\Local\Programs\SeaShell\SeaShell.exe`, started 23:20 the night before, Josh's 9 tabs / 10 panes restored, idle):

| pid | working set MB | private MB | role (by start order and size) |
|---|---|---|---|
| 980 | 202 | 501 | main (Node + browser process) |
| 29808 | 174 | 152 | renderer |
| 30420 | 117 | 172 | GPU process |
| 9668 | 37 | 10 | utility |
| 26712 | 25 | 12 | crashpad / utility |
| **sum** | **555** | **847** | 5 processes |

A sample at 02:34 read 416 MB working set for the same 5 processes. Working set moves with what the panes are doing, so the bar is defined on a fixed workload, not on the live app.

**Workload W10**: 9 tabs, 10 terminal panes (tab 1 has two panes, tabs 2 to 9 one each), every pane plain `zsh -l` at `/Users/joshwald`, no claude running, explorer closed, window 1440x900 on the main display, 60 s idle after the last pane shows a prompt.

**Counting**: every process in the app's own tree (the root pid and every descendant by parent pid walk) plus every `msedgewebview2.exe` whose command line contains the app's WebView2 user data folder. Microsoft Edge itself is closed for the measurement so no runtime process is shared with another app.

**Metrics**: sum of `WorkingSet64` (headline, "WS"), sum of `PrivateMemorySize64` ("private"), process count. Five samples 10 s apart after the idle period; the median of each sum is the reported number.

**Script**: `scripts/win/measure-ram.ps1 -RootPid <pid> [-UdfSubstring <text>] -Label <name>`; appends one JSON line to `C:\seashell-build\redesign\bakeoff\results.jsonl` and prints it.

**Pass bar**: median WS under 200 MB at W10. The Electron baseline is measured with the same script at the same workload so the before and after are comparable.

## 3. Candidates and the decision rule

Toolchain facts at writing (checked 10/02 03:15):

| Side | Present | Absent |
|---|---|---|
| WSL (Ubuntu 24.04) | gcc/g++ 13.3, cmake 3.28, node 26.10 | cargo, rustc, go, zig, dotnet |
| Windows | VS 2026 Build Tools (MSVC 14.51, `vcvars64.bat` at `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\`), vcpkg at `C:\Users\josh\dev\vcpkg` with ports `webview2`, `wil`, `libuv`, `nlohmann-json`; WebView2 runtime 154.0.4258; portable Node 24.21.0 at `C:\seashell-build\node`; winget | rustup, .NET SDK (only the 8.0 and 9.0 runtimes), Go |

Candidates, each measured at W10 with `measure-ram.ps1`:

- **A. Electron 43** (today). The `C:\seashell-build\src\release\win-unpacked\SeaShell.exe` build (identical to the installed exe) in a scratch user data folder seeded with a W10 session. The baseline.
- **B. WebView2 renderer floor.** A C++ host (vcpkg `webview2` + `wil`, MSVC), one window, one WebView2 showing a page with ten xterm.js 6.0 instances, one attached to a live ConPTY `wsl.exe` zsh. This is the cost of keeping the web renderer on any WebView2 stack. Tauri is B plus its Rust host (about 10 MB) and is not measured separately: rustup is not installed and the number would not change the decision.
- **C. Node sidecar floor.** `node.exe` 24.21 running node-pty with ten `wsl.exe` zsh panes. This is the cost of keeping the existing main-process TypeScript (8,060 lines in `src/main`) alive as a sidecar.
- **D. Native floor.** A Win32 window with DirectWrite drawing ten 120x40 text grids, one fed by a live ConPTY. This is the floor of a full native rewrite, which would also need a terminal emulator meeting D§4 (palette, no COLORTERM, Unicode 11 with the VS16 emoji widths Claude Code assumes, 20,000 scrollback, alt screen with mouse 1003/1006, bell, bracketed paste).

Decision rule, applied in stage 0 and recorded in §13:

- **R1.** If median WS of B + C is under 200 MB: **WebView2 host + Node sidecar** (§4). The renderer and the main-process logic are both kept; the work is a small C++ host, a bridge and an Electron shim.
- **R2.** Else if median WS of B + 25 MB is under 200 MB: **WebView2 host + C++ main**. The renderer is kept, the main process is rewritten in C++. The run builds the host and renderer stages and writes the C++ main plan as an addendum; a C++ rewrite of 8,060 lines is not finishable unattended in one morning and is reported as the follow-up.
- **R3.** Else: **native**. The run stops after §13 with the numbers. A native rewrite is weeks of work and needs its own spec, starting with the emulator choice.

Both WebView2 options count the same WebView2 processes, so B is measured once. If Microsoft Edge is found running at measurement time the script refuses to sample and says so; the run closes nothing it did not start.

## 4. Architecture (the R1 path)

### 4.1 Processes

| Process | Code | Owns |
|---|---|---|
| `SeaShell.exe` (host) | C++, `native/host/` | the window (class `SeaShellHost`, title `SeaShell`), WebView2 controller, bridge relay, sidecar lifetime, single-instance mutex `Local\SeaShellHost`, AppUserModelID `dev.seashell.app`, icon `build/icon.ico`, saved bounds, native folder dialog, clipboard, ShellExecute for open and reveal, DWM glass extension (§6.4), CDP enablement for tests |
| `msedgewebview2.exe` x N | WebView2 runtime | the renderer: today's `out/renderer` bundle unchanged except `src/renderer/platform/bridge.ts` |
| `node.exe` (sidecar) | `out/sidecar/index.cjs` | today's `src/main` modules booted through `src/sidecar/electron-shim.ts`: node-pty panes via `wsl.exe`, fs tree and reads, monitor sweep, session lookup, state files, control endpoint, update check, links notes |

### 4.2 Bridge

Renderer to host: `chrome.webview.postMessage(envelope)`; host to renderer: `PostWebMessageAsJson`. Host to sidecar: the sidecar's stdin and stdout, newline-delimited JSON. One envelope shape on both legs:

```
{ k: 'invoke' | 'send' | 'on' | 'reply', ch: string, id?: number, p: unknown }
```

`invoke` carries an `id` and gets exactly one `reply` with the same `id`; `send` has no reply; `on` is a push from main to renderer. Channel names and payloads are D§12 plus the 0.5 additions, unchanged: zod validation stays where it is today, in `src/main/ipc-router.ts`, now running in the sidecar. `pty:data` batches carry bytes as base64 inside the JSON (§11 lists the throughput check and the deferred shared-memory path).

Host-owned channels (answered in C++, never relayed): `window:minimize`, `window:toggleMaximize`, `window:close`, `window:isMaximized`, `window:onMaximized`, `app:pickFolder` (IFileDialog), `clip:read`, `clip:write`, `open:withDefaultApp`, `open:revealInFinder`, `open:externalHttp` (ShellExecute, `http:` and `https:` only, same gate as D§12), `display:list`, `display:colorization` (§6.2), `test:screenshot` (only when `SEASHELL_CDP_PORT` is set). Everything else relays to the sidecar.

### 4.3 Sidecar shim

`src/sidecar/electron-shim.ts` implements exactly the symbols `src/main` imports from `electron` today (checked 10/02): `app`, `BrowserWindow`, `Menu`, `ipcMain`, `net`, `protocol`, `screen`, `shell`, `clipboard`, plus the types `MenuItem`, `MenuItemConstructorOptions`, `IpcMainEvent`, `IpcMainInvokeEvent`. Behavior per symbol:

| Symbol | Shim behavior |
|---|---|
| `app.getPath / setPath` | `userData` = `SEASHELL_USER_DATA` or `%APPDATA%\seashell`; `home`, `temp`, `exe`, `logs` from Node |
| `app.whenReady / on / once / quit / exit / isPackaged / getVersion / getName` | an EventEmitter; `before-quit`, `will-quit`, `window-all-closed`, `second-instance`, `activate` are raised by the host over the `app:*` control channel; `quit` runs the existing quit drain then exits the sidecar |
| `app.requestSingleInstanceLock` | returns true (the host holds the mutex) |
| `app.setAppUserModelId` | no-op (the host sets it) |
| `BrowserWindow` | one virtual window; `getAllWindows()` returns `[it]`; `webContents.send(ch, p)` writes an `on` envelope; `isDestroyed`, `focus`, `getBounds`, `on('closed')` relay to the host |
| `ipcMain.handle / on / removeHandler` | the stdio bridge's dispatch table; `event.sender` is the virtual window's `webContents` |
| `Menu.buildFromTemplate / setApplicationMenu / popup` | keeps the template so `keys.test.ts` and the renderer's menu button can read it (`menu:template` reply); draws nothing |
| `shell.openPath / openExternal / showItemInFolder` | relayed as host commands |
| `clipboard.readText / writeText` | relayed as host commands |
| `net.fetch` | Node 24 global `fetch` |
| `protocol.*` | no-op; the host serves the renderer over `https://seashell.app/` |
| `screen.getPrimaryDisplay / getDisplayMatching / getAllDisplays` | answered from the host's `display:list` |
| `dialog.showOpenDialog` | relayed as `app:pickFolder` |

Each shim function is a pure adapter with a unit test. The sidecar is bundled by esbuild (`scripts/build-sidecar.mjs`): entry `src/sidecar/index.ts`, `electron` aliased to the shim, `node-pty` external, output `out/sidecar/index.cjs`.

### 4.4 Renderer bridge

`src/renderer/platform/bridge.ts`: when `window.seashell` is undefined and `window.chrome?.webview` exists, build `window.seashell` with the same key tree the preload freezes today (`files, pty, links, fs, watch, open, metrics, projects, session, app, update, window`) over the envelope protocol, then freeze it. A unit test walks the preload's key tree and asserts the bridge object has every key. Nothing else in the renderer changes for the port.

Accelerators: Electron's `before-input-event` shim (`src/main/accelerators.ts`) has no equivalent under WebView2, so the same chord table is matched in the renderer's keydown path and dispatched as `ui:command`. `keys.test.ts` still parses the menu template; a new test asserts the keydown matcher accepts every chord the template produces off the Mac.

### 4.5 Security posture

D§13 holds. The renderer has no Node. The host accepts only JSON envelopes whose `ch` is in its allowlist and relays the rest to the sidecar, which validates with zod as today. WebView2 settings: `AreDevToolsEnabled` and `--remote-debugging-port` only when `SEASHELL_CDP_PORT` is set; `AreDefaultContextMenusEnabled` false; `IsStatusBarEnabled` false; the renderer is served from `resources\renderer` through `SetVirtualHostNameToFolderMapping("seashell.app")`; `NavigationStarting` cancels anything that is not `https://seashell.app/`; `NewWindowRequested` is cancelled and routed through `open:externalHttp`.

### 4.6 RAM budget at W10

host at most 10 MB, WebView2 at most 130 MB, sidecar at most 55 MB, total at most 195 MB. If stage 0 measures the parts above these, the decision rule in §3 applies, not the budget.

### 4.7 Window identity

Class `SeaShellHost` (new), title `SeaShell`, AppUserModelID `dev.seashell.app`, exe for this run `C:\seashell-build\redesign\release\win-host\SeaShell.exe`. `SEASHELL_APP_ID` keeps the `win32-<pid>` form using the **host** pid, which the host passes to the sidecar as `--host-pid`. The SC Cockpit WORK-page switcher and `~/.config/seashell-work/pane-hook.zsh` key on class `Chrome_WidgetWin_1` + title + exe + app id; the class cannot survive leaving Chromium. This run does not edit them. The report names the new class and the exact matcher lines to change.

## 5. Terminal fidelity

D§4 holds unchanged: `@xterm/xterm` 6.0.0, `addon-fit`, `addon-search` (F§2), `addon-unicode-graphemes` 0.4.0 (the 9/30 cell-width fix), `addon-web-links`, `addon-webgl` with the DOM renderer as the context-loss fallback (D§3). Scrollback 20,000 (F§3). `COLORTERM` deleted from the pane env. The pane font is whatever `app:getTerminalFont` serves today. The GPU is games-first: WebGL is used when WebView2 offers it and nothing in the host pins the GPU.

## 6. Windows 7 Aero chrome

### 6.1 What exists

`src/renderer/theme/tokens.ts` already carries an `aero` theme ("Aero Glass, the Windows 7 era": 82 custom properties, frosted glass bars, gradient headers, beveled buttons, 6 px radii), applied by `applyTheme` in `apply.ts` as a token swap; `styles.css` reads tokens everywhere. The work is a retune to the live desktop and a finish of the Win7 controls, not a new skin.

### 6.2 Colorization

The live desktop (OpenGlass 3.0.1, custom build) uses colorization `#881798` with the Win7 balances color 8 / afterglow 43 / blur 49, `RoundRectRadius=6`, taskbar `#6A1277`, light app theme. The chrome follows it:

| Token | Value |
|---|---|
| `--accent` | `#881798` |
| `--onAccent` | `#ffffff` |
| `--chrome` | `#ece2f0` |
| `--chromeAlt` | `#e1d3e8` |
| `--line` | `#b48fc0` |
| `--text` | `#1d0f22` |
| `--dim` | `#5a3f66` |
| `--faint` | `#7f6a8a` |
| `--barBg` | `rgba(136, 23, 152, .22)` |
| `--barImg` | `linear-gradient(rgba(255,255,255,.55) 0%, rgba(243,226,247,.18) 46%, rgba(170,105,185,.26) 52%, rgba(236,220,241,.30) 100%)` (the Win7 reflection band: bright above the midline, darker just below it) |
| `--glassBlur` | `blur(22px) saturate(180%) brightness(1.05)` |
| `--headBg` / `--headImg` | `rgba(247,238,250,.32)` / `linear-gradient(rgba(252,246,254,.42), rgba(236,224,242,.2))` |
| `--sideBg` | `rgba(248,241,251,.46)` |
| `--treeBg` | `rgba(255,255,255,.66)` |
| `--gridBg` / `--gridImg` | `rgba(150,95,165,.18)` / `linear-gradient(160deg, rgba(205,175,215,.34), rgba(135,85,150,.4))` |
| `--paneBorder` | `#8f5fa0` |
| `--paneTitleBg` / `--paneTitleOn` | `#ead9f0` / `#f6ecfa` |
| `--paneRadius`, `--cardRadius`, `--winRadius` | `6px` |
| `--cardBg` / `--cardBorder` / `--cardText` | `#faf5fc` / `#a97fb8` / `#1d0f22` |
| `--primaryBg` / `--primaryImg` / `--primaryBorder` | `#881798` / `linear-gradient(#c09ccb, #881798 52%, #6a1277)` / `#5a0f66` |
| `--tabOnMark` | `inset 0 -2px 0 #881798` |
| `--select` | `#3399ff` (Windows 7 selection blue, unchanged) |
| `--deskImg` | the aurora in purple: `linear-gradient(114deg, rgba(255,255,255,0) 26%, rgba(240,215,250,.72) 38%, rgba(255,255,255,0) 47%), radial-gradient(46% 62% at 74% 16%, rgba(230,150,255,.85), rgba(0,0,0,0) 68%), radial-gradient(52% 48% at 12% 88%, rgba(190,90,255,.5), rgba(0,0,0,0) 70%), radial-gradient(120% 110% at 30% 22%, #a86fc0 0%, #6a1277 36%, #3e0b4a 68%, #1b0520 100%)` |
| `--termBg` / `--termFg` / `--paneBg` | `#000000` / `#28fe14` / `#000000` (decision 6: the terminal stays Homebrew) |
| `--lightsDisplay` / `--winCtlDisplay` | `none` / `none` under the host (Windows draws the caption buttons) |

The xterm `ITheme` for the aero theme is the Homebrew palette (`PALETTES` key `native`), so pane colors are byte-identical to today.

`display:colorization` (host, reads `HKCU\Software\Microsoft\Windows\DWM\ColorizationColor`) feeds a pure `colorizationToTokens(hex)` so the chrome follows the desktop when Josh switches between Mac Mode and Win7 Aero. If the read fails, the table above is the fallback. The blue Win7 "Sky" look stays reachable as the `#2b7cd3` entry in `ACCENTS`.

### 6.3 Win7 controls (chrome only)

- **Buttons**: 1 px `#707070` border, 3 px radius, face `linear-gradient(#f2f2f2 0%, #ebebeb 50%, #dddddd 50%, #cfcfcf 100%)`; hover `linear-gradient(#eaf6fd 0%, #d9f0fc 50%, #bee6fd 50%, #a7d9f5 100%)` with border `#3c7fb1`; pressed `linear-gradient(#e5f4fc 0%, #c4e5f6 50%, #98d1ef 50%, #68b3db 100%)` with an inset shadow; default button gets the `#3399ff` glow ring. Segoe UI 9 pt (12 px).
- **Scrollbars** (explorer, viewer, menus, cards; the terminal keeps the SeaShell app scrollbar from 9/30): 17 px wide, `::-webkit-scrollbar-button` arrows 17 px with the button face above, track `#f0f0f0` with a 1 px inset `#e3e3e3` line, thumb `linear-gradient(90deg, #f0f0f0, #e3e3e3)` with `#a0a0a0` border, 2 px radius and three grip lines, hover `#dcebfc` thumb with `#7da2ce` border.
- **Tabs**: Win7 common-controls tab: 5 px top radius, 1 px `#8e8f8f` border, inactive face `linear-gradient(#f2f2f2, #dcdcdc)`, active face `#ffffff` to `#f3f3f3` joined to the content area, the `--tabOnMark` accent line.
- **Status bar**: `linear-gradient(#f7f7f7, #ececec)`, 1 px `#a0a0a0` top line, Segoe UI 9 pt.
- **Menus** (the menu button's popup and context menus): `#f0f0f0` face, 1 px `#979797` border, highlight `#dcebfc` with 1 px `#7da2ce` border and 3 px radius, separators `#e0e0e0` over `#ffffff`, 2 px drop shadow.
- **Cards and dialogs** ("Restore last session?", toasts, update): `#f0f0f0` face, 1 px `#a0a0a0` border, 6 px radius, Win7 button row.
- **Pane title strip**: glass gradient per 6.2, 1 px `--paneBorder`, Segoe UI 9 pt title.

All of it is CSS and tokens under `src/renderer/styles.css` and `tokens.ts`. Nothing is painted by the host.

### 6.4 Real glass (optional sub-stage, attempted once)

`DwmExtendFrameIntoClientArea(top = tab bar height in px)` on the host window, WebView2 `DefaultBackgroundColor` with alpha 0, and `--barBg: transparent` under the host make the tab strip literal DWM glass that OpenGlass blurs and tints exactly like the caption. Known pitfall: a transparent WebView2 over an extended frame renders black on some driver and runtime combinations. The stage tries it on the RTX 5070 Ti, keeps it if the screenshot shows glass, and otherwise falls back to the painted tokens of 6.2. The report records which.

### 6.5 Evidence

Screenshots via CDP `Page.captureScreenshot` at 1x on the main display (the MSI, device pixel ratio 1), attached to the report: whole window, the tab strip, a button in each state, the explorer with a selected row.

### 6.6 Not allowed

No msstyles, no Windhawk, no DWM hooks, nothing that Defender flags (9/29, never bypass), no edit to the Win7 desktop mode kit (re-applying it reinstalls signed OpenGlass and drops the custom icon inset). The app's own drawing only.

## 7. Path double-click

D§8 and F§4 hold unchanged. Under the host the pipeline is the same code: xterm link provider, `src/renderer/links/tokenizer.ts` (strips quotes and brackets, splits `:line[:col]` and `(line,col)`), `src/renderer/links/resolve.ts` (hard-wrapped rows, truncated `…/x` forms, cwd first then home) shared by panes and the drawer, `fs:statBatch` over the bridge, answered by the sidecar through `src/shared/wsl-path.ts` (`/Users/...` to `\\wsl.localhost\Ubuntu-24.04\Users\...`, `/mnt/c/...` to `C:\...`).

Gestures: double-click reveals in the explorer (never auto-opens; the explorer opens if closed and the row carries `data-path` equal to the file and the `node--selected` class); Ctrl + double-click opens a preview pane; Ctrl+Alt + double-click opens the OS app; a miss shows a toast.

Verification matrix (plan Task 13), on the packaged host in a scratch instance, the strings printed by a real command in a real pane:

| Input printed in the pane | double-click | Ctrl + double-click |
|---|---|---|
| `/Users/joshwald/seashell-wt/redesign/README.md` | explorer row selected, `data-path` = `\\wsl.localhost\Ubuntu-24.04\Users\joshwald\seashell-wt\redesign\README.md` | preview pane titled `README.md` |
| `/mnt/c/seashell-build/redesign/bakeoff/results.jsonl` | explorer row selected, `data-path` = `C:\seashell-build\redesign\bakeoff\results.jsonl` | preview pane |
| `src/main/index.ts:45` (relative, as Claude Code prints references, with the pane cwd at the worktree) | explorer row selected on `index.ts` | preview pane open and scrolled so line 45 is visible (F§4) |

Driven by `scripts/cdp.mjs --dblclick x y [mods]` at the cell's page coordinates (cell size from `window.__seashellTerminals.get(id).term._core._renderService.dimensions.css.cell`). Unit tests cover the tokenizer and resolver already; the matrix is the end-to-end proof.

## 8. Contracts preserved

- **Control endpoint** (`2026-07-31-pane-delivery-design.md`, 10/01 win32 form): unchanged code in the sidecar: `127.0.0.1` TCP on a random port, a 32-byte token, `<userData>\control.json` (pid, port, token), removed on quit; refuses a bad token, an unknown pane, a non-claude foreground, any control character. Proof: `~/.claude/bin/send-to-pane.py` with `SEASHELL_CONTROL_JSON=<scratch>\control.json` types into a claude pane and gets `{"ok":true}`; `~/.claude/bin/register-session.py` records `app_id win32-<host pid>`; `~/autopilot/restart/restart_seashell.py` logs which endpoint answered (connect only). The `/c-assistant` plugin shares send-to-pane's routing and is not run.
- **Session files**: `%APPDATA%\seashell\projects.json` and `last-session.json`, `schemaVersion: 1`, `SavedTab` / `SavedPane` from `src/shared/ipc.ts`, the 10/01 save invariants (`test/unit/save-invariants.test.ts`, 86 tests) and the 30 s snapshot plus quit snapshot (F§6). This run writes only scratch copies.
- **Pane env**: `SEASHELL_PANE_ID`, `SEASHELL_APP_ID=win32-<host pid>`, `SEASHELL_USER_ZDOTDIR` (shim written through `\\wsl.localhost`, refuses its own path), `COLORTERM` deleted, pid file `~/.cache/seashell-win/pids/<app pid>/<pane>.pid`, spawn `wsl.exe -d Ubuntu-24.04 --cd <linux cwd> -e env ... zsh -l`.
- **Window identity**: title `SeaShell`, AppUserModelID `dev.seashell.app`, nautilus icon. Class changes to `SeaShellHost` (§4.7 follow-up).
- **Keys**: `src/shared/keys.ts` respelling unchanged (§4.4).

## 9. Build, packaging and layout

- Build tree: `C:\seashell-build\redesign\` (an rsync of the worktree; `node_modules` installed there with the portable Node 24.21 at `C:\seashell-build\node`). Never under `C:\AI` (`ai-gate.ps1` kills everything there during a game).
- Steps: `npm ci`; `npm run build` (today's main, preload and renderer, still needed for tests and for the renderer bundle); `node scripts/build-sidecar.mjs`; `cmake -S native/host -B C:\seashell-build\redesign\host-build -DCMAKE_TOOLCHAIN_FILE=C:\Users\josh\dev\vcpkg\scripts\buildsystems\vcpkg.cmake -A x64`; `cmake --build C:\seashell-build\redesign\host-build --config Release`; `scripts/win/pack-host.ps1` assembles `C:\seashell-build\redesign\release\win-host\`:

```
SeaShell.exe
resources\renderer\            (out/renderer)
resources\sidecar\index.cjs
resources\node\node.exe        (24.21.0)
resources\node_modules\node-pty\   (win32-x64 prebuild and conpty.dll)
```

- Dev and test: `SEASHELL_USER_DATA=<scratch>` and `SEASHELL_CDP_PORT=9335` (the host adds `--remote-debugging-port=9335` to the WebView2 additional browser arguments); driver `scripts/cdp.mjs` with a new `--shot <file.png>` flag. A scratch instance is stopped by its own pid in a command whose text contains `release/` (the kill guard's exemption) and never by image name.
- Never: launch the installed exe or `~/.local/bin/SeaShell-LEGACY.AppImage`; write `%APPDATA%\seashell` or `~/.config/seashell`; `taskkill /IM`; copy into `Programs\SeaShell`.

## 10. Testing strategy

Unit (vitest `unit` project): shim adapters; envelope codec (parse, serialize, base64 pty batches, rejection of unknown `k` and non-object payloads); bridge key-tree equality against the preload; `colorizationToTokens`; aero token pins (`--termBg #000000`, `--termFg #28fe14`); bake-off session generator validated by `isValidProject`; keydown accelerator matcher against the menu template.

End to end (scratch host + CDP): one pane spawns, shows a prompt, carries the env and writes its pid file; W10 restores from a seeded `last-session.json`; the §7 matrix; the §8 control clients; screenshots.

Gates per stage before the snapshot branch moves: `npm run typecheck`, `npm test`, Release host build, `pack-host.ps1`, `measure-ram.ps1` at W10.

## 11. Risks

- Real glass renders black (6.4): one attempt, then the painted fallback.
- Base64 pty transport through two JSON hops: measured with `cat` of a 50 MB file into a pane and a `yes | head -c 200M`; the existing ack flow control (D§4.7) bounds the buffer. Shared memory is the deferred upgrade.
- WebGL under WebView2: if unavailable, the DOM renderer fallback already exists.
- node-pty on Windows uses ConPTY, which is what the 10/01 exe uses under Electron's Node; same binary prebuild, same behavior.
- The kill guard fires on any kill verb in a command that mentions "seashell" unless the command mentions `release/`; stop scratch instances by pid with the release path in the same command.
- Wall clock: stages after the decision are long. The report is appended after every stage so a cut-off run still reports.
- Guard against measuring a shared WebView2 runtime: Edge must be closed; the script checks and refuses.

## 12. Deferred and out of scope

Mac and Linux hosts (the renderer and sidecar are portable; a host per OS is the deferred piece); replacing `Programs\SeaShell`; the cockpit matcher and pane hook edit; autopilot restart repoint; C++ main (R2); native emulator (R3); shared-memory pty transport; a host-aware update asset name (the updater channel keeps checking GitHub for `SeaShell-<v>-universal.zip` and must not offer that asset to the host build: the host build reports `platform: win-host` and the updater declines until a matching asset name exists); Tauri.

## 13. Decision record (written by stage 0 of the run)

| Candidate | processes | WS median MB | private median MB | notes |
|---|---|---|---|---|
| A Electron 43 at W10 | 54 | 948.6 | 471.7 | 10 panes, 10 prompts, 9 tabs at 1440x900. Top 3: the three Chromium processes, main 172, then 110 and 109. `bakeoff\A-electron.png` |
| B WebView2 renderer floor | 12 | 482.7 | 333.7 | 10 xterm instances, WebGL in all 10, one live zsh in terminal 0 (one pane's plumbing only). Top 3: msedgewebview2 126, 115, 100. `bakeoff\B-webview2.png` |
| C Node sidecar floor | 51 | 664.1 | 278.1 | node.exe 150 plus ten real panes: wsl.exe 12.7 each, two per pane. No window |
| D Native floor | 6 | 91.9 | 66.2 | bakeoff-win32 40.5, one live zsh in grid 0, ten grids drawn (one pane's plumbing only). `bakeoff\D-native.png` |
| B + C | | 1146.8 | | the R1 number |

Rule applied: R3 (B + C = 1146.8, B + 25 = 507.7, both over 200). Chosen: native. Measured at: 13:33 to 13:41 EDT 10/02, one candidate at a time; Edge closed: yes (0 msedge.exe, the Startup Boost processes were stopped at 13:29 on Josh's go); display: MSI 1x. Five samples per row, 10 s apart after a 60 s idle; the spread inside every row is under 4 percent. Written by: the run, stage 0, Task 6, resumed at 13:30 from the session that armed it.

What the rows say beyond the rule:

- The per-pane plumbing dominates. C minus its node.exe is 514 MB WS (128 MB private) across 50 processes: each pane is two wsl.exe, two conhost.exe and one wslhost.exe, about 51 MB WS (13 MB private). Every stack that runs a pane as `wsl.exe -d Ubuntu-24.04` pays it, so under the section 2 counting rule no stack reaches 200 MB WS at W10. Even D with ten real panes would read about 41 + 514 = 555 MB WS (about 180 MB private).
- App only, plumbing removed (one pane's worth for B and D, ten for A and C): Electron 435 MB WS, WebView2 432 MB WS, native 41 MB WS. WebView2 is not lighter than Electron; ten xterm.js panes with WebGL cost about 430 MB of Chromium whichever shell wraps them. Replacing Electron with WebView2 would not move Josh's number.
- Private bytes, the more honest system cost (WS counts shared DLL pages once per process): app only, Electron 344, WebView2 321, native 53.

Consequence (section 3, R3): the run stops at stage 0 and reports. Tasks 7 to 14 are not started, because the host they would build (WebView2 plus the Node sidecar) lands where today's app already is.
