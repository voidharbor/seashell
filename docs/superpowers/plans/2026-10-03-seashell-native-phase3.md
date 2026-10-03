# SeaShell Native Shell, Phase 3 (cutover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the native build needs to replace `Programs\SeaShell` is built, tested and staged overnight, so that in the morning the swap itself is a five-minute checklist run by hand with Josh, with a one-command rollback.

**Architecture:** Unchanged from Phases 1 and 2: `SeaShell.exe` (C++, Direct2D, DWM glass) draws the view model and reports input; the core (today's `src/main` plus the headless controller) runs inside WSL under `/usr/bin/node` and owns every piece of application state. Phase 3 adds no view. It turns the update check on for the installed build, writes the install and rollback scripts, prepares the one outside integration that matches the window class, closes the two bars Phase 2 left open where it can, and runs an exactness pass of the Win7 chrome against the redesign spec's tables and, when cheap, the real Win7 theme bitmaps.

**Tech Stack:** As Phase 2 (C++17, MSVC via `vcvars64.bat`, CMake, vcpkg `utf8proc` and `nlohmann-json`, Direct2D 1.1, DirectWrite, DWM, libvterm; TypeScript, esbuild, vitest; Node 26.10 in Ubuntu 24.04), PowerShell 5.1 for the install scripts, `csc.exe` (.NET Framework 4) for the SC Cockpit rebuild, `7z` and Python `pefile` for the optional Win7 bitmap references.

**Spec:** `docs/superpowers/specs/2026-10-02-seashell-native-design.md` (sections 4.5, 4.8, 6, 9, 10, 11 and 14; the Phase 3 sentence in 11 is the scope), the redesign spec `docs/superpowers/specs/2026-10-02-seashell-redesign.md` sections 6.2 and 6.3 (the Aero values), the Phase 2 report `~/.codex/notes/seashell-native-phase2-report-2026-10-02.md` ("What Phase 3 starts from", "Follow-ups" 1 to 9, "Not verified"), and the Phase 1 report's follow-ups 5, 11 and 12.

**Facts this plan was written against (checked 10/03 18:30):**

- The installed app is `C:\Users\josh\AppData\Local\Programs\SeaShell\` (Electron, `SeaShell.exe` 225 MB, `resources\app.asar`), with no uninstaller and no entry under any `Uninstall` registry key. The only shortcut is `%APPDATA%\Microsoft\Windows\Start Menu\Programs\SeaShell.lnk`, target `...\Programs\SeaShell\SeaShell.exe`, icon `SeaShell.exe,0`. The native exe carries `IDI_APP ICON build\icon.ico` in `native/shell/app.rc`, so the shortcut keeps its icon after the swap.
- Both builds use `%APPDATA%\seashell` as userData (`native/shell/src/paths.cpp:43`). It holds `last-session.json`, `projects.json`, `control.json`, `imported-from-linux.json` and the Chromium folders. Sessions and projects carry over by being there. The Electron build's settings live in `Local Storage` (localStorage key `seashell.settings`) and do not carry over; the native build's `ui-state.json` starts from defaults.
- The updater (`src/main/update/check.ts`, `updater.ts`) asks `api.github.com/repos/voidharbor/seashell/releases/latest` for exactly `SeaShell-<version>-universal.zip` and can install only on darwin in place; on `wslhost` it is `off` (`src/main/platform/wslhost.ts:46`). `UpdateState` is `idle | available {version, pageUrl, canInstall} | downloading | ready | error` (`src/shared/ipc.ts:416`). Version is 0.5.0 (`out/core/VERSION`, `SEASHELL_VERSION_STR`).
- `C:\Users\josh\Desktop\Star Citizen HOTAS\WorkPanel.cs` `FindSeaShell` (line 229) accepts only windows of class `Chrome_WidgetWin_1` (line 234) from a process named `SeaShell` whose path ends in `\AppData\Local\Programs\SeaShell\SeaShell.exe` (line 220). `SCCockpit.exe` is built by the first `csc.exe` line of `build.bat` in that folder and runs as the scheduled task `SC Cockpit` (pid 9572 at 18:30). `~/.config/seashell-work/pane-hook.zsh` keys on `SEASHELL_PANE_ID == pane-*` and `SEASHELL_APP_ID == win32-*`, which the native build already exports (spec 9), so it is expected to need no edit.
- The Win7 Ultimate SP1 x64 ISO is cached at `~/.cache/win7-iso/en_windows_7_ultimate_with_sp1_x64_dvd_u_677332.iso` (sha1 `36ae90defbad9d9539e649b193ae573b77a71c83`, checked by `~/pc-migration/windows/mac-mode/tools/win7_extract.sh`). `7z` is at `/usr/bin/7z`. Python `pefile` is not installed.
- The W10 rows on the Phase 2 build, Edge closed, 18:24 10/03: (a) 109.2 MB working set, core 75.4; (b) sidebar and drawer open 112.3, core 76.0. Bar 200. Phase 1 110.8.

**Decisions this plan makes, for Josh to see before the run** (each can be reversed by a one-line note in the prompt):

1. **The cutover is a folder swap, not an installer.** `install-native.ps1` moves `Programs\SeaShell` to `Programs\SeaShell.electron-<stamp>` and copies the native release in its place; the Start Menu shortcut path does not change; `-Rollback` moves the backup back. No registry entry is written, because the Electron install has none.
2. **The overnight run never performs the swap.** It builds and tests the scripts against a copy under the scratch tree and writes the morning checklist into the report. The swap itself happens by hand with Josh, after he quits his running SeaShell or gives the OK to quit it.
3. **The updater on the installed native build shows the banner but does not install.** It looks for `SeaShell-<version>-win-native.zip` on the latest GitHub release, stays idle when no such asset exists (so the Mac zip is never offered), and when one exists shows `available` with the release page link and `canInstall: false`. A Windows swap script for the updater is Phase 4 work, if ever.
4. **SC Cockpit is rebuilt to `SCCockpit.new.exe` and left there.** Swapping it (stop the pid, rename, `schtasks /run`) is a checklist step, because the running tray app is Josh's and a restart loses its 90 s game edge once.
5. **`pane-hook.zsh` is proven, not edited.** If the proof fails, the fix is made with a `.bak` copy and the diff in the report.
6. **Present-immediately with a refresh-rate paint cap is adopted only if both bars pass** (latency under 2 ms median and the throughput line within Phase 2's figures); otherwise the commit is reverted and the numbers recorded.
7. **Version stays 0.5.0 and nothing is published.** The release zip the run builds is the asset format for a future release; it goes nowhere.
8. **Win7 theme bitmaps are references only.** `aero.msstyles` is read out of the cached ISO into `bakeoff\win7-ref\` for side-by-side comparison; nothing is installed, registered or applied (the 9/29 Defender history).
9. **Settings do not migrate from the Electron build.** First launch of the native build is Aero with default settings; the tab strip follows the Windows app theme; his sessions and projects are there.

## Global Constraints

- Work only in the worktree `~/seashell-wt/redesign` on branch `redesign/1002`. Never commit on `main` (`~/Desktop/seashell` stays at `3746bfe`). Never push anything. Snapshot branches `snapshot/native-<stage>` with `git branch -f` after each stage gate; never pushed.
- Commit messages are ONE line, no attribution of any kind, no trailers. No em dashes anywhere: code, comments, docs, commit messages, UI copy, PowerShell, C#.
- NEVER kill, quit, restart or replace the running `C:\Users\josh\AppData\Local\Programs\SeaShell\SeaShell.exe` or anything holding Josh's panes. Never launch that exe or `~/.local/bin/SeaShell-LEGACY.AppImage`. Never `taskkill /IM`. Never write `%APPDATA%\seashell` or `~/.config/seashell`. Scratch instances only, each with its own `SEASHELL_USER_DATA` under `C:\seashell-build\redesign\scratch\<name>`, launched with `SEASHELL_TEST_PORT=0` so they never take focus.
- **Phase 3 additions.** Never run `install-native.ps1` with `-Live`, and never point it, `uninstall-native.ps1` or any test at the real `Programs\SeaShell`; the scripts are exercised only against copies under `C:\seashell-build\redesign\scratch\`. Never stop, start, rename or replace `SCCockpit.exe`, its process or the `SC Cockpit` scheduled task; the rebuild writes `SCCockpit.new.exe` next to it and stops there. Never edit `pane-hook.zsh` unless Task 3's proof fails, and then with a `.bak-native` copy. Never download the Win7 ISO; use the cached one or skip the reference step. Never write under `~/.cache/seashell-work/` except the `next-pane` request file Task 3 names, and remove what Task 3 writes.
- The kill guard (`~/.claude/bin/seashell-kill-guard.sh`) blocks any kill verb in a command whose text mentions "seashell" unless the command also mentions `release/`. Stop a scratch shell through the driver's `quit` command, or by pid with `scripts/win/stop-tree.ps1 -RootPid <pid>` in a command that names its `release/win-native` path, never by image name. Scratch shells launch only from `C:\seashell-build\redesign\release\win-native\`.
- Never type into a pane while a `claude` process is on its tty unless the step says so. `scripts/native-gates.mjs` has the tty check; every gate that types reuses it.
- Windows work runs from WSL through `powershell.exe -NoProfile` or `cmd.exe /c`, every command starting with `cd /d C:\...` or `Set-Location C:\...` and using absolute `C:\` paths (a WSL cwd is UNC to Windows and silently becomes `C:\Windows`). The build tree is `C:\seashell-build\redesign\`, an rsync of the worktree by `scripts/win/sync-tree.sh`; run it before every Windows-side build. Nothing under `C:\AI\`. Nothing copied into `Programs\SeaShell`.
- Native builds: `cmd.exe /c C:\seashell-build\redesign\scripts\win\build-shell.cmd`; package with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\seashell-build\redesign\scripts\win\pack-native.ps1`. The full rebuild is `node scripts/build-core.mjs && scripts/win/sync-tree.sh && <build-shell.cmd> && <pack-native.ps1>`. `pack-native.ps1` stays the only route that writes `BUILD`.
- The core is built and run with WSL's own node (`/usr/bin/node`, 26.10).
- Gates before any snapshot: `npm run typecheck && npm test` clean in the worktree, plus the stage's Windows gate named in the task. Run one vitest file as `npx vitest run <path> --project unit` (or `--project dom`). Do not `git add -A`; add files by name.
- Agents run in the FOREGROUND: no `run_in_background`, no Monitor, no wakeups, and no turn ends while a background task runs (a headless session is terminated 600 s after such a turn; it killed the first Phase 2 session). Every subagent is given `model: "opus"` explicitly unless the ultracode-lite ladder assigns a cheaper tier for a mechanical step.
- Microsoft Edge must be closed during any RAM measurement; `run-native-w10.ps1` refuses otherwise. Close nothing you did not start: if Edge is open, record "not measured, Edge was open" and continue.
- After every task that ends a stage, append a section to `~/.codex/notes/seashell-native-phase3-report-2026-10-04.md` (Task 8 defines the sections) so a cut-off run still reports.
- The W10 workload, counting rules and the 200 MB bar are redesign spec section 2 and spec section 4.7 and are not reinterpreted. The latency bar is spec 10: a divider move to its model, median under 2 ms over 200 moves.
- Target ids keep the Phase 1 grammar in `src/core/controller/model.ts`. The shell computes no application layout.

## Review Focus

1. **The install script aimed at the live install by mistake.** With `-Target` defaulted or equal to `%LOCALAPPDATA%\Programs\SeaShell` and no `-Live`, it must refuse before touching anything, and with `-Live` it must still refuse while a process runs from that path. Task 2 step 1 tests both through `-DryRun` on the real path (which only evaluates the guards) and a running copy under scratch.
2. **The updater offering the Mac zip to the Windows build.** A release whose only asset is `SeaShell-<v>-universal.zip` must leave the win-native build `idle` with no banner. Task 1 step 1 tests `parseRelease` per channel and step 4 drives a scratch against a local release JSON with and without the asset.
3. **An update banner on a scratch or dev build.** Only the installed path (`...\AppData\Local\Programs\SeaShell\SeaShell.exe`) turns the check on; a scratch stays `off` unless test mode asks. Task 1 step 1 tests the platform flag.
4. **The paint cap adding latency to a single event, or starving under a flood.** One divider move must still paint at once; a 50 MB flood must still bound the paint rate and the shell's working set. Task 4 step 3 gates both before the commit is kept.
5. **`WM_SETTINGCHANGE` with a null or foreign `lParam`.** The shell must not read a null pointer and must re-read the app theme only for `ImmersiveColorSet`. Task 5 step 1 drives null, `Policy` and `ImmersiveColorSet` through the driver.

---

## Stage K: the cutover pieces (Tasks 1 to 3)

### Task 1: The updater on win-native

**Files:**
- Modify: `src/main/update/check.ts` (`UpdateChannel`, `assetNameFor`, `parseRelease(json, origin, channel)`), `src/main/update/updater.ts` (`UpdaterDeps.channel`), `src/main/platform/types.ts` (`updateChannel?: UpdateChannel`), `src/main/platform/wslhost.ts` (`updater` from the installed flag, `updateChannel: 'win-native'`), `src/main/index.ts` (passes `channel: platform.updateChannel ?? 'universal'` to the Updater), `src/core/electron-shim.ts` (the shim's `app.isPackaged` answers true only when `SEASHELL_INSTALLED` is `1`), `native/shell/src/core_proc.cpp` (sets `SEASHELL_INSTALLED=1` in the core's env when the shell's own path from `GetModuleFileNameW` ends, case-insensitively, with `\AppData\Local\Programs\SeaShell\SeaShell.exe`, or when test mode is on and the shell's environment has `SEASHELL_TEST_INSTALLED=1`), `scripts/win/pack-native.ps1` (`-Zip` switch)
- Test: `test/unit/update-check.test.ts` (extend), `test/unit/platform-wslhost.test.ts` (extend or create next to the existing wslhost tests; `ls test/unit | grep wslhost` names the file)

**Interfaces:**
- Consumes: `parseRelease`, `isNewer`, `RELEASE_ORIGIN` (`check.ts`), `Updater` and `UpdaterDeps` (`updater.ts`), the `test:update` injection and the banner model from Phase 2 Task 14, the driver's `model`.
- Produces: `export type UpdateChannel = 'universal' | 'win-native'`; `export function assetNameFor(version: string, channel: UpdateChannel): string` returning `SeaShell-${version}-universal.zip` or `SeaShell-${version}-win-native.zip`; `parseRelease(json, origin = RELEASE_ORIGIN, channel: UpdateChannel = 'universal')` returning null when the channel's asset is absent; `UpdaterDeps.channel?: UpdateChannel` (default `'universal'`), with `canInstall` unchanged (darwin in place only), so a win-native `available` always has `canInstall: false`; `Platform.updateChannel?: UpdateChannel`; on `wslhost`: `updater: io.installed ? 'on' : 'off'` where `WslhostIo.installed: boolean` is `process.env.SEASHELL_INSTALLED === '1'`, and `updateChannel: 'win-native'`. `pack-native.ps1 -Zip` writes `C:\seashell-build\redesign\release\SeaShell-<VERSION>-win-native.zip` containing a top-level `SeaShell\` folder with the exe, the DLLs, `resources\` and the two scripts from Task 2 (`install-native.ps1`, `uninstall-native.ps1`); the zip is never uploaded.

- [ ] **Step 1: Failing tests**

Append to `test/unit/update-check.test.ts`:

```ts
import { assetNameFor, parseRelease } from '../../src/main/update/check.js'

const release = (names: string[], version = '9.9.9') => ({
  tag_name: `v${version}`,
  html_url: `https://github.com/voidharbor/seashell/releases/tag/v${version}`,
  assets: names.map((name) => ({ name, size: 1234, browser_download_url: `https://github.com/voidharbor/seashell/releases/download/v${version}/${name}` })),
})

