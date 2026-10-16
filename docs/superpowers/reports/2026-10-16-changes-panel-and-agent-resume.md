# Changes panel on a maximized pane, and resume for Jarvis, Ultron and opencode

Branch `claude/seashell-changes-panel-k72w1k`, on top of `redesign/1002` at `b215229`. Nothing was merged or opened as a pull request.

## What was built

### Part A: an agent registry for resume

- `src/shared/agents.ts` is the registry's pure half: one entry per agent (claude, jarvis, ultron, opencode) with its program, its id allowlist, its resume flag and the launcher flags worth keeping. `agentLaunchText` builds `jarvis [--effort L] [--business] --session <uuid>`, `ultron --session <uuid>` and `opencode -s <ses_...>` from fixed parts only; an id that fails its regex, or a flag outside the table, is never typed (the agent starts fresh instead).
- `src/main/state/agents.ts` is the process half: classifying a live process as an agent (`classifyAgentProc`), the pi session format (directory encoding, header, listing), opencode's sessions (read-only `node:sqlite`, falling back to `opencode session list --format json`), `/proc` readers (argv, cwd, the two environment variables that matter, start time from `procStartFromStat`'s field), a macOS `ps` and `lsof` reader for opencode, and the pure picker `pickAgentSessions`.
- `src/main/state/session-lookup.ts` gained two lanes for the other agents (process and carried) beside claude's five, and answers them in a new `agents` field of `projects:sessionIds`. A pane runs one agent, the one nearest its shell; claude wins a tie, so `jarvis-cc` (which execs claude) stays a claude pane through the existing lanes with no special case.
- Saving and restoring (`src/renderer/projects/serialize.ts`, `src/core/controller/session.ts`, `src/core/controller/projects.ts`, the renderer's `app.tsx`): every place that checked `command === 'claude'` or `claudeSessionId` now goes through `lookupPaneFor`, `savedAgentFor`, `applyRestoreIds` and `launchCommandText`, so the restore offer, the Projects sheet, the session snapshot and a pane restart all carry the new agents. The Projects sheet's text and the tutorial say so.
- Old files load exactly as before: `claudeSessionId` keeps its field and its meaning, and a new file still writes it for claude panes (an older build can read a new file). Other agents use `agentSessionId` and `agentFlags`. `savedToPane` now also maps an unknown `command` to `zsh` (it used to pass any string through, which launched nothing anyway).

### Part B: what an agent session changed

`src/main/changes/` (shared by both front ends through `changes:watch`, `changes:list`, `changes:file`, `changes:release`):

- `records.ts` reads each agent's own record: claude's `Write`, `Edit`, `MultiEdit`, `NotebookEdit` calls plus the `toolUseResult` claude stamps on the reply (`type: create | update`, `originalFile`); pi's `write` and `edit` tool calls; opencode's `edit` and `write` parts from `opencode export`. `contentBefore` works out a file's earlier content from the record when it can (claude's `originalFile`, or the recorded edits undone in reverse, only when every one undoes cleanly).
- `shadow.ts` keeps a shadow git repository per session under `<userData>/changes/<key>` and snapshots the session's cwd with `GIT_DIR` and `GIT_WORK_TREE` set, so the user's own repository is never read or written (a test checks its `.git` is untouched). It refuses the home directory, a filesystem root and anything directly under one (`/home`, `/mnt/c`), and anything over 20,000 files or 200 MB (counted first, skipping `node_modules`, `.git`, build output and the root `.gitignore`).
- `tracker.ts` merges the two per file into `{ path, rel, change, added, removed, source: agent | fs | both, at }`, newest first, and serves one file's before and after (text capped at 2 MB, images inlined up to 8 MB, binaries flagged). Transcripts are read incrementally (only the new complete lines), opencode's export at most every 10 seconds.
- `src/shared/line-diff.ts` is a Myers line diff (with a distance cap) used for the counts in main and the views in the page.

