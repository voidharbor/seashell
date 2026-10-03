# SeaShell native shell: design

Date: 2026-10-02, afternoon. Branch `redesign/1002`. Supersedes the R1 path of `2026-10-02-seashell-redesign.md` (the redesign spec); its sections 2 (measurement protocol), 6 (Aero values), 7 (path double-click matrix) and 8 (contracts) are reused by reference and are not restated here.

## 0. Why this document exists

Stage 0 of the redesign measured four candidates at the W10 workload (9 tabs, 10 zsh panes, 1440x900, Edge closed, five samples; redesign spec section 13, commit `663ca16`):

| Candidate | processes | WS median MB | private MB |
|---|---|---|---|
| A Electron 43 | 54 | 948.6 | 471.7 |
| B WebView2 renderer floor | 12 | 482.7 | 333.7 |
| C Node sidecar floor | 51 | 664.1 | 278.1 |
| D native Win32 floor | 6 | 91.9 | 66.2 |

Two facts follow. WebView2 is not lighter than Electron: ten xterm.js panes cost about 430 MB of Chromium whichever shell wraps them, so the R1 host would have landed where today's app is. And the per-pane plumbing dominates: each pane spawned as its own `wsl.exe` costs about 51 MB working set (two wsl.exe, two conhost.exe, one wslhost.exe), 514 MB for ten, before any app code runs. The decision rule returned R3. Josh chose, at 14:05, to do R3 for real: a native shell, and a pane model that stops paying the per-pane plumbing.

## 1. Decisions, as answered (Josh, 10/02 14:05 to 14:35)

1. **Native rewrite.** The renderer (React 19 plus xterm.js, 14,500 lines) is replaced by a C++ Win32 shell. The 200 MB bar stands.
2. **The bar counts the whole tree, and the plumbing is fixed too.** "Under 200 MB" means everything Task Manager would attribute to SeaShell on the Windows side: the shell, one wsl.exe and its children. One wsl.exe for the whole app instead of one per pane. Memory the core uses inside the WSL VM is measured and reported separately, never hidden.
3. **Aero only.** The native build ships the Windows 7 Aero chrome matched to the desktop colorization plus the four terminal palettes. The other six themes, the five pane frames and the CRT effects are deferred (section 12). Settings keeps the controls and greys out the deferred ones.
4. **Main runs inside WSL.** Today's main process runs unchanged as one Node process in Ubuntu, on the Linux platform path that already exists for the AppImage build, with real Linux ptys. Not a Windows-side Node sidecar, not a C++ port of main.
5. **UI logic stays TypeScript.** The store reducer, layout math, link tokenizer and resolver, serialize and restore, zoom, attention and the app controller move into the core as a headless controller that emits a view model. The shell draws it and never computes layout.
6. **libvterm** is the VT engine, vendored, with our own OSC 8 handling and a utf8proc width hook.
7. **Tabs sit in the glass title bar**, IE9 style, next to the caption buttons.
8. **Three phases, one spec, a plan per phase, Josh's go between phases.** Each phase runs unattended overnight with a morning report.

Standing rules from the redesign spec section 0 and 9 hold unchanged: never kill, launch or replace the installed `Programs\SeaShell\SeaShell.exe` or the LEGACY AppImage; never write `%APPDATA%\seashell` or `~/.config/seashell` from a dev run; scratch instances only, each with its own `SEASHELL_USER_DATA`; never `taskkill /IM`; nothing under `C:\AI`; never commit on `main`; never push; one-line commit messages; no em dashes anywhere.

## 2. Goals and non-goals

Goals:

- A Windows SeaShell whose Windows process tree stays under 200 MB working set at W10, measured by the redesign spec section 2 protocol with one change: the tree now contains one wsl.exe, and that wsl.exe is part of the measurement.
- Every user-facing feature in the renderer inventory (section 3) survives, with the theme exception in decision 3. Nothing added.
- The chrome looks like Windows 7 Aero on real DWM glass, matched to the live colorization; the terminal area stays Homebrew green on black, never glass.
- Path double-click on paths Claude prints (Linux path, /mnt/c path, path:line, quoted path with a space) works on the native build with real pane output (redesign spec section 7).
- The control endpoint, session files, pane env and window identity contracts hold (section 9).
- A parallel dev build under `C:\seashell-build\redesign\release\win-native\`. Josh switches by hand.

Non-goals for this spec: Mac and Linux shells, the deferred themes, a C++ port of main, IME and accessibility, tab or pane drag reordering (not present today either), drag out of the app.

## 3. What has to survive: the feature inventory

The inventory produced on 10/02 from every renderer file is the scope document for phases 1 and 2. It is long, so it lives next to this spec as `2026-10-02-seashell-renderer-inventory.md`. Its headline numbers: 47 IPC channels, 32 menu commands, 8 zoom rungs, 7 sheets and popovers, 4 confirm dialogs, 6 localStorage keys, 3 user-data files. Every row of that inventory maps to a phase in section 11; a row with no phase is a dropped feature and a spec bug.

Renderer-side state that today lives in localStorage (settings, zoom index, sidebar width, drawer height, tutorial seen, dismissed update) moves to one file, `<userData>/ui-state.json`, written by the core through the existing atomic write helper. The native build starts with the same defaults a fresh renderer would.

## 4. Architecture

### 4.1 Processes

| Process | Code | Owns |
|---|---|---|
| `SeaShell.exe`, the shell | C++17, `native/shell/` | the window (class `SeaShellHost`, title `SeaShell`, AppUserModelID `dev.seashell.app`, icon `build/icon.ico`), the DWM glass frame, every terminal grid (VT state, scrollback, selection, find, drawing), all drawing of the view model, keyboard and mouse, the chord table, clipboard, `IFileDialog`, `ShellExecute` for open and reveal, `MessageBox` confirms, the attention ping, saved window bounds, single-instance mutex `Local\SeaShellHost`, the core's lifetime, the loopback test driver |
| two wsl.exe, two conhost.exe and one wslhost.exe | Windows | the pipe into Ubuntu. `wsl.exe` spawned once with piped stdio and `CREATE_NO_WINDOW`. Measured 10/02 at 50.7 MB working set, 8.7 MB private for the five processes |
| `node`, the core | Ubuntu, `/usr/bin/node` 24 or newer, bundle `core/index.cjs` | today's `src/main` through the Electron shim on the `wslhost` platform (section 4.4): panes as Linux ptys through node-pty, fs tree and reads with the path guard, watcher pool, metrics sweeps from `ps` and `/proc`, session lookup, state files, the TCP control endpoint, update check, link notes; plus the headless UI controller (section 4.3) |

Nothing else. No renderer process, no Chromium at all (amendment 10/03: web and PDF panes are not built).

### 4.2 The wire

The shell spawns `wsl.exe -d Ubuntu-24.04 --cd ~ -e env SEASHELL_HOST_PID=<shell pid> SEASHELL_USER_DATA=<linux path> SEASHELL_HOST=native-win SEASHELL_CDP_PORT=<port if set> <node> <core>/index.cjs` and talks to it over stdin and stdout. Newline-delimited JSON envelopes, the redesign spec section 4.2 shape, both directions:

```
{ k: 'invoke' | 'send' | 'on' | 'reply', ch: string, id?: number, p: unknown }
```

Three kinds of traffic ride on it:

- **The 47 IPC channels** of `src/shared/ipc.ts`, unchanged names and payloads, zod validation in `ipc-router.ts` as today. The shell is a client of a handful (`app:getPaths`, `pty:write`, `pty:resize`, `clipboard:*` for paste); the controller inside the core is the client of the rest, in process, no pipe.
- **Pane bytes.** `pty:data` batches, core to shell, bytes as base64 inside the JSON, one batch per animation frame across all panes as the batcher does today; `pty:write` shell to core. The throughput check in section 10 decides whether a length-prefixed binary frame replaces base64 for `pty:data`; the envelope stays for everything else.
- **The view model and UI events** (section 4.3).

Channels the shell answers itself and never relays: `window:*`, `app:pickFolder`, `clip:read`, `clip:write`, `open:withDefaultApp`, `open:revealInFinder`, `open:externalHttp` (http and https only), `display:list`, `display:colorization`, `test:*`. Path arguments to the `open:*` channels arrive as Linux paths and the shell converts them (`/mnt/c/x` to `C:\x`, anything else to `\\wsl.localhost\Ubuntu-24.04\...`) before `ShellExecute`.

### 4.3 The headless controller and the view model

`src/core/controller/` is app.tsx without React: it owns `AppState` (the store reducer, unchanged), the tab and pane lifecycle, the boot order (font metrics from the shell, `app:getPaths`, explorer root, `session:load`, restore card or first tab), menu commands, toasts, drawer management, find orchestration, project open and save, session snapshots every 30 s and at quit, settings, zoom, attention and the ping decision. It is driven by two inputs and produces one output:

- Input, `ui:event` from the shell: `{ type: 'click' | 'dblclick' | 'down' | 'up' | 'move' | 'wheel' | 'key' | 'text' | 'drop' | 'resize' | 'focus' | 'blur', target: string, ... }` where `target` is an id the view model assigned (`tab:3`, `pane:7:close`, `divider:2`, `explorer:row:12`, `sheet:settings:theme:aero`, ...). Chords matched by the shell arrive as `ui:command` with the same 32 values the menu produces today.
- Input, `term:event` from a grid: title change, OSC 7 cwd, bell, exit, path double-click with the joined logical line and the click index, selection for copy.
- Output, `ui:model`: the full UI snapshot after every state change. Tabs (id, name, active, rename field), the active tab's panes with their rects in device-independent pixels, kind, label, badge, memory badge, color, attention, focus, status and exit overlay, dividers with rects and cursors, zoomed pane, sidebar (visible, width, rows with depth, icon, name, ignored, expanded, selected, flashing), drawer (open, height, pane, header, cd button), find bar, status bar strings, the open sheet with its fields, popovers, context menu, toast, update banner, the zoom badge, cursor shape. Rects come from the layout math in `src/renderer/layout/` moved verbatim into the core, fed by the shell's `{ clientW, clientH, dpi, cellW, cellH, uiScale }`.

The shell holds no application state. It holds view state only: hover, scroll offsets, text field carets, the active drag, which grid has keyboard focus. A divider drag is `down`, `move` at pointer rate, `up`; the core answers each move with a new model. The round trip on this machine is under a millisecond; the Phase 1 gate measures it.

Keystrokes bound for a terminal never cross as events: the shell encodes them in the grid's VT engine and sends the resulting bytes as `pty:write`. The chord table (`src/shared/keys.ts`, off-Mac spelling: `Ctrl+Shift+T` new tab, `Ctrl+Alt+P` projects, and so on) is matched in the shell before the grid sees the key, exactly as `attachCustomKeyEventHandler` swallows those chords today.

### 4.4 The `wslhost` platform

`src/main/platform/wslhost.ts` is selected when `SEASHELL_HOST=native-win`. It is `linux` (POSIX ptys, native fs, `ps` and `/proc` sweeps, verified kill) with the Windows pane identity contract on top:

- `appInstanceId('win32', SEASHELL_HOST_PID)` is the pane's `SEASHELL_APP_ID`. The platform half stays `win32` because `send-to-pane.py` routes on it and `~/.config/seashell-work/pane-hook.zsh` matches `win32-*`.
- Panes get `paneVars()` from `src/shared/wsl-shell.ts` (TERM, TERM_PROGRAM, SEASHELL_PANE_ID, SEASHELL_APP_ID, ZDOTDIR and SEASHELL_USER_ZDOTDIR, SEASHELL_PIDFILE) through node-pty's env, `COLORTERM` deleted as `buildEnv` already does.
- The ZDOTDIR shim is `wslShimFiles()` written to `shimDirFor(home)` (`~/.cache/seashell-win/zdotdir`), and the pid files are `pidFileFor(home, SEASHELL_HOST_PID, paneId)` under `~/.cache/seashell-win/pids/<shell pid>/`, written by the shim's `.zshenv` as today. Stale pid directories of dead shell pids are swept at startup using `tasklist.exe` through `/mnt/c`, since the pids are Windows pids.
- `controlTransport: 'tcp'`: `index.ts` picks `startTcpControlServer` on `platform.controlTransport === 'tcp'` instead of `process.platform === 'win32'`. `control.json` keeps its fields; `pid` is the shell's Windows pid (what `restart_seashell.py` and `send-to-pane.py` check with `tasklist`), and a new `corePid` field carries the Linux pid.
- `terminalFont: null` (the Terminal.app face is Mac only).
- `app:getPaths` answers `home` as the Linux home, `platform: 'win32'`, `host: 'native'`.

`userData` is `SEASHELL_USER_DATA` as a Linux path on drvfs: `/mnt/c/Users/josh/AppData/Roaming/seashell` for a real install, `/mnt/c/seashell-build/redesign/scratch/<name>` for every dev run. `projects.json`, `last-session.json`, `links/`, `control.json` and `ui-state.json` land where today's app and every client expect them. `window-bounds.json` is written there by the shell, same keys. No `control.sock`: AF_UNIX cannot bind on drvfs and the TCP form is the contract anyway.

### 4.5 Core staging and lifetime

The release carries `resources\core\` (the esbuild bundle, `node-pty` built for Linux x64 against Node 24 ABI, `shiki` grammars). On launch the shell runs `wsl.exe -d Ubuntu-24.04 -e sh -c 'test -f ~/.cache/seashell-win/core/<version>/index.cjs || (mkdir -p ... && cp -r /mnt/c/.../resources/core/. ~/.cache/seashell-win/core/<version>/)'` once, then starts the core from the Linux copy, so native modules never load from drvfs. Node under 24 or missing: the shell shows one `MessageBox` naming the fix and exits.

The shell owns the core: it starts it before the window shows, restarts it once if it exits within the first 5 s (and shows the exit text if it exits again), and ends it at quit after the quit drain (`session:requestSnapshot`, 4 s as today on win32). If WSL itself goes away every pane dies, which is what happens today when each pane is its own wsl.exe.

### 4.6 Security posture

The shell accepts only envelopes whose `ch` is in its own allowlist and relays the rest to the core, which validates with zod. No web content runs except inside a web or PDF pane's WebView2, which keeps today's guards: partition `persist:seashell-preview` as a WebView2 user data folder under userData, `NavigationStarting` cancels anything not http or https, `NewWindowRequested` is cancelled and routed through `open:externalHttp`, no dev tools unless `SEASHELL_CDP_PORT` is set. The test driver (section 10) listens on loopback only when `SEASHELL_TEST_PORT` is set, with a token in `<userData>/test.json`.

### 4.7 RAM budget at W10

Shell at most 70 MB working set (41 measured floor plus ten grids with scrollback), plumbing 51 measured, total Windows tree at most 125 MB working set; the bar is 200. Core RSS inside WSL at most 90 MB, read from `/proc/<corePid>/status` by the measurement step and reported in the same table as a separate row, never summed into the Windows number and never omitted.

### 4.8 Window identity

Class `SeaShellHost`, title `SeaShell`, AppUserModelID `dev.seashell.app`, exe `C:\seashell-build\redesign\release\win-native\SeaShell.exe`, `SEASHELL_APP_ID=win32-<shell pid>`. The SC Cockpit WORK page (`WorkPanel.cs:193`, class `Chrome_WidgetWin_1`; `:179`, the installed exe path) and `pane-hook.zsh` are not edited by any phase before cutover; Phase 3 lists the exact edits (section 11).

## 5. The terminal grid

### 5.1 VT engine

libvterm 0.3.3, the neovim branch, MIT, vendored at `native/third_party/libvterm` (sources copied, not a submodule, so the build never fetches). It supplies the parser, the screen and the scrollback callbacks, cursor shapes and blink from DECSCUSR, the alternate screen, bracketed paste, the mouse protocols, keyboard encoding with modifiers, 256 and true color, and OSC 0/2 titles. Two gaps are closed in our code:

- **OSC 8 hyperlinks.** libvterm 0.3.3 has no URI attribute. The shell registers the OSC fallback, parses `8;params;uri`, keeps the current link id, and stamps it on cells as it mirrors the screen into its own buffer. Only http and https links activate, on click with no selection in progress, as today.
- **Width.** libvterm's `unicode.c` is the old Markus Kuhn table. The vendored copy gets a one-function patch so `vterm_unicode_width` calls `utf8proc_charwidth` (vcpkg `utf8proc`, Unicode 15.1), and the shell segments input into grapheme clusters with `utf8proc_grapheme_break` before feeding libvterm, so ZWJ emoji sequences occupy the cells xterm.js with the graphemes addon gives them. The parity corpus in section 10 is the gate.

### 5.2 Buffer and scrollback

The shell mirrors libvterm's screen into its own cell store so it can draw, select, search and keep 20,000 lines of scrollback per pane. A row is variable length (up to its last non-blank cell) with run-length attributes (fg, bg, bold, italic, underline, strike, inverse, link id) and a wrapped flag, so path double-click can join wrapped rows into one logical line as `wrap-join.ts` does today. Budget: 12 MB per pane at full scrollback with 120-column text, measured by filling a pane with `yes` output. Resize reflows the scrollback the way xterm.js does (rewrap by width).

### 5.3 Drawing

Direct2D 1.1 on a per-monitor-v2 DPI aware window, DirectWrite glyph runs. Each row keeps an `IDWriteTextLayout` invalidated when its cells change; a frame draws dirty rows only, with color runs as drawing effects. Consolas, which is what the Windows exe renders in today (the Terminal.app face is null on Windows and the fallback chain ends at the system monospace). Font sizes are the zoom ladder of `zoom.ts` (9, 12, 13, 16, 17, 21, 25, 30 px at ui scales .85, .95, 1, 1.1, 1.18, 1.32, 1.48, 1.65), global and per pane. Box-drawing and block characters are drawn as geometry from a table (the `customGlyphs` behaviour), so lines meet and blocks fill the cell. Block cursor with blink, outline when the grid is unfocused, no blink after exit. Selection as an overlay, search matches in `#255A1E` with the active match in `#3C5A8A`, OSC 8 links underlined on hover. `--termBg #000000`, `--termFg #28fe14`, the Homebrew palette from `palette.ts`, and the four palette overrides. Hidden tabs keep their grids and skip drawing; only visible grids are resized.