describe('update channels', () => {
  it('names the asset per channel', () => {
    expect(assetNameFor('0.5.0', 'universal')).toBe('SeaShell-0.5.0-universal.zip')
    expect(assetNameFor('0.5.0', 'win-native')).toBe('SeaShell-0.5.0-win-native.zip')
  })
  it('a release with only the Mac zip is nothing to a win-native build', () => {
    const r = release(['SeaShell-9.9.9-universal.zip'])
    expect(parseRelease(r)?.version).toBe('9.9.9')
    expect(parseRelease(r, undefined, 'win-native')).toBeNull()
  })
  it('a release with the win-native zip is seen only by the win-native build', () => {
    const r = release(['SeaShell-9.9.9-universal.zip', 'SeaShell-9.9.9-win-native.zip'])
    expect(parseRelease(r, undefined, 'win-native')?.zipUrl.endsWith('SeaShell-9.9.9-win-native.zip')).toBe(true)
    expect(parseRelease(r)?.zipUrl.endsWith('SeaShell-9.9.9-universal.zip')).toBe(true)
  })
})
```

In the wslhost platform test file (the one that builds a platform with a fake `WslhostIo`; add `installed` to the fake):

```ts
  it('checks for updates only when installed, on the win-native channel', () => {
    expect(createWslhost({ ...io, installed: false }).updater).toBe('off')
    const p = createWslhost({ ...io, installed: true })
    expect(p.updater).toBe('on')
    expect(p.updateChannel).toBe('win-native')
  })