### Part C: the zoomed pane's changes column on the native build

- Core (`src/core/controller/changes.ts`, wired into `controller.ts`): when the active tab has a zoomed terminal pane, the panel asks main which agent runs in it (`projects:sessionIds` for that one pane), starts watching the session, and polls the list every 2 seconds. The column shows by itself once the session has a change; the title bar's button (`pane:<id>:changes`) and the chord toggle it, and the user's choice per pane wins over the automatic one. The model carries `ChangesModel` (rects, groups, rows, header, note, empty state, the preview rect); file contents go out only on the new `view:cmd` channel, and the page's messages come back on `view:event` (Phase 2 header decision 4).
- Chord: `Cmd+E` (Ctrl+Shift+E on Windows and Linux), a new View menu item "Toggle Changes Panel" (`changes.toggle`). On a pane that is not zoomed it zooms it and opens the column. It is in the status bar hint and the tutorial's key list, in both builds.
- The preview page (`src/preview/`, bundled by `scripts/build-preview.mjs` into `out/core/preview` and `out/renderer/preview`): a unified diff with syntax highlighting (shiki core with its JavaScript engine, grammars loaded per language), a side by side view, folded unchanged stretches that expand, Source and Preview for Markdown, HTML and SVG, images, deleted files with their last known content, and Open, Reveal, Copy path and close. Rendered content goes into `render.html` in a frame sandboxed with `allow-scripts` and no same origin; that document has its own CSP with no network at all, and links are handed to the host. The page itself has a strict CSP (`default-src 'none'`, scripts only from itself, no `connect-src`).
- Shell: `native/shell/src/ui/changes.cpp` draws the column in Direct2D (header, totals, note, groups, rows with a file glyph, name, dimmed folder, `+N -M` and an A, M or D mark, a Win7 scrollbar, the grip, rounded by the theme radius with `cornerMask` and `roundedStroke`); `native/shell/src/preview_host.cpp` hosts one WebView2 only while a preview is open.

### Part D: the same view in the Electron window

`src/renderer/changes/` reuses the core's `ChangesPanel` unchanged with the window as its host (`useChangesPanel`) and renders the same model (`ChangesColumn`). The preview page is the same page, served as `app://preview/` by main's existing `app` protocol, an origin of its own so the page can never reach the renderer's DOM or preload. A `will-frame-navigate` guard keeps frames on `app://preview` and opens http and https links in the browser, at most one every two seconds.

## Decisions where the brief left a choice