### 5.4 Input

Keys go through `vterm_keyboard_unichar` and `vterm_keyboard_key` with Ctrl, Alt and Shift, after the chord table has had first refusal. Ported line for line from `src/renderer/term/`: Shift+Enter sends `ESC CR`; bare Ctrl+A selects the input line when the foreground process is claude, codex, opencode or gemini; Backspace or Delete right after that select sends Ctrl+U; the velocity-ramped wheel (ceiling 8x, onset 1.5 px/ms, gain 1.2, decay 200 ms, EMA 0.3, forced to 1x in the alternate buffer or under mouse tracking); the overlay app scrollbar for full-screen TUIs that turns thumb drags and track clicks into wheel reports; double-click detection with the 4 px and 500 ms de-duplication; Alt+double-click swallowing the second click under mouse tracking; Option-style forced selection on Alt. Mouse selection with drag, double-click word and triple-click line. Paste through `vterm_keyboard_start_paste` and `end_paste` so bracketed paste works; the Windows-path-to-/mnt conversion and the clipboard image path from `app.tsx` stay in the controller.

### 5.5 Find

Case and regex toggles, the `N of M` counter capped at `1000+`, Enter and Shift+Enter, Escape closes from anywhere, a red field on a miss, a swallowed unfinished regex, match scrolling to mid-viewport, and the anchor that keeps the user's match selected while output streams. Implemented over the cell store with `std::regex` for the regex mode (ECMAScript grammar, the closest to what the search addon runs).