```

Run: `npx vitest run test/unit/update-check.test.ts --project unit` Expected: FAIL (`assetNameFor` is not exported; `parseRelease` ignores the third argument).

- [ ] **Step 2: Implement**

Per Interfaces. In `updater.ts` the `available` branch passes `this.d.channel ?? 'universal'` to `parseRelease`; nothing else in the download or install paths changes (win-native never reaches them because `canInstall` is false and the banner has no Install). In `index.ts` the shim-side `isPackaged` must be the one the Updater sees (`new Updater({ ... isPackaged: app.isPackaged ... })` already reads it). Run: `npx vitest run test/unit/update-check.test.ts test/unit/*wslhost*.test.ts test/unit/controller-update.test.ts --project unit && npm run typecheck` Expected: PASS, clean.

- [ ] **Step 3: The shell flag and the zip**

`core_proc.cpp`: compute `installed` once at start (the exe path from `GetModuleFileNameW`, compared case-insensitively against the suffix `\AppData\Local\Programs\SeaShell\SeaShell.exe`; in test mode `SEASHELL_TEST_INSTALLED=1` in the shell's environment also counts) and add `SEASHELL_INSTALLED=1` to the core's environment when true; log `installed: 1` or `installed: 0` once. `pack-native.ps1 -Zip`: after the normal pack, build the zip with `Compress-Archive` from a staging folder `release\zip-stage\SeaShell\` that holds a copy of `release\win-native\*` plus `scripts\win\install-native.ps1` and `scripts\win\uninstall-native.ps1` (Task 2 creates them; until it has, pack without `-Zip`). Rebuild (core, sync, shell, pack). Expected: `shell.log` of a scratch shows `installed: 0`.

- [ ] **Step 4: Driver check**

In WSL: write `/tmp/claude-1001/.../release-with.json` and `release-without.json` from the `release()` shape above (version `9.9.9`; with and without `SeaShell-9.9.9-win-native.zip`), serve the folder with `python3 -m http.server 8765 --bind 127.0.0.1` in a foreground Bash call that also runs the checks and then stops the server (`kill %1` on the server's job, no "seashell" in that command). Launch scratch `k1` with `SEASHELL_TEST_INSTALLED=1`, `SEASHELL_UPDATE_API=http://127.0.0.1:8765/release-with.json`, `SEASHELL_UPDATE_ORIGIN=http://127.0.0.1:8765/`, and `SEASHELL_NO_UPDATE_CHECK` unset (the shell passes `SEASHELL_UPDATE_*` from its own environment through to the core; add that passthrough in `core_proc.cpp` if it is not there). Expected after 10 s: `model` shows the update banner `available` for `9.9.9` with the page link and no Install button; `shot` to `bakeoff\P3-update-banner.png`. Quit. Launch `k1b` the same way against `release-without.json`. Expected after 10 s: no banner, `update:state` idle. Quit. Launch `k1c` without `SEASHELL_TEST_INSTALLED`. Expected: `shell.log` `installed: 0`, no request reaches the server (the server log shows none), no banner. Quit.

- [ ] **Step 5: Commit**

```bash
git add src/main/update/check.ts src/main/update/updater.ts src/main/platform/types.ts src/main/platform/wslhost.ts src/main/index.ts native/shell/src/core_proc.cpp scripts/win/pack-native.ps1 test/unit/update-check.test.ts
git add test/unit/*wslhost*.test.ts src/core/electron-shim.ts
git commit -m "Check for win-native releases on the installed build only"
```

---

### Task 2: The install and rollback scripts

**Files:**
- Create: `scripts/win/install-native.ps1`, `scripts/win/uninstall-native.ps1`, `scripts/win/test-install-native.ps1`

**Interfaces:**
- Consumes: `release\win-native\` as `pack-native.ps1` leaves it (`SeaShell.exe`, `utf8proc.dll`, `resources\core\index.cjs`, `resources\core\VERSION`, `resources\core\BUILD`, `resources\stage-core.sh`).
- Produces `install-native.ps1 [-Source <dir>] [-Target <dir>] [-Live] [-DryRun]`: `-Source` defaults to `C:\seashell-build\redesign\release\win-native`, `-Target` to `$env:LOCALAPPDATA\Programs\SeaShell`. Guards, in this order, each printing one line and exiting with its code: (2) `-Target` is the default live path and `-Live` was not given; (3) a process runs with `ExecutablePath` equal to `$Target\SeaShell.exe` (by path through `Win32_Process`, never by name); (4) `-Source` lacks any of the six files above. `-DryRun` evaluates the guards, prints `would install <Source> over <Target> (backup <backup path>)` and exits 0 (or the guard's code) without creating, moving or copying anything. Otherwise: backup name `<Target>.electron-<yyyyMMdd-HHmm>` when `$Target\resources\app.asar` exists, else `<Target>.native-<stamp>`; `Move-Item $Target $backup`; `Copy-Item -Recurse $Source $Target`; verify the sha256 of `$Target\SeaShell.exe` equals the source's; write `$Target\INSTALLED.json` with `{ version (resources\core\VERSION), build (resources\core\BUILD), source, backup, installedAt }`; print `installed <version> <build>; rollback: powershell -ExecutionPolicy Bypass -File <this script> -Rollback -Target <Target>`. `-Rollback`: the newest sibling matching `<Target>.electron-*` or `<Target>.native-*`; guard (3) again; `Move-Item $Target "<Target>.rolledback-<stamp>"`; `Move-Item $backup $Target`; print `rolled back to <backup>`. Nothing touches shortcuts, the registry or `%APPDATA%\seashell`.
- Produces `uninstall-native.ps1 [-Target <dir>] [-Live]`: guards (2) and (3); if an `INSTALLED.json` names a backup that still exists, it is the same as `-Rollback`; otherwise it removes `$Target` after moving it to `<Target>.removed-<stamp>`.
- Produces `test-install-native.ps1`: builds a fake target under `C:\seashell-build\redesign\scratch\fake-programs\SeaShell` holding `resources\app.asar` (an empty file) and `SeaShell.exe` (a copy of `C:\Windows\System32\cmd.exe`, so a process can run from it), then: (a) `-DryRun -Target <the real live path>` without `-Live` exits 2 and the real folder's listing and mtimes are unchanged (compared before and after); (b) `-DryRun` on the fake target exits 0 and creates nothing; (c) starts the fake `SeaShell.exe` (`cmd.exe /c pause` under that path, `Start-Process` with `-WindowStyle Hidden`), runs the install, expects exit 3, stops only that pid; (d) runs the install, expects exit 0, `INSTALLED.json` present, the backup folder present with `app.asar` inside, the target's `SeaShell.exe` sha equal to the source's; (e) `-Rollback`, expects exit 0, `app.asar` back under the target, a `.rolledback-` folder present; (f) removes the fake tree. Prints one `ok` or `FAIL` line per letter and exits non-zero on any FAIL.

- [ ] **Step 1: Write the three scripts and run the test**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Location C:\seashell-build\redesign; & C:\seashell-build\redesign\scripts\win\test-install-native.ps1"` (after `scripts/win/sync-tree.sh`). Expected: six `ok` lines. The real `Programs\SeaShell` is read (listing, mtimes) in (a) and never written; say so in the report with the before and after listing hash.

- [ ] **Step 2: The zip**

Rebuild with `pack-native.ps1 -Zip` (Task 1 step 3's switch). Expected: `release\SeaShell-0.5.0-win-native.zip` exists, `Expand-Archive` to a scratch folder shows `SeaShell\SeaShell.exe`, `SeaShell\install-native.ps1` and `SeaShell\resources\core\BUILD`; record the size.

- [ ] **Step 3: Commit**

```bash
git add scripts/win/install-native.ps1 scripts/win/uninstall-native.ps1 scripts/win/test-install-native.ps1 scripts/win/pack-native.ps1
git commit -m "Add the native install, rollback and uninstall scripts"
```

---

### Task 3: SC Cockpit and the pane hook

**Files:**
- Modify (outside the repo, with a backup): `C:\Users\josh\Desktop\Star Citizen HOTAS\WorkPanel.cs` (copy to `WorkPanel.cs.bak-native` first)
- Create (outside the repo): `C:\Users\josh\Desktop\Star Citizen HOTAS\SCCockpit.new.exe`
- Create: `scripts/native-panehook.mjs`

**Interfaces:**
- Consumes: `WorkPanel.cs` lines 9 to 10, 217 to 234 (`FindSeaShell`: class `Chrome_WidgetWin_1`, process name `SeaShell`, path suffix `SEASHELL_EXE`), the first `csc.exe` line of `build.bat`; `~/.config/seashell-work/pane-hook.zsh` (the `next-pane` claim: `<id> <command> win32-<pid>`, 8 s, whitelist `ccli gptcli gemcli occli jarvis ultron`, log at `~/.cache/seashell-work/log`); the driver's `text`, `command pane.new`, `model`.
- Produces: `FindSeaShell` accepts a window whose class is `Chrome_WidgetWin_1` or `SeaShellHost` (one comparison, the comment at 217 and the header at 9 to 10 updated to name both), everything else unchanged; `SCCockpit.new.exe` built from the edited source with `build.bat`'s first `csc.exe` line and only `/out:SCCockpit.new.exe` changed, never run. `node scripts/native-panehook.mjs` launches scratch `k3` (one zsh pane), reads the pane's `SEASHELL_APP_ID` and `SEASHELL_PANE_ID` by typing `echo $SEASHELL_APP_ID $SEASHELL_PANE_ID` after the tty check, then three claims, each written to `~/.cache/seashell-work/next-pane` immediately followed by the driver's `command pane.new`: (1) `p3a notalisted win32-<scratch shell pid>` expects, within 5 s, a `log` line `p3a refused, not on the list: notalisted` whose `pane` is a pane id that did not exist before the `pane.new`; (2) `p3b ccli win32-1` expects `p3b refused, request is for SeaShell 'win32-1'`; (3) a file written 10 s before the `pane.new` with `p3c notalisted win32-<pid>` expects `p3c stale`. Never a whitelisted command with the right pid. It removes any `next-pane` and `claimed.*` it created, prints one line per claim and quits the scratch.

- [ ] **Step 1: Edit, build, keep**

Copy `WorkPanel.cs` to `WorkPanel.cs.bak-native`; make the edit; run the `csc.exe` line through `cmd.exe /c "cd /d "C:\Users\josh\Desktop\Star Citizen HOTAS" && <the line with /out:SCCockpit.new.exe>"`. Expected: `SCCockpit.new.exe` exists, larger than 100 KB, newer than `SCCockpit.exe`; `SCCockpit.exe` and pid 9572 untouched (check the pid's start time before and after). Record the diff of `WorkPanel.cs` in the report.

- [ ] **Step 2: The pane hook proof**

Run: `node scripts/native-panehook.mjs` Expected: three `ok` lines; `~/.cache/seashell-work/next-pane` absent afterwards. If the hook does not fire in the fresh pane (no log line within 5 s), read `pane-hook.zsh`'s conditions against the pane's env printed in the first step and report the exact mismatch; edit only then, with the `.bak-native` copy.

- [ ] **Step 3: Stage K gate, snapshot, report**

`npm run typecheck && npm test` green; Task 1's three driver checks and Task 2's six lines green; Task 3's three lines green. Append "Stage K" to the report (the banner PNG, the install test lines and the real folder's unchanged hash, the `WorkPanel.cs` diff, the hook lines). Then:

```bash
git add scripts/native-panehook.mjs
git commit -m "Prove the pane hook on the native build"
git branch -f snapshot/native-after-cutover-pieces
```

---

## Stage L: the two bars and the look (Tasks 4 to 6)

### Task 4: Present immediately, with a paint cap

**Files:**
- Modify: `native/shell/src/gfx.cpp` (the body render target at lines 28 and 33 gets `D2D1_PRESENT_OPTIONS_IMMEDIATELY`; the strip target is unchanged), `native/shell/src/window.cpp` (`invalidateBody` coalesces through a frame timer), `native/shell/src/driver.cpp` (`stats` gains `paint: { perSecondMax, frames, refreshHz }`), `scripts/native-gates.mjs` (the throughput line prints `paintMax=<n>/s`)

**Interfaces:**
- Consumes: Phase 2's `stats.modelMs` (`queue`, `paint`, `bodyDraw`), the `latency` and `throughput` gate lines, the Stage F finding (the body's `EndDraw` waits for the 120 Hz refresh; present-immediately read 1.25 to 1.30 ms per move on the same build).
- Produces: `Window::refreshHz()` from `EnumDisplaySettingsW(monitorDeviceName, ENUM_CURRENT_SETTINGS)` for the window's monitor, re-read on `WM_DISPLAYCHANGE` and `WM_DPICHANGED`, 60 when unknown; `kFrameMs = 1000.0 / refreshHz`. `Window::invalidateBody()`: if at least `kFrameMs` has passed since the last body paint ended, `InvalidateRect` now; otherwise arm a one-shot timer for the remainder (coalescing every call until it fires) and `InvalidateRect` from the timer. A single event therefore paints at once; a flood paints at most once per frame. The `stats.paint` block counts body paints per wall second over the last 5 s (`perSecondMax`), the total since start (`frames`) and `refreshHz`.

- [ ] **Step 1: Baseline on the current build**

On a fresh scratch `l4`: three `latency` runs and one `throughput` run through `run-native-gates.ps1 -Name l4base -Gates 'latency,throughput'`. Record the medians, the p95s, `shellWs peak`, `floodFrames`.

- [ ] **Step 2: Implement, rebuild**

Per Interfaces. Rebuild (sync, shell, pack).

- [ ] **Step 3: Gate and decide**

`run-native-gates.ps1 -Name l4 -Gates 'latency,throughput'` three times. Keep the commit only if all three latency medians are under 2 ms AND every throughput line stays within Phase 2's figures (p95 under 10 ms, `shellWs peak` under 80 MB, `paintMax` at most `refreshHz + 5`). Otherwise `git revert` the commit (its own one-line message, `Revert the present-immediately paint path`) and record all six runs in the report as follow-up 1 continued. Also run `nesting` and `restore` once on the kept build. Expected either way: the numbers in the report, and `P3-latency.json` (the gate's json copied) in `bakeoff\`.

- [ ] **Step 4: Commit**

```bash
git add native/shell/src/gfx.cpp native/shell/src/window.cpp native/shell/src/window.h native/shell/src/driver.cpp scripts/native-gates.mjs
git commit -m "Present the body immediately and cap paints at the refresh rate"
```

---

### Task 5: Colorization edge cases and the no-glass fallback

**Files:**
- Modify: `native/shell/src/driver.cpp` (`settingChange { lparam: string | null }` posts `WM_SETTINGCHANGE` to the scratch's own window only, `wParam 0`, `lParam` a pointer to the wide string or 0), `native/shell/src/window.cpp` (the `WM_SETTINGCHANGE` handler compares `lParam` only when non-null), `src/core/controller/colorization.ts` and `tests` only if a check below finds a wrong colour
- Create: `scripts/native-colors.mjs`

**Interfaces:**
- Consumes: the driver's `colorization { argb, appsDark }`, `composition { on }`, `model`, `shot`, `click sheet:settings:accent:<id>`, `command app.settings`; `colorizationToTokens`, `textOn`.
- Produces `node scripts/native-colors.mjs`, scratch `l5`, one line per check: (1) `colorization { argb: '#FF0078D7' }` (Windows 10 blue): `tokens.accent` `#0078D7`, `frame` the 43 percent blend over `#D9D9D9`, `frameText` white or dark by `textOn`; shot `P3-color-blue.png`. (2) `#FFFFB900` (yellow): `tabText` and `frameText` are the dark text (`#1D0F22`), never white on yellow; shot `P3-color-yellow.png`. (3) `#FF000000`: every `*Text` token is readable on its background by the WCAG 4.5 rule computed in the script from the returned hexes. (4) `colorization { argb: null }` after an override: the 6.2 table (`accent #881798`). (5) the accent override survives: `click sheet:settings:accent:0a84ff`, then `colorization { argb: '#FF0078D7' }`, `tokens.accent` still `#0a84ff`; then `accent:default` restores the colorization's accent. (6) `settingChange { lparam: null }` and `settingChange { lparam: 'Policy' }`: the shell stays up and `tokens.stripDark` does not change; `settingChange { lparam: 'ImmersiveColorSet' }` with `colorization { appsDark: true }` set before it: `stripDark` becomes `'1'` through the message path (the driver override feeds the re-read). (7) `composition { on: false }` light and dark (`tabStrip` `light` then `dark` through the sheet): `model.tokens.composition` `'0'`, shots `P3-noglass-light.png` and `P3-noglass-dark.png`, and `rect` of the strip shows the right 138 DIP left to DWM (the shell's strip rect width is the client width minus 138 DIP); composition back on. (8) a DPI note only: `window.uiScale` stays 1 on the main display (per-monitor DPI beyond 1x stays deferred, spec 12).

- [ ] **Step 1: Driver support, the script, run**

Per Interfaces. Run: `node scripts/native-colors.mjs` Expected: eight `ok` lines. A wrong colour is fixed in `colorization.ts` with its test (the existing `test/unit/colorization.test.ts` gains the case) and its own commit before the script is re-run.

- [ ] **Step 2: Commit**

```bash
git add native/shell/src/driver.cpp native/shell/src/window.cpp scripts/native-colors.mjs
git commit -m "Drive the colorization and no-glass paths from the test driver"
```

---

### Task 6: The Aero exactness pass and the copy

**Files:**
- Modify: `native/shell/src/driver.cpp` (`pixels { points: [{ x, y }] }`: one `PrintWindow` capture with `PW_RENDERFULLCONTENT`, returns `{ colors: ['#RRGGBB', ...] }` for window DIP coordinates), `native/shell/src/ui/painter.cpp`, `native/shell/src/ui/tabs.cpp`, `native/shell/src/ui/scrollbar.cpp`, `native/shell/src/ui/popup.cpp`, `native/shell/src/ui/sheet.cpp`, `native/shell/src/ui/status.cpp` (only where a check below is off), `src/core/controller/tutorial-steps.ts` (the copy)
- Create: `scripts/native-aero.mjs`, `scripts/win7-refs.sh`

**Interfaces:**
- Consumes: redesign spec 6.3 (buttons: 1 px `#707070` border, 3 px radius, face `#f2f2f2` 0 percent, `#ebebeb` 50 percent, `#dddddd` 50 percent, `#cfcfcf` 100 percent, hover `#eaf6fd`, `#d9f0fc`, `#bee6fd`, `#a7d9f5`; scrollbars 17 px with button faces; tabs: 5 px top radius, 1 px `#8e8f8f` border, inactive `#f2f2f2` to `#dcdcdc`, active `#ffffff` to `#f3f3f3`; status bar `#f7f7f7` to `#ececec` with a 1 px `#a0a0a0` top line; menus `#f0f0f0` face, `#979797` border, highlight `#dcebfc` with `#7da2ce`, separators `#e0e0e0` over `#ffffff`; cards `#f0f0f0`, `#a0a0a0`, 6 px radius; Segoe UI 9 pt), the driver's `rect { target }`, `model`, `command app.settings`, `click`, the Phase 2 PNGs.
- Produces `node scripts/native-aero.mjs`, scratch `l6`, with the light tab strip and the colorization override `#FF881798` so the expected values are the spec's: for each control it finds the rect from the model or the driver, samples the named points and compares to the expected hex with a tolerance of 3 per channel, printing `aero: <control> <point> ok` or `aero: <control> <point> got #xxxxxx want #yyyyyy`. Controls and points: a Win7 button (the Settings sheet's `Done`: border pixel on the left edge at mid height, face at 25 and 75 percent of its height at mid width, and after `hover` is not drivable, the pressed state through `down` without `up` at 25 and 75 percent); the inactive tab (face at 20 and 80 percent of height, the top border row); the active tab (face at 20 percent, the bottom row equal to `body`); the status bar (top line, 20 and 80 percent); the sidebar scrollbar (track mid, the up arrow button's face at 25 and 75 percent, the thumb mid); the explorer context menu after `click sidebar:row:<home> button 2` (face, border, highlight row after `key Down`); the restore card is not reachable here, so the sheet card stands in (face, border row, a corner pixel inside the 6 px radius that must equal the dim colour under it); the sheet's check box (border `#8e8f8f`). Fonts: `painter.cpp` creates its text formats with `L"Segoe UI"` at `12.0f` DIP (9 pt) for chrome text and the terminal's own font for grids; the script greps nothing, the implementer confirms it in the report. `scripts/win7-refs.sh <iso> <dest>`: verifies the ISO sha1 (the same constant as `win7_extract.sh`), extracts `sources/install.wim` and from image 4 `Windows/Resources/Themes/Aero/aero.msstyles` with `7z`, installs `pefile` into `~/.venvs/design` (`~/.venvs/design/bin/python -m pip install pefile`), dumps every `IMAGE` resource whose bytes start with `\x89PNG` or `BM` to `<dest>/<id>.png` or `.bmp`, and writes `<dest>/INDEX.txt` (id, size, dimensions). Time box 30 minutes for the whole step; if the wim extraction has not finished by then, stop it, say so, and skip the montage.

- [ ] **Step 1: The driver's `pixels`, the script, the pass**

Per Interfaces. Rebuild. Run: `node scripts/native-aero.mjs` Expected: every line `ok`. Each `got/want` is fixed in the owning painter file (gradient stops, border colours, radii) with one commit per control, then the script is re-run; a difference that the spec itself leaves open (a point inside an anti-aliased radius) is reported, not forced.

- [ ] **Step 2: The references (time-boxed)**

Run: `scripts/win7-refs.sh ~/.cache/win7-iso/en_windows_7_ultimate_with_sp1_x64_dvd_u_677332.iso /mnt/c/seashell-build/redesign/bakeoff/win7-ref` Expected: an `INDEX.txt` with a few hundred images. Pick by eye in the index the push button strip (the five-state horizontal strip around 13 px tall), the tab strip, the scrollbar arrows and thumb, the check box strip and the menu highlight; compose `bakeoff\P3-aero-montage.png` with `~/.venvs/design/bin/python` and Pillow: for each control a row of (our crop at 1x from `shot`, the reference state scaled 1x) with labels. Name in the report the two or three visible differences, with the values involved, and fix those that are plain constants (a stop colour, a border) in the same commits as step 1; leave shape differences (Win7's button bevel highlight line, tab corner shading) as follow-ups with the montage as evidence.

- [ ] **Step 3: The tutorial copy**

`tutorial-steps.ts`: the path-click step (lines 76 and 83) says `Ctrl+double-click opens it with the default app` instead of the preview; the step `Previews are panes, not windows` (line 124) is replaced by a step about the shell drawer, naming the chord `chords.ts` maps to the drawer toggle (read the table; the step prints it through `k()` like the others) with two key rows; the theme sentence, if any step mentions seven themes, says `Aero Glass in this build; the other themes return later`. The step count stays 12 so the dots and the `tutorial` tests hold, or the tests are updated in the same commit. Run: `npx vitest run test/unit/controller-tutorial*.test.ts --project unit && npm run typecheck` Expected: PASS.

- [ ] **Step 4: Stage L gate, snapshot, report**

`npm run typecheck && npm test` green; `scripts/native-colors.mjs` and `scripts/native-aero.mjs` all `ok`; the Task 4 decision recorded; the Aero PNG set at 1x: `P3-glass-strip.png` (nine tabs on glass, light), `P3-tabs-dark.png`, `P3-settings.png`, `P3-menu.png`, `P3-button-states.png` (normal, pressed, disabled from the sheet), `P3-aero-montage.png` if made. Append "Stage L". Then:

```bash
git add native/shell/src/driver.cpp native/shell/src/ui scripts/native-aero.mjs scripts/win7-refs.sh src/core/controller/tutorial-steps.ts test/unit
git commit -m "Match the Win7 control values and update the tutorial copy"
git branch -f snapshot/native-after-aero
```

---

## Stage M: hygiene, the gate, the checklist (Tasks 7 and 8)

### Task 7: Small fixes and the inventory walk's corrections

**Files:**
- Modify: `scripts/native-inventory.mjs` (follow-up 3 a, c, d, e, f), `scripts/native-gates.mjs` (the shared tty check fails closed), `src/core/controller/session.ts` and `test/unit/controller-session.test.ts` (follow-up 3 b), `src/main/platform/wslhost.ts` (the pane pid file of this host is removed at quit), `src/core/controller/controller.ts` or the bridge (`invokeShell` gets a 10 s timeout that rejects with `ETIMEOUT`), `native/shell/src/window.cpp` (`window-bounds.json` written and read in DIPs, dividing and multiplying by the window's DPI scale, same keys as Electron)

**Interfaces:**
- Consumes: Phase 2 follow-up 3's list, Phase 1 follow-up 11's items named here, `app.tsx:570-634` (the 30 s snapshot when the session changed).
- Produces: (a) the tty check returns `refuse` when the pane's pid file is missing or unreadable (a drawer pty has none), and every typing path in the walk and the gates honours it; (b) `test/unit/controller-session.test.ts` gains, with fake timers, `writes the session snapshot 30 s after a change and not when nothing changed` (two ticks, one write; a third tick with no change, no write), fixing `session.ts` if the cadence is wrong; (c) the 34 rows the walk marked `ok` by inference print `ok (via <row>)` with the row they derive from, or are driven; (d) C2, C5 (closing a tab's last pane), D5, D6, D9, F8 and X18 get the tighter checks follow-up 3d names; (e) F6 is relabelled unit, V4 ok, V2 split, R2 and R4 split (palettes and accent built); E3 drives the native 4 px and 500 ms de-dup, H8 the find anchor under streaming output, C7 water-filling if a layout unit test covers it; D3 and V3 read `replaced by the native design`; (f) Y1 to Y6 cite the inventory's section Y, not spec 12; the pid file `~/.cache/seashell-win/pids/<hostPid>` is removed on the core's quit path; `invokeShell` rejects after 10 s and the caller toasts `The shell did not answer` for user-visible invokes; `window-bounds.json` round-trips in DIPs (a test in the shell's `tools/` is not required; the driver check below covers it).

- [ ] **Step 1: Implement and test**

Run: `npx vitest run test/unit/controller-session.test.ts --project unit` (fails first on the new case if the cadence is wrong, else passes), then `npm run typecheck && npm test`. Expected: green.

- [ ] **Step 2: Re-run the walk and the bounds check**

Rebuild. Run: `node scripts/native-inventory.mjs` Expected: no `fail`; the status document regenerated with the new labels; the `ok` count and the `ok (via ...)` count reported. Bounds: launch scratch `m7` with `SEASHELL_USER_DATA` fresh, move its window with a new driver command `bounds { x, y, w, h }` (DIP; `MoveWindow` on the top-level window; add it to `driver.cpp` in this task), quit, read `window-bounds.json`, expect the DIP values written (equal to the pixels on the 1x display), relaunch and expect the same bounds back.

- [ ] **Step 3: Commit**

```bash
git add scripts/native-inventory.mjs scripts/native-gates.mjs src/core/controller/session.ts test/unit/controller-session.test.ts src/main/platform/wslhost.ts src/core/controller/controller.ts native/shell/src/window.cpp native/shell/src/driver.cpp docs/superpowers/specs/2026-10-02-seashell-inventory-status.md
git commit -m "Tighten the inventory walk and fix the small Phase 1 and 2 leftovers"
```

---

### Task 8: The Phase 3 gate, spec row, snapshot, report and the morning checklist

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-seashell-native-design.md` section 14 (row 3), `scripts/win/run-native-gates.ps1` (nothing new unless Task 4 added `paintMax`; the default list stays)

- [ ] **Step 1: The gate**

On the final build (rebuild everything once more from the branch head, `pack-native.ps1 -Zip`):

1. `npm run typecheck && npm test` green (record the counts against Phase 2's 124 files, 1233 tests).
2. `node scripts/width-parity.mjs` and `node scripts/vt-parity.mjs`: `0 mismatches` (13-resize named).
3. `run-native-gates.ps1 -Name gatesM` default list: every line ok, `latency` with the Task 4 result, `relay`, `restore` with the file and web placeholders, `matrix` 4 ok, `inventory` no fail.
4. `node scripts/native-colors.mjs`, `node scripts/native-aero.mjs`, `node scripts/native-panehook.mjs`: all ok.
5. `test-install-native.ps1`: six ok (the real folder read only).
6. The W10 rows with Edge closed, five samples each: (a) plain, (b) sidebar and drawer, against the 200 bar and against Phase 2's 109.2 and 112.3, with the core RSS; if Edge is open, "not measured, Edge was open" and the 18:24 10/03 figures stand.
7. The P3 PNG set listed in Task 6 step 4 plus `P3-update-banner.png` and `P3-w10-a.png`.
8. Every scratch closed through its driver; no run-owned `wsl.exe`, core, scratch `SeaShell.exe` or fake `SeaShell.exe` left; Josh's SeaShell untouched if it runs; `SCCockpit.exe` pid untouched; `Programs\SeaShell` byte-identical (hash of its listing and mtimes before the run and after); `%APPDATA%\seashell` and `~/.config/seashell` untouched; nothing on main; nothing pushed.

- [ ] **Step 2: Spec row, snapshot, commit**

Fill section 14 row 3: Phase 3, the night, the gate result (pass, or pass with the named bars not met), the W10 figures or the 18:24 ones, the core RSS, `snapshot/native-after-phase3`, and in the notes the Task 4 decision (kept or reverted) and the updater channel.

```bash
git add docs/superpowers/specs/2026-10-02-seashell-native-design.md scripts/win/run-native-gates.ps1
git commit -m "Prove the Phase 3 gates on the native shell"
git branch -f snapshot/native-after-phase3
```

- [ ] **Step 3: The report and the checklist**

Write `~/.codex/notes/seashell-native-phase3-report-2026-10-04.md` (the sections appended after every stage are rewritten into their final form here), in this order:

```
# SeaShell native shell, Phase 3 (report)
## Where it stopped (one line: stage reached, time, why)
## Stage K: the cutover pieces (the banner PNG, the install test lines, the real folder's unchanged hash, the WorkPanel.cs diff, the hook lines)
## Stage L: the bars and the look (the six latency and throughput runs and the decision, the colour lines, the Aero lines with every fix named, the montage if made, the tutorial copy)
## Stage M: hygiene (the walk's counts before and after, the small fixes), the gate (every line), the W10 rows
## Branch and snapshots (redesign/1002 head, every snapshot/native-* sha)
## The morning checklist (below, verbatim, with the real paths and the commands filled in)
## How to launch the scratch build (unchanged from Phase 2 unless a path moved)
## Follow-ups (anything that failed a gate, with the numbers; the Aero shape differences; the latency result if the bar is still not met)
## Not verified
```

The morning checklist, run by hand with Josh, never by this run:

```
1. Josh quits his running SeaShell (File, Exit), or says "quit it" and the supervising session asks its control endpoint to quit; confirm no process runs from Programs\SeaShell.
2. powershell -NoProfile -ExecutionPolicy Bypass -File C:\seashell-build\redesign\scripts\win\install-native.ps1 -Live
   (prints the backup folder and the rollback command; takes under a minute)
3. Start SeaShell from the Start Menu shortcut. Expect: the restore card with his last session; the glass strip; Settings opens.
4. Confirm the control endpoint: ~/.claude/bin/send-to-pane.py against %APPDATA%\seashell\control.json types into a claude pane (the Phase 1 proof), register-session.py records app_id win32-<pid>.
5. SC Cockpit: taskkill /PID <SCCockpit pid> /F (that pid only, never /IM), rename SCCockpit.exe to SCCockpit.exe.bak-electron and SCCockpit.new.exe to SCCockpit.exe, schtasks /run /tn "SC Cockpit". Expect: the WORK page's NEW CLAUDE opens a pane in the native window.
6. If anything is wrong: quit the native SeaShell, run install-native.ps1 -Rollback -Target "%LOCALAPPDATA%\Programs\SeaShell", rename the SC Cockpit files back, schtasks /run; the Electron build is exactly as it was.
```

End of Phase 3.