1. **Where the other agents' ids live.** `agentSessionId` and `agentFlags` beside the existing `claudeSessionId`, with `command` naming the agent. Renaming `claudeSessionId` would have broken old files and older builds reading new ones.
2. **Picking a pi or opencode session.** An id on the command line wins outright (`--session`, `--session-id`, `-s`): this is what a restored pane runs, and a resumed session's header is older than the process, so start-time matching alone would lose it after one restore. Otherwise the most recently written session that started after the process did (pi), or that was written after it started (opencode, and a pi run with `--continue` or `--resume`), not claimed by another live process. When another live process of the same agent shares the data dir and cwd and could have created or last written that session, the answer is "no id". Processes under another agent of the same kind (pi's bash tool runs inherit `PI_CODING_AGENT_DIR`) are never counted as agents.
3. **Reading the agent's cwd.** The session's cwd is the agent process's own (`/proc/<pid>/cwd`), falling back to the pane's. The pane's cwd comes from shell integration, which only zsh reports; a bash pane stays at its launch directory.
4. **opencode's database.** Two queries in order (`... AND parent_id IS NULL`, then without it), against the columns `id, directory, time_created, time_updated`. These names are from opencode's schema as I know it and could not be checked against a real 1.18 database here; any failure falls back to the CLI, which the brief documents.
5. **claude's file-history backups are not used.** No transcript available here has `file-history-snapshot` lines, so per the brief nothing depends on them. claude's `toolUseResult.originalFile` (confirmed in a real transcript) gives the before content instead.
6. **Watching cost.** A session's baseline snapshot is taken when SeaShell first sees it: on the 30 second snapshot lookup (which already runs) or when its pane is zoomed. That is one `git add -A` per session, once. Refreshes (a snapshot, a diff and a record read) happen only while a zoomed agent pane is on screen, at most once a second per session, polled every 2 seconds; a zoomed pane is polled even before its column shows, so the column can appear on the first change. Nothing runs for panes that are not zoomed. Shadows unused for 14 days are removed at start.
7. **Layout.** List above, preview below, in the column. With a preview open the list takes what its rows need, between 96 DIP and 40 percent of the column; the rest is the preview. A narrow column (under 640 px, which is 1440 px at 38 percent) wraps the preview's toolbar onto two rows so the path stays readable; at 3440 px the column is 1307 px and side by side fits without horizontal scrolling (checked in headless Chromium).
8. **Rendered HTML runs its scripts.** In `render.html` under its own CSP: inline scripts and styles, `data:` images and fonts, no network, no forms, no same origin, no popups, no top navigation. The brief's "scripts allowed only without same-origin" is read as this; a test checks the scripts run and cannot reach the parent or the network.
9. **WebView2 virtual host:** `seashell-preview.example` (the `.example` TLD can never be a real host), mapped to `resources\preview` beside `SeaShell.exe`, or to `SEASHELL_PREVIEW_DIR` when set. User data folder: `<userData>\webview2`. No `wil`; the code uses WRL's `Callback` and `ComPtr`.
10. **Keyboard inside the preview.** WebView2's own accelerators (reload, find, print) are off; the app's chords still work with the preview focused (`AcceleratorKeyPressed` looks the key up in the model's chord table), except the `edit.*` ones, which stay with the page. A press anywhere in the body takes the keyboard back (a one line `SetFocus` in `window.cpp`).
11. **The preview hides** while a sheet, the restore card, the explorer's menu or a pane popover is up, since those are drawn under a child window.

## Something found on the way

The Electron window did not start at the base commit: React error #310 ("rendered more hooks than during the previous render"). `b215229` added five hooks (the tab and pane drag callbacks and their effect) below `if (!ready) return`, so the hook count changed when the app became ready. The early returns now sit below every hook. This fix is in the Part D commit `f7926c1`.

## Tests

- `npx vitest run`: 134 files, **1360 tests**, all passing (1281 at the base, so 79 new). New files: `test/unit/agents.test.ts`, `test/unit/agent-resume.test.ts`, `test/unit/changes.test.ts`, `test/unit/controller-changes.test.ts`, `test/unit/preview-page.test.ts`, `test/dom/changes-column.test.tsx`. They cover each agent's process matching, session picking (the ambiguous and the claimed-elsewhere cases), id validation with injection attempts (`x; rm -rf ~` and friends), resume command text, an old-format saved file loading unchanged, the shadow snapshot over temp directories (and the user's `.git` left alone), fixture transcripts for all three record formats, the tracker end to end, and the controller's column.
- `npm run typecheck`, `npm run build:core`, `npm run build`: clean.
- `node scripts/preview-check.mjs` (headless Chromium, a fake host posting what the shell posts): 23 checks, all ok. Diff, side by side, highlighting, gaps, the buttons and Escape, file content never parsed as markup, Markdown rendered with raw HTML kept as text, links handed to the host, HTML scripts running but unable to reach the parent or the network, the sandbox attribute, themes, images, deleted files, no request leaving the page.
- `node scripts/core-changes-smoke.mjs`: the built core over stdio, as the shell drives it, with a stand-in agent (`exec -a opencode sleep`): detected on zoom, three changes made by shell commands listed, the file sent on `view:cmd` and absent from `ui:model`, ready, close and un-zoom. All ok.
- `xvfb-run node scripts/electron-changes-check.mjs`: the real Electron window, same stand-in: button, four rows, diff preview, rendered Markdown, closing the preview. All ok.
- C++: every changed file passes `x86_64-w64-mingw32-g++ -std=c++17 -fsyntax-only -Wall` against mingw's Windows and Direct2D headers. The WebView2 SDK could not be downloaded (the NuGet host is blocked here), so `preview_host.cpp` was checked against a hand-written stand-in of only the interfaces it uses, with the SDK's signatures as I know them.