### 5.6 Events to the core

Title (cleaned by `cleanPaneTitle`, which moves to the core), OSC 7 cwd (parsed by `osc7.ts`, moved), bell, exit with code and signal, path double-click (the joined logical line, the click index and the modifiers; the core tokenizes, resolves and reveals), selection text on copy.

## 6. Windows 7 Aero chrome

The values are the redesign spec section 6 (colorization `#881798`, Win7 balances 8/43/49, radius 6, taskbar `#6A1277`, the control table) and they are not restated. What changes with a native window:

- **Real glass is the main path, not a sub-stage.** The window keeps its DWM frame and extends it into the client area by the tab strip height with `DwmExtendFrameIntoClientArea`. The tab strip, the settings and sleep buttons and the zoom badge are drawn on that glass; the caption buttons stay DWM's own, so they get whatever the desktop gives every window (on this PC, the OpenGlass build). `WM_NCHITTEST` returns `HTCAPTION` for empty strip and `HTCLIENT` over tabs and buttons, so the window drags by its strip. The body below the strip is opaque: Win7 control gradients on the sidebar, drawer, find bar, status bar and sheets; the terminal area flat black.
- **Colorization follows the desktop live** through `WM_DWMCOLORIZATIONCOLORCHANGED` and `DwmGetColorizationColor`, mapped by `colorizationToTokens` (moved to the core, same table, same tests). No registry polling.
- **Without glass** (DWM composition off, or a remote session) the strip is painted with the Win7 opaque frame color from the same table. Nothing breaks.
- Tabs in the strip are IE9 shaped: 100 to 220 px, the active one merges into the body, inactive ones sit on the glass with the Win7 tab gradient, names ellipsised, double-click to rename in place.
- **Dark tab strip** (amendment 10/03 05:40, Josh): the Settings sheet's `Tab strip` field, `System` (follows `AppsUseLightTheme` live), `Light` or `Dark`. Dark replaces the strip tokens only (frame, frameText, tabActive, tabInactive, tabText, badge, badgeText, glassTint, plus `stripDark`), the wash becomes black at 55 percent, and the body below the strip keeps the Win7 light chrome.
- **Not allowed** (redesign spec section 6.6): no msstyles, no Windhawk, nothing that touches other windows.