## What I could not verify

- **Nothing native was compiled with MSVC or run.** The C++ is untested beyond the syntax check above. In particular: the vcpkg `webview2` port's CMake names (`find_package(unofficial-webview2 CONFIG REQUIRED)`, `unofficial::webview2::webview2`), every WebView2 call, the virtual host mapping, focus and accelerator handling, the drawn column's look, and the RAM budget.
- **The real agents.** Jarvis, Ultron and opencode do not exist here. The process signatures, `/proc` reads inside Ultron's bwrap sandbox (`environ` and `cwd` of a process in a child user namespace), pi's session directory encoding (`--` + path with `/`, `\` and `:` as `-` + `--`), pi's `edit` arguments beyond `edits` (also accepted: `oldText` and `newText` at the top level), opencode's database columns and `export` output were built from the brief's facts and fixtures.
- **macOS.** The opencode reader for macOS (`ps -o args=`, `lsof -d cwd`) was not run.
- **Electron on Windows** has no tracker (its panes live in WSL behind a UNC path): `changes:list` answers nothing there, so the column only ever shows its empty state if toggled by hand.

## Files changed in the native shell

- `native/shell/src/preview_host.h`, `native/shell/src/preview_host.cpp` (new): the WebView2 host.
- `native/shell/src/ui/changes.cpp` (new): the column view, its scroll, `previewPlacement`, `changesRows`.
- `native/shell/src/ui/ui.h`, `native/shell/src/ui/ui.cpp`: the column in layout and paint, `changes:grip` as a handle (drag, double-click reset, cursor), the list's wheel and scrollbar drag, tooltips, `changes:row:` double-clicks, `chordCommand`.
- `native/shell/src/ui/panes.cpp`: the title bar's changes button.
- `native/shell/src/ui/sidebar.cpp`: `scrollView('changes')`.
- `native/shell/src/model.h`: `ChangesModel`, `ChangeGroupModel`, `ChangeRowModel`, `PaneModel.changes`.
- `native/shell/src/wire.h`, `native/shell/src/wire.cpp`: `view:cmd` in `CORE_PUSH_TO_SHELL` and `onViewCmd`.
- `native/shell/src/app.cpp`: the preview follows every applied model, `view:cmd` goes to the host, the host is destroyed on a dead core and at quit.
- `native/shell/src/window.cpp`: a press in the body takes the keyboard back from the preview.
- `native/shell/src/driver.h`, `native/shell/src/driver.cpp`: `changes`, `previewScript`, `previewResult`.
- `native/shell/CMakeLists.txt`, `native/shell/vcpkg.json`: the `webview2` port.
- `scripts/win/pack-native.ps1`: copies `out\core\preview` to `resources\preview`.

## Windows verification checklist

1. In WSL: `npm ci`, `npm run build:core` (it now also writes `out/core/preview`), then `scripts/win/sync-tree.sh` as usual.
2. Build: `cmd.exe /c C:\seashell-build\redesign\scripts\win\build-shell.cmd`. vcpkg (manifest mode) installs the `webview2` port on the first build. If CMake cannot find `unofficial-webview2`, read the port's usage text (`vcpkg install webview2` prints it) and put its package and target names into `native/shell/CMakeLists.txt`. If the port links the loader as a DLL, check `WebView2Loader.dll` lands beside `SeaShell.exe` (pack-native copies every `*.dll` from the build folder).
3. Pack: `scripts/win/pack-native.ps1`; check `release\win-native\resources\preview\index.html` exists. For a run straight from `shell-build\Release`, copy `out\core\preview` somewhere on C: and set `SEASHELL_PREVIEW_DIR` to it.
4. Start a scratch shell with the test driver (as in the phase 2 plan) and open a pane running an agent: `cd` to a small project and start `jarvis`, `ultron`, `opencode` or `claude`, or for a dry run `(exec -a opencode sleep 600) &`.
5. `node scripts/native-driver.mjs <ud> dblclick '{"target":"pane:<id>:title"}'`, then `model`: within a few seconds `panes[0].changes` is `"off"` and the title bar shows the `±` button. `shot` it.
6. Make changes from the agent or the shell (create, edit, `rm`). `model` again: `changes` is set, `groups` list them; the column is 38 percent of the area. `changes` (driver): the rows and `"column": true`. `shot` at 1440 px and, if available, at 3440 px.
7. `click '{"target":"changes:row:<abs path>"}'`. `changes` (driver): `preview.exists` and then `preview.loaded` true, `url` `https://seashell-preview.example/index.html`, `bounds` inside the column. `previewScript '{"js":"document.querySelectorAll(\"tr.add\").length"}'` then `previewResult '{"id":1}'`: a number above 0. Check the colors follow the theme (switch Graphite and Aero in Settings).
8. Safety: create `page.html` with `<a href="https://example.com">x</a><a href="file:///C:/Windows/win.ini">y</a><script>location.href="https://example.com/auto"</script>` in the project, preview it, Preview mode. `shell.log` must show `preview: frame navigation cancelled` for the file and script navigations, and at most one `open:externalHttp` every two seconds; the preview still answers `previewScript`. Right-click: no context menu. F12, Ctrl+Shift+I, Ctrl+R, Ctrl+P, Ctrl+F inside the preview do nothing; Ctrl+Shift+E still hides the column.
9. Lifetime: close the preview (its `×`, or Escape inside it), un-zoom, toggle the column off, open the Settings sheet over it. After each, `changes` shows `preview.exists` false (or `visible` false for the sheet), and within a few seconds no `msedgewebview2.exe` remains under the shell's tree (Task Manager, or `scripts/win/app-tree.ps1`).
10. RAM: close Microsoft Edge, then `scripts/win/measure-ram.ps1 -RootPid <SeaShell.exe pid> -UdfSubstring webview2 -Label changes-preview-open -CorePid <core pid>` at 10 panes with a preview open, and again with it closed (`-Label changes-preview-closed`). The closed row must be the usual one (no `msedgewebview2.exe` counted); the open row is the preview's cost. If it is high, `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (for example `--renderer-process-limit=1`) can be tried without a rebuild.
11. Resume: with a Jarvis pane started as `jarvis --effort high`, an Ultron pane and an opencode pane, wait 30 seconds (the snapshot), quit, start again and Restore. Each pane types its own resume command (`jarvis --effort high --session <uuid>`, `ultron --session <uuid>`, `opencode -s <ses_...>`) and comes back on its session. Two Jarvis panes in one folder started a few seconds apart: the newer one comes back fresh rather than on the other's session.

## Commits

```
13d640a Resume Jarvis, Ultron and opencode sessions in saved windows through an agent registry
8899b1e Track the files an agent session created, edited and deleted
00347e6 Add the changes column to a zoomed agent pane in the core, with its view channel and chord
821db51 Add the changes preview page with diffs, highlighting and a sandboxed rendered view
1e8fa11 Draw the changes column in the native shell and host the preview in WebView2
f7926c1 Add the changes column and preview to the zoomed pane in the Electron window
7aa6bf4 Stop tracking a pane's agent session when the pane closes
c55fdde Add a headless core smoke for the changes column and keep the preview up while a pane title is only pressed
73b6298 Fix the core changes smoke's missing import
```