## 7. Everything else in the window

Drawn from the view model, Direct2D, one window:

- **Panes and layout**: title bars (index, color dot, label with tooltip, link button, badge, per-pane zoom %, memory badge at 200 MB with the high style past 1 GB, close), exit overlay with Restart, zoomed pane, dividers with the 9 px strip, cursors, the `Tab is full (6 panes)` dimming and toast. The math (`auto-arrange`, `dividers`, `resize`, `minimums`, `tree`) runs in the core unchanged.
- **Explorer** (`File Browser`): rows, twisties, folder and file icons with extension color chips (the SVGs become Direct2D paths), ignored dimming, error and truncated rows, context menu (`Open Outside SeaShell`, `Reveal in Finder`), refresh, live watch, reveal with the green flash and centre scroll, the width grip with double-click reset, the left-truncating path strip that copies on click.
- **Drawer**: header with the pane label, OSC title or cwd, `cd to pane`, close; one shell per pane, lazy, kept mounted; the top grip.
- **Sheets and cards**: Restore card (Restore autofocused, Start fresh, Esc), Settings (theme row with the deferred themes greyed, accent, palette, pane frame greyed, CRT greyed, the four checkboxes, the new-pane command field, the tutorial button), Projects (scope, save, name, rows with Delete confirm, Add, Open), Tutorial (12 steps, dots, Back, Next, Skip, the checkbox, arrow keys captured).
- **Popovers**: color picker (7 swatches plus none), link picker (`Share notes with`, disabled states, `Stop sharing`), explorer context menu. Esc or an outside click closes them.
- **Text fields**: one custom single-line edit widget (caret, selection, Ctrl+A, Home and End, clipboard) used by tab rename, find, the URL bar, the project name and the new-pane command. Preview edit mode uses a child `EDIT` control with `ES_MULTILINE`, Consolas, Ctrl+S to save, which matches a textarea.
- **File preview pane** (not built, amendment 10/03; Ctrl+double-click opens the file with the default app instead): the core reads the file (8 MB cap, truncated flag) and, below 512 KB, runs Shiki in the core (the same 27 grammars and `github-dark-default`) and returns colored runs; the shell draws them with a `Plain / Highlight` toggle. Edit, Reveal, Open, the dirty flag, the mtime conflict banner with `Reload from disk`, the save error text, the four confirms as `MessageBox`. Images through WIC into a Direct2D bitmap, centred; animated GIF frames play with their delays. PDF opens in a WebView2 control (Edge's viewer) with Reveal and Open and no find bar, as today.
- **Web preview pane** (not built, amendment 10/03; `web:new` toasts `Web previews are not in this build`): a WebView2 control created in the pane rect and destroyed with the pane. The URL bar, back, forward, reload or stop, open externally, the `normalizeUrl` rules, the `Could not load` banner and the host:port label are shell and core code; only the page is Chromium.
- **Status bar**: pane count, `~X in panes`, used of total with warn and crit, compressed, swap, the hint string in Windows spelling.
- **Toasts, update banner, the `Starting SeaShell...` splash and the `No tabs open` state.**
- **Attention**: breathing border on a timer (2.8 s loop for waiting, four 1.8 s cycles for done), the tag color when set, never on the focused pane, off when Sleep is on, honouring `SPI_GETCLIENTAREAANIMATION` for reduced motion. The ping is the two sine tones (880 Hz then 587.33 Hz, 90 ms apart) rendered into a buffer once and played through XAudio2, at most once per 1.8 s, only when glow and sound are both on.
- **Drag and drop**: `IDropTarget` on term panes for `CF_HDROP`, text and URIs; paths mapped to `/mnt/c` form, shell quoted, space joined, trailing space, then focus; no drop on previews or the explorer; no drag out.
- **Zoom**: global rungs with the `N%` badge and `*` for pane overrides, click to reset; per-pane text zoom; every chrome dimension scales with `uiScale`.
- **Menu**: the `≡` button pops a native `HMENU` built from the same template `menu.ts` produces, so `keys.test.ts` keeps passing, and the hidden menu bar appears on Alt as the Linux build does.

## 8. Path double-click

Unchanged in substance: the shell maps a double-click to a cell, joins wrapped rows, sends the logical line and index; the core runs `tokenizer.ts` and `resolve.ts` (moved, same tests) and reveals or opens with the default app (amendment 10/03: there is no preview; Ctrl and Ctrl+Alt double-click both open with the default app). The redesign spec section 7 matrix, including the quoted path with a space and a `:12` suffix, must pass on the native build with text that a real zsh pane printed. Ctrl replaces Cmd in the modifier forms.

## 9. Contracts preserved

- **Control endpoint**: the TCP loopback form with a 32-byte token in `<userData>/control.json` (`pid` = shell pid, `corePid` added), listening inside Ubuntu, so a WSL client reaches it at `127.0.0.1:<port>` in every networking mode and a Windows client through localhost forwarding. Refuses a bad token, an unknown pane, a non-claude foreground, any control character. Proof: `~/.claude/bin/send-to-pane.py` with `SEASHELL_CONTROL_JSON` pointed at the scratch file types into a claude pane and gets `{"ok":true}`; `register-session.py` records `app_id win32-<shell pid>`; `restart_seashell.py` connect-only logs which endpoint answered.
- **Session files**: `projects.json`, `last-session.json`, `schemaVersion: 1`, `SavedTab` and `SavedPane` unchanged, the 86 save-invariant tests unchanged, the 30 s and quit snapshots.
- **Pane env**: `SEASHELL_PANE_ID`, `SEASHELL_APP_ID=win32-<shell pid>`, `SEASHELL_USER_ZDOTDIR`, `COLORTERM` deleted, the pid file. Checked from inside a pane in Phase 1.
- **Window identity**: section 4.8.
- **Keys**: `src/shared/keys.ts` unchanged.

## 10. Testing strategy

- **TypeScript**: the existing 1,092 tests keep passing unchanged. The controller gets vitest coverage per `ui:command` and per `ui:event` kind on a fake shell. The `wslhost` platform, the shim and the stdio bridge get unit tests. `colorizationToTokens`, `tokenizer`, `resolve`, `serialize`, `layout` keep their tests where they move.
- **The shell test driver**: with `SEASHELL_TEST_PORT` set, a loopback JSON endpoint in the shell answers `model` (the last view model), `shot <file.png>` (the window as PNG), `grid <paneId>` (the visible text and cursor), `key`, `click`, `text`, `wait <predicate>`. `scripts/native-driver.mjs` wraps it the way `cdp.mjs` wrapped CDP. Every end-to-end check below uses it.
- **Parity corpus**: a 300-string corpus (ASCII, CJK, combining marks, emoji with ZWJ and skin tones, flags, box drawing) is measured by xterm.js with the graphemes addon in vitest and by the shell's width path through a `width` driver command; equal widths are the gate.
- **Throughput**: a pane runs `cat` of a 50 MB file; the shell stays under its budget, the core under its, the frame time under 32 ms, and the existing `pty:ack` flow control throttles. Decides base64 versus binary frames for `pty:data`.
- **RAM at W10**: `measure-ram.ps1` on the shell's tree (it already walks children, so the wsl.exe tree is included) plus the core RSS row; Edge closed; five samples. Pass under 200 Windows side.
- **Latency**: a divider drag's move-to-model round trip, median under 2 ms over 200 moves.
- **Contracts**: section 9's proofs, scripted.
- **Path matrix**: redesign spec section 7 on real pane output, four rows, screenshot.
- **Aero**: screenshots at 1x of the strip on glass, the sidebar, a sheet, a popover, compared by eye against the Win7 references in the report; colorization change observed live by setting the DWM color and reading the model.

## 11. Phases

**Phase 1, the terminal core.** Core: `wslhost` platform, shim, stdio bridge, the controller for tabs, panes, layout, zoom, find, session restore, settings load, toasts, status bar. Shell: window and glass strip, core lifetime and staging, grids (5.1 to 5.6), tabs, pane title bars, dividers, zoomed pane, restore card, find bar, status bar, toasts, the custom edit widget, the chord table, clipboard copy and paste, the test driver, `measure` support. Gate: W10 measured under 200 on the Windows side, parity corpus green, throughput green, pane env and pid files green, session restore round trip green, a screenshot of 9 tabs on glass. Deliverable: a build Josh can run panes in.

**Phase 2, everything else.** Explorer with watch and reveal, drawer, projects, settings sheet, tutorial, update banner, color and link pickers, attention glow and ping, drag and drop, the menu, path double-click matrix, contract proofs, the inventory walked row by row with each row's check named in the report. Gate: every inventory row checked or listed as deferred with Josh's answer cited.

**Phase 3, cutover.** Aero exactness pass against Win7 references, colorization edge cases, no-glass fallback, packaging (`pack-native.ps1`, the updater reporting `platform: win-native` and declining until a matching asset exists), the `WorkPanel.cs` and `pane-hook.zsh` edits with Josh's go, replacing `Programs\SeaShell` only with his in-the-moment OK to quit the running one.

Each phase is one plan under `docs/superpowers/plans/` and one or more overnight runs with a report in `~/.codex/notes/`.

## 12. Deferred and out of scope

The six other themes, the five pane frames and the CRT effects (Settings shows them greyed with `coming back` in the tooltip); Mac and Linux shells; a C++ port of main; IME composition and screen-reader accessibility; drag out; tab and pane reordering; the shared-memory pty transport (binary frames are the fallback if base64 fails the throughput check); Tauri; per-monitor DPI testing beyond 1x (the code paths exist, Josh's main display is 1x).

Amendment 10/03 04:30 (Josh: "skip adding file viewer, web browser, code editor"): the file preview pane (text, images, PDF), the editor and the web preview pane (inventory K and L and the preview lines of B, C, E, H, I, J, W, X) are not built. Plain double-click on a path reveals it; Ctrl and Ctrl+Alt double-click open the file with the Windows default app; `preview.file` and `web:new` toast `File previews are not in this build` and `Web previews are not in this build`; a restored file or web pane shows the placeholder `Previews are not in this build` and `pane.closeAll` removes it. No WebView2, no Shiki, no `EDIT` control in the native build.

## 13. Risks

1. **Width parity.** If the utf8proc hook and grapheme segmentation do not reproduce xterm.js on the corpus, Claude Code's boxes misalign. Gate in Phase 1; fallback is a width table generated from xterm.js itself and compiled in.
2. **Pipe throughput.** Ten panes of heavy output through one pipe with base64. Measured in Phase 1; binary frames are the fallback.
3. **drvfs for userData.** Atomic rename works on drvfs; inotify does not, so nothing may watch a `/mnt/c` path (the explorer root is the Linux home and is unaffected). Write latency on drvfs is milliseconds; the 30 s snapshot does not care.
4. **One wsl.exe.** If it dies, every pane dies at once. Today each pane dies alone. The shell reports the exit and offers Restart on every pane.
5. **OpenGlass dependence for the look.** Without it the strip is DWM's stock frame; the Win7 control drawing below still applies. Nothing in the app depends on it.
6. **Node in the distro.** Required 24 or newer; present today (26.10). The shell names the fix if it is missing.
7. **Keyboard layouts.** WM_CHAR with dead keys and AltGr on non-US layouts is untested; Josh's layout is US.
8. **Scope.** The inventory is 400 lines. Phase 2 is where features get lost; its gate is the row-by-row walk.

## 14. Decision record (filled by the phase runs)

| Phase | Night(s) | Gate result | Windows tree WS MB at W10 | Core RSS MB | Snapshot |
|---|---|---|---|---|---|
| 1 | 10/02 (15:08 to 18:41, resumed 21:04) | pass: W10, parity, throughput, pane env, pid files, restore round trip, control, nesting; two bars not met: divider latency 8.8 ms per move (bar 2; the core alone 0.32), core RSS back within 30 MB at 90 to 105 s (bar 30 s); report ~/.codex/notes/seashell-native-report-2026-10-02.md | 111.2, then 110.8 on the final build (6 processes, 83.8 and 83.3 private) | 84.7, 84.3 | snapshot/native-after-phase1 |
| 2 | | | | | |
| 3 | | | | | |
