# SeaShell Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move SeaShell off Electron onto the stack that stage 0 measures as lightest, keep every feature 1:1, finish the Windows 7 Aero chrome matched to the live desktop, and prove path double-click and the external contracts on the rebuilt app.

**Architecture:** Stage 0 (Tasks 0 to 6) measures four candidates at one fixed workload with one script and applies the decision rule in spec §3. On the R1 outcome (Tasks 7 to 15) a small C++ host owns the window and a WebView2, today's renderer runs unchanged inside it behind a bridge, and today's main-process TypeScript runs as a Node sidecar behind an Electron shim. The Aero work is a retune of the existing `aero` theme tokens plus Win7 control CSS. On R2 or R3 the run stops where spec §3 says and reports.

**Tech Stack:** C++17 with MSVC 14.51 (VS 2026 Build Tools), vcpkg ports `webview2` and `wil`, CMake, WebView2 runtime 154; portable Node 24.21.0 at `C:\seashell-build\node`; node-pty 1.1.0 (win32-x64 prebuild); esbuild (already in `node_modules/.bin`); TypeScript 7, React 19, xterm 6, vitest 4; PowerShell for measurement and packaging.

**Spec:** `docs/superpowers/specs/2026-10-02-seashell-redesign.md` (this plan argues from it; D§n and F§n cite the 7/31 and 0.5 specs as the spec does)

## Global Constraints

- Work only in the worktree `~/seashell-wt/redesign` on branch `redesign/1002` (parent `3746bfe`). Never commit on `main`. Never push anything. Snapshot branches `snapshot/1002-<stage>` are created with `git branch -f` after each stage's gate; never pushed.
- Commit messages are ONE line, no attribution of any kind, no trailers. Example: `Add the RAM measurement script`.
- No em dashes anywhere: code, comments, docs, commit messages, UI copy. Use commas, colons or parentheses.
- NEVER kill, quit, restart or replace the running `C:\Users\josh\AppData\Local\Programs\SeaShell\SeaShell.exe` or anything holding Josh's panes. Never launch that exe or `~/.local/bin/SeaShell-LEGACY.AppImage`. Never `taskkill /IM`. Never write `%APPDATA%\seashell` or `~/.config/seashell`. Scratch instances only, each with its own `SEASHELL_USER_DATA`.
- The kill guard (`~/.claude/bin/seashell-kill-guard.sh`) blocks any kill verb in a command whose text mentions "seashell" unless the command also mentions `release/`. Stop a scratch instance with `Stop-Process -Id <pid>` in a command that names its `release/` path, never by image name.
- Windows work runs from WSL through `powershell.exe -NoProfile -Command` or `cmd.exe /c`. The Windows build tree is `C:\seashell-build\redesign\` (`/mnt/c/seashell-build/redesign/` from WSL). Nothing goes under `C:\AI\`. Nothing is copied into `Programs\SeaShell`.
- MSVC environment for every native build: `cmd.exe /c "call \"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat\" && <command>"`. vcpkg toolchain file: `C:\Users\josh\dev\vcpkg\scripts\buildsystems\vcpkg.cmake`.
- Windows Node for every Windows-side npm or node command: `set PATH=C:\seashell-build\node;%PATH%` first (cmd) or `$env:PATH = 'C:\seashell-build\node;' + $env:PATH` (PowerShell).
- Gates before any snapshot: `npm run typecheck && npm test` clean in the worktree (Linux), plus the stage's own Windows gate named in the task.
- Run one vitest file as `npx vitest run <path> --project unit` (or `--project dom` for `test/dom`).
- Do not `git add -A`. Add files by name.
- In `src/renderer/app.tsx` no React hook may be declared below the `if (!ready) return` line.
- Scrollback is `20_000`. The W10 workload, counting rules and the 200 MB bar are spec §2 and are not reinterpreted.
- Every subagent dispatched by this plan is given `model: "opus"` explicitly unless the ultracode-lite ladder assigns a cheaper tier for a mechanical step.
- After every task that ends a stage, append a section to `~/.codex/notes/seashell-report-1002.md` (Task 15 defines the sections) so a cut-off run still reports.

## Review Focus

1. **Edge running during a measurement.** A person who has Edge open gets a WebView2 number that shares runtime processes and reads too low. `measure-ram.ps1` must refuse to sample when `msedge.exe` is running (Task 0 test).
2. **A pane that prints a 50 MB file.** Base64 through two JSON hops must not grow the sidecar or host without bound; the existing `pty:ack` flow control must still throttle (Task 10 step 6).
3. **Launching the host from inside one of its own panes.** `SEASHELL_USER_ZDOTDIR` must not become the shim path (D nesting trap); the sidecar reuses `resolveUserZdotdir`, and Task 10 asserts the env of a pane spawned from a pane.
4. **A path with a space and a trailing colon-number printed by Claude** (`/Users/joshwald/My Notes/a.md:12`). The tokenizer handles quotes and the suffix; Task 13 adds this row to the matrix.
5. **The desktop colorization registry value missing or malformed.** `colorizationToTokens` must return the spec §6.2 table, never throw and never leave the chrome unthemed (Task 12 test).

---

## Stage 0: bake-off and decision (Tasks 0 to 6)

### Task 0: Worktree hygiene, Windows build tree, RAM measurement script

**Files:**
- Create: `scripts/win/measure-ram.ps1`
- Create: `scripts/win/sync-tree.sh`
- Create: `test/unit/measure-ram-parse.test.ts`
- Create: `scripts/win/measure-ram-parse.mjs`

**Interfaces:**
- Produces: `measure-ram.ps1 -RootPid <int> [-UdfSubstring <string>] -Label <string> [-Samples 5] [-GapSeconds 10] [-ResultsFile C:\seashell-build\redesign\bakeoff\results.jsonl]` printing and appending one JSON line `{"label","rootPid","processes","wsMB","privateMB","samples":[...],"edgeRunning":false,"at":"<iso>"}`; exit code 2 and no line when Edge is running.
- Produces: `scripts/win/sync-tree.sh` rsyncs the worktree to `/mnt/c/seashell-build/redesign/` excluding `node_modules`, `out`, `release`, `.git`.
- Produces: `medianOf(numbers)` and `parseResults(jsonl)` in `scripts/win/measure-ram-parse.mjs` for later tasks to read the results file.

- [ ] **Step 1: Confirm the worktree and branch**

Run: `git -C ~/seashell-wt/redesign status -sb && git -C ~/seashell-wt/redesign log --oneline -1`
Expected: `## redesign/1002` and `3746bfe`. If the worktree is missing: `git -C ~/Desktop/seashell worktree add -b redesign/1002 ~/seashell-wt/redesign 3746bfe`.

- [ ] **Step 2: Write the sync script**

`scripts/win/sync-tree.sh`:

```bash
#!/usr/bin/env bash
# Mirror the redesign worktree into the Windows build tree. node_modules, out and
# release are rebuilt on the Windows side with the Windows Node, never copied.
set -euo pipefail
SRC="${1:-$HOME/seashell-wt/redesign}"
DST="${2:-/mnt/c/seashell-build/redesign}"
mkdir -p "$DST"
rsync -a --delete \
  --exclude node_modules --exclude out --exclude release --exclude .git \
  --exclude host-build --exclude bakeoff \
  "$SRC/" "$DST/"
echo "synced $SRC -> $DST"
```

Run: `chmod +x scripts/win/sync-tree.sh && scripts/win/sync-tree.sh`
Expected: `synced ...` and `/mnt/c/seashell-build/redesign/package.json` exists.

- [ ] **Step 3: Write the failing parse test**

`test/unit/measure-ram-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { medianOf, parseResults } from '../../scripts/win/measure-ram-parse.mjs'

describe('measure-ram results', () => {
  it('takes the median of an odd and an even list', () => {
    expect(medianOf([5, 1, 3])).toBe(3)
    expect(medianOf([4, 1, 3, 2])).toBe(2.5)
  })
  it('parses one JSON object per line and skips blanks', () => {
    const rows = parseResults('{"label":"A","wsMB":410}\n\n{"label":"B","wsMB":120}\n')
    expect(rows.map((r) => r.label)).toEqual(['A', 'B'])
  })
  it('refuses a row without a label or a number', () => {
    expect(() => parseResults('{"wsMB":1}')).toThrow(/label/)
    expect(() => parseResults('{"label":"A","wsMB":"x"}')).toThrow(/wsMB/)
  })
})
```

- [ ] **Step 4: Run it to see it fail**

Run: `npx vitest run test/unit/measure-ram-parse.test.ts --project unit`
Expected: FAIL, cannot find module `measure-ram-parse.mjs`.

- [ ] **Step 5: Write the parser**

`scripts/win/measure-ram-parse.mjs`:

```js
// [pure] Readers for the bake-off results file. No fs here; callers pass text.
export function medianOf(numbers) {
  const s = [...numbers].sort((a, b) => a - b)
  if (s.length === 0) return NaN
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function parseResults(jsonl) {
  return jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const row = JSON.parse(l)
      if (typeof row.label !== 'string' || !row.label) throw new Error(`row ${i + 1}: missing label`)
      if (typeof row.wsMB !== 'number') throw new Error(`row ${i + 1}: wsMB is not a number`)
      return row
    })
}
```

- [ ] **Step 6: Run the test to see it pass**

Run: `npx vitest run test/unit/measure-ram-parse.test.ts --project unit`
Expected: PASS, 3 tests.

- [ ] **Step 7: Write the measurement script**

`scripts/win/measure-ram.ps1`:

```powershell
# Measure the memory of one app tree at the W10 workload (spec section 2).
# Counts the root pid, every descendant by parent pid, and every
# msedgewebview2.exe whose command line contains -UdfSubstring. Refuses to
# sample while Microsoft Edge is running, because a shared runtime reads low.
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [string]$UdfSubstring = '',
  [Parameter(Mandatory = $true)][string]$Label,
  [int]$Samples = 5,
  [int]$GapSeconds = 10,
  [string]$ResultsFile = 'C:\seashell-build\redesign\bakeoff\results.jsonl'
)
$ErrorActionPreference = 'Stop'

if (Get-Process -Name msedge -ErrorAction SilentlyContinue) {
  Write-Error 'Microsoft Edge is running; close it before measuring (spec 2). No sample taken.'
  exit 2
}

function Get-Tree([int]$root, [string]$udf) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
  $byParent = @{}
  foreach ($p in $all) {
    if (-not $byParent.ContainsKey($p.ParentProcessId)) { $byParent[$p.ParentProcessId] = @() }
    $byParent[$p.ParentProcessId] += $p.ProcessId
  }
  $set = New-Object System.Collections.Generic.HashSet[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($root)
  while ($queue.Count -gt 0) {
    $pid = $queue.Dequeue()
    if (-not $set.Add($pid)) { continue }
    if ($byParent.ContainsKey($pid)) { foreach ($c in $byParent[$pid]) { $queue.Enqueue($c) } }
  }
  if ($udf) {
    foreach ($p in $all) {
      if ($p.Name -eq 'msedgewebview2.exe' -and $p.CommandLine -and $p.CommandLine.Contains($udf)) { [void]$set.Add($p.ProcessId) }
    }
  }
  return @($set)
}

$samples = @()
for ($i = 0; $i -lt $Samples; $i++) {
  if ($i -gt 0) { Start-Sleep -Seconds $GapSeconds }
  $pids = Get-Tree $RootPid $UdfSubstring
  $procs = @(Get-Process -Id $pids -ErrorAction SilentlyContinue)
  $ws = ($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB
  $priv = ($procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
  $samples += [pscustomobject]@{ wsMB = [math]::Round($ws, 1); privateMB = [math]::Round($priv, 1); processes = $procs.Count }
}
function Median($xs) { $s = @($xs | Sort-Object); $n = $s.Count; if ($n % 2) { $s[[math]::Floor($n / 2)] } else { ($s[$n / 2 - 1] + $s[$n / 2]) / 2 } }
$row = [ordered]@{
  label = $Label; rootPid = $RootPid
  processes = [int](Median ($samples | ForEach-Object processes))
  wsMB = [double](Median ($samples | ForEach-Object wsMB))
  privateMB = [double](Median ($samples | ForEach-Object privateMB))
  samples = $samples; edgeRunning = $false; at = (Get-Date).ToString('o')
}
$json = ($row | ConvertTo-Json -Compress -Depth 4)
New-Item -ItemType Directory -Force -Path (Split-Path $ResultsFile) | Out-Null
Add-Content -Path $ResultsFile -Value $json
Write-Output $json
```

- [ ] **Step 8: Prove the script against a harmless tree**

Start a throwaway tree and measure it (nothing SeaShell-related is touched):

Run: `powershell.exe -NoProfile -Command "$p = Start-Process notepad -PassThru; Start-Sleep 2; & 'C:\seashell-build\redesign\scripts\win\measure-ram.ps1' -RootPid $p.Id -Label smoke -Samples 2 -GapSeconds 1 -ResultsFile C:\seashell-build\redesign\bakeoff\smoke.jsonl; Stop-Process -Id $p.Id"`
Expected: one JSON line with `"label":"smoke"`, `"processes":1`, a positive `wsMB`. Then, with Edge open by hand or `Start-Process msedge` followed by the same measure call, expected: exit code 2 and the Edge message; close that Edge window again with `Stop-Process -Id` of the pid you started. Delete `smoke.jsonl`.

- [ ] **Step 9: Commit**

```bash
git add scripts/win/measure-ram.ps1 scripts/win/sync-tree.sh scripts/win/measure-ram-parse.mjs test/unit/measure-ram-parse.test.ts
git commit -m "Add the bake-off RAM measurement script and tree sync"
```

### Task 1: The W10 session seed

**Files:**
- Create: `scripts/bakeoff/make-session.mjs`
- Create: `test/unit/bakeoff-session.test.ts`

**Interfaces:**
- Consumes: `isValidProject(value: unknown): value is Project` from `src/main/state/store.ts`; `SavedTab`, `SavedPane` from `src/shared/ipc.ts`; `SCHEMA_VERSION = 1` from `src/main/state/last-session.ts`.
- Produces: `buildW10(cwd: string): { schemaVersion: 1, savedAt: string, tabs: SavedTab[] }` and a CLI `node scripts/bakeoff/make-session.mjs <outDir> [cwd]` writing `<outDir>/last-session.json` and `<outDir>/projects.json` (`{"schemaVersion":1,"projects":[]}`).

- [ ] **Step 1: Write the failing test**

`test/unit/bakeoff-session.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildW10 } from '../../scripts/bakeoff/make-session.mjs'
import { isValidProject } from '../../src/main/state/store.js'

describe('W10 session seed', () => {
  const s = buildW10('/Users/joshwald')
  it('is 9 tabs and 10 term panes of plain zsh', () => {
    expect(s.tabs).toHaveLength(9)
    const panes = s.tabs.flatMap((t) => Object.values(t.panes))
    expect(panes).toHaveLength(10)
    expect(panes.every((p) => p.kind === 'term' && p.command === 'zsh' && p.cwd === '/Users/joshwald')).toBe(true)
    expect(Object.keys(s.tabs[0]!.panes)).toHaveLength(2)
  })
  it('validates as a project the real loader would accept', () => {
    expect(isValidProject({ id: 'w10', name: 'w10', savedAt: s.savedAt, tabs: s.tabs })).toBe(true)
    expect(s.schemaVersion).toBe(1)
  })
  it('never carries a claude session id', () => {
    expect(JSON.stringify(s)).not.toMatch(/claudeSessionId/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/unit/bakeoff-session.test.ts --project unit`
Expected: FAIL, cannot find module `make-session.mjs`.

- [ ] **Step 3: Write the generator**

`scripts/bakeoff/make-session.mjs`:

```js
// Builds the W10 workload (spec section 2): 9 tabs, 10 plain zsh panes.
// Pure except for main(), which writes two files into a SCRATCH userData dir.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function pane(cwd) {
  return { label: 'zsh', labelIsCustom: false, kind: 'term', command: 'zsh', cwd }
}

function tab(i, cwd, paneIds) {
  const children = paneIds.map((id) => ({ type: 'pane', paneId: id }))
  return {
    id: `w10-tab-${i}`,
    name: `Tab ${i}`,
    nameIsCustom: false,
    cwd,
    zoomedPaneId: null,
    focusedPaneId: paneIds[0],
    tree: { type: 'row', ratios: [1], children: [{ type: 'col', ratios: paneIds.map(() => 1 / paneIds.length), children }] },
    panes: Object.fromEntries(paneIds.map((id) => [id, pane(cwd)])),
    sessionIdsVerified: true,
  }
}

export function buildW10(cwd = '/Users/joshwald') {
  const tabs = []
  tabs.push(tab(1, cwd, ['w10-p1a', 'w10-p1b']))
  for (let i = 2; i <= 9; i++) tabs.push(tab(i, cwd, [`w10-p${i}`]))
  return { schemaVersion: 1, savedAt: new Date().toISOString(), tabs }
}

function main() {
  const [outDir, cwd] = process.argv.slice(2)
  if (!outDir) { console.error('usage: make-session.mjs <outDir> [cwd]'); process.exit(1) }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'last-session.json'), JSON.stringify(buildW10(cwd), null, 2))
  writeFileSync(join(outDir, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [] }, null, 2))
  console.log(`wrote W10 session into ${outDir}`)
}

if (process.argv[1] && process.argv[1].endsWith('make-session.mjs')) main()
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run test/unit/bakeoff-session.test.ts --project unit`
Expected: PASS, 3 tests. If `isValidProject` rejects the tree, read `src/main/state/store.ts:90` onward and match its node shape exactly; the fixture in `test/unit/save-invariants.test.ts` (`function tab`) is the reference.

- [ ] **Step 5: Commit**

```bash
git add scripts/bakeoff/make-session.mjs test/unit/bakeoff-session.test.ts
git commit -m "Add the W10 session seed for the bake-off"
```

### Task 2: Candidate A, the Electron baseline at W10

**Files:**
- Create: `scripts/bakeoff/run-electron.ps1`
- Modify: `scripts/cdp.mjs` (add `--shot <file.png>` using `Page.captureScreenshot`)

**Interfaces:**
- Consumes: `make-session.mjs`, `measure-ram.ps1`, the existing build `C:\seashell-build\src\release\win-unpacked\SeaShell.exe` (same tree as the installed exe; its path contains `release\`, which is the kill guard's exemption).
- Produces: a `results.jsonl` row with label `A-electron`; `scripts/cdp.mjs <port> --shot <file>` writes a PNG.

- [ ] **Step 1: Add the screenshot flag to cdp.mjs**

In `scripts/cdp.mjs`, next to the `--key` branch, add:

```js
if (mode === '--shot') {
  const file = rest[0]
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(JSON.stringify({ wrote: file, bytes: r.data.length }))
}
```

(`fs` from `node:fs`; `send` is the existing CDP call helper in that file; follow its naming.) Update the usage line to include `--shot <file.png>`.

- [ ] **Step 2: Write the Electron run script**

`scripts/bakeoff/run-electron.ps1`:

```powershell
# Candidate A. Launches the release\win-unpacked Electron build in a scratch
# userData seeded with W10, restores it over CDP, waits, measures, stops it by pid.
param([string]$Exe = 'C:\seashell-build\src\release\win-unpacked\SeaShell.exe', [int]$Port = 9340)
$ErrorActionPreference = 'Stop'
$scratch = 'C:\seashell-build\redesign\bakeoff\electron-scratch'
if (Test-Path $scratch) { Remove-Item -Recurse -Force $scratch }
$env:PATH = 'C:\seashell-build\node;' + $env:PATH
node C:\seashell-build\redesign\scripts\bakeoff\make-session.mjs $scratch /Users/joshwald
$env:SEASHELL_USER_DATA = $scratch
$p = Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$Port" -PassThru
Start-Sleep 8
Set-Location C:\seashell-build\redesign
node scripts\cdp.mjs $Port --key Escape
Start-Sleep 1
node scripts\cdp.mjs $Port "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Restore'); if (b) { b.click(); return 'clicked' } return 'no-card' })()"
Start-Sleep 20
$n = node scripts\cdp.mjs $Port "window.__seashellTerminals ? window.__seashellTerminals.size : -1"
Write-Output "panes: $n"
Start-Sleep 60
node scripts\cdp.mjs $Port --shot C:\seashell-build\redesign\bakeoff\A-electron.png
& C:\seashell-build\redesign\scripts\win\measure-ram.ps1 -RootPid $p.Id -Label A-electron
# release\win-unpacked path above is what makes the stop guard-safe; stop by pid only.
Stop-Process -Id $p.Id
```

- [ ] **Step 3: Run it**

Run (from WSL): `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\seashell-build\redesign\scripts\bakeoff\run-electron.ps1`
Expected: `panes: 10`, one JSON line labelled `A-electron`, `A-electron.png` showing 9 tabs. If `panes` is not 10, open the PNG, fix the restore click (the card's buttons are `Restore` and `Start fresh` in `src/renderer/session/RestoreCard.tsx`), and rerun; do not record a partial workload.

- [ ] **Step 4: Commit**

```bash
git add scripts/bakeoff/run-electron.ps1 scripts/cdp.mjs
git commit -m "Measure the Electron baseline at W10"
```

### Task 3: Candidate B, the WebView2 renderer floor

**Files:**
- Create: `native/bakeoff/webview2/CMakeLists.txt`
- Create: `native/bakeoff/webview2/vcpkg.json`
- Create: `native/bakeoff/webview2/main.cpp`
- Create: `native/bakeoff/webview2/page/bakeoff.html`
- Create: `scripts/bakeoff/run-webview2.ps1`

**Interfaces:**
- Produces: `bakeoff-webview2.exe <pageDir> <userDataFolder>` opening a 1440x900 window with ten xterm instances, terminal 0 on a live ConPTY `wsl.exe`; a `results.jsonl` row labelled `B-webview2`.

- [ ] **Step 1: vcpkg manifest and CMake**

`native/bakeoff/webview2/vcpkg.json`:

```json
{ "name": "seashell-bakeoff-webview2", "version-string": "0.0.1", "dependencies": ["webview2", "wil"] }
```

`native/bakeoff/webview2/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.25)
project(seashell_bakeoff_webview2 CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(unofficial-webview2 CONFIG REQUIRED)
find_package(wil CONFIG REQUIRED)
add_executable(bakeoff-webview2 WIN32 main.cpp)
target_link_libraries(bakeoff-webview2 PRIVATE unofficial::webview2::webview2 WIL::WIL)
target_compile_definitions(bakeoff-webview2 PRIVATE UNICODE _UNICODE)
```

- [ ] **Step 2: The host**

`native/bakeoff/webview2/main.cpp`:

```cpp
// Bake-off candidate B: one window, one WebView2, ten xterm instances in the
// page, terminal 0 attached to a ConPTY running wsl.exe zsh. Measures the floor
// of keeping the web renderer. Not the product host.
#include <windows.h>
#include <wrl.h>
#include <wil/com.h>
#include <WebView2.h>
#include <string>
#include <thread>
#include <vector>
using Microsoft::WRL::Callback;

static wil::com_ptr<ICoreWebView2Controller> g_ctl;
static wil::com_ptr<ICoreWebView2> g_wv;
static HANDLE g_ptyIn = nullptr;   // we write keystrokes here
static HPCON g_hpc = nullptr;

static std::wstring b64(const char* d, size_t n) {
  static const wchar_t* T = L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::wstring o; o.reserve((n + 2) / 3 * 4);
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = (unsigned char)d[i] << 16 | (i + 1 < n ? (unsigned char)d[i + 1] << 8 : 0) | (i + 2 < n ? (unsigned char)d[i + 2] : 0);
    o += T[v >> 18 & 63]; o += T[v >> 12 & 63];
    o += i + 1 < n ? T[v >> 6 & 63] : L'='; o += i + 2 < n ? T[v & 63] : L'=';
  }
  return o;
}

static void startPty(HWND hwnd) {
  HANDLE inR, inW, outR, outW;
  CreatePipe(&inR, &inW, nullptr, 0); CreatePipe(&outR, &outW, nullptr, 0);
  COORD size{120, 40};
  CreatePseudoConsole(size, inR, outW, 0, &g_hpc);
  g_ptyIn = inW;
  STARTUPINFOEXW si{}; si.StartupInfo.cb = sizeof(si);
  SIZE_T n = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &n);
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, n);
  InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &n);
  UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, g_hpc, sizeof(g_hpc), nullptr, nullptr);
  std::wstring cmd = L"wsl.exe -d Ubuntu-24.04 --cd /Users/joshwald -e zsh -l";
  PROCESS_INFORMATION pi{};
  CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &si.StartupInfo, &pi);
  std::thread([outR, hwnd] {
    char buf[8192]; DWORD got;
    while (ReadFile(outR, buf, sizeof buf, &got, nullptr) && got) {
      auto* s = new std::wstring(L"{\"ch\":\"data\",\"p\":\"" + b64(buf, got) + L"\"}");
      PostMessageW(hwnd, WM_APP + 1, 0, (LPARAM)s);
    }
  }).detach();
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_SIZE: if (g_ctl) { RECT r; GetClientRect(h, &r); g_ctl->put_Bounds(r); } return 0;
    case WM_APP + 1: { auto* s = (std::wstring*)l; if (g_wv) g_wv->PostWebMessageAsJson(s->c_str()); delete s; return 0; }
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE, PWSTR cmdLine, int nShow) {
  int argc = 0; LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::wstring pageDir = argc > 1 ? argv[1] : L".";
  std::wstring udf = argc > 2 ? argv[2] : L"C:\\seashell-build\\redesign\\bakeoff\\webview2-udf";
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  WNDCLASSW wc{}; wc.lpfnWndProc = WndProc; wc.hInstance = hi; wc.lpszClassName = L"SeaShellBakeoffWebView2";
  RegisterClassW(&wc);
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"SeaShell bakeoff B", WS_OVERLAPPEDWINDOW, 100, 100, 1440, 900, nullptr, nullptr, hi, nullptr);
  ShowWindow(hwnd, nShow);
  CreateCoreWebView2EnvironmentWithOptions(nullptr, udf.c_str(), nullptr,
    Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([hwnd, pageDir](HRESULT, ICoreWebView2Environment* env) -> HRESULT {
      env->CreateCoreWebView2Controller(hwnd, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([hwnd, pageDir](HRESULT, ICoreWebView2Controller* c) -> HRESULT {
        g_ctl = c; g_ctl->get_CoreWebView2(&g_wv);
        RECT r; GetClientRect(hwnd, &r); g_ctl->put_Bounds(r);
        auto wv3 = g_wv.query<ICoreWebView2_3>();
        wv3->SetVirtualHostNameToFolderMapping(L"bakeoff.seashell", pageDir.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
        g_wv->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) -> HRESULT {
          wil::unique_cotaskmem_string s; a->TryGetWebMessageAsString(&s);
          if (g_ptyIn && s) { std::string u; for (wchar_t ch : std::wstring(s.get())) u += (char)ch; DWORD w; WriteFile(g_ptyIn, u.data(), (DWORD)u.size(), &w, nullptr); }
          return S_OK; }).Get(), nullptr);
        g_wv->Navigate(L"https://bakeoff.seashell/bakeoff.html");
        startPty(hwnd);
        return S_OK; }).Get());
      return S_OK; }).Get());
  MSG msg; while (GetMessageW(&msg, nullptr, 0, 0)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  return 0;
}
```

- [ ] **Step 3: The page**

`native/bakeoff/webview2/page/bakeoff.html` (xterm files are copied next to it by the run script from `node_modules/@xterm/xterm/lib/xterm.js`, `node_modules/@xterm/xterm/css/xterm.css`, `node_modules/@xterm/addon-webgl/lib/addon-webgl.js`):

```html
<!doctype html><html><head><meta charset="utf-8"><title>bakeoff</title>
<link rel="stylesheet" href="xterm.css">
<style>body{margin:0;background:#000;display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(2,1fr);height:100vh}.t{border:1px solid #1c2c1c}</style>
</head><body>
<script src="xterm.js"></script><script src="addon-webgl.js"></script>
<script>
const terms = []
for (let i = 0; i < 10; i++) {
  const el = document.createElement('div'); el.className = 't'; document.body.appendChild(el)
  const t = new Terminal({ cols: 120, rows: 40, scrollback: 20000, fontFamily: 'Consolas', fontSize: 13, theme: { background: '#000000', foreground: '#28fe14' } })
  t.open(el)
  try { t.loadAddon(new WebglAddon.WebglAddon()) } catch (e) {}
  if (i > 0) t.write('zsh idle pane ' + i + '\r\n% ')
  terms.push(t)
}
const b64d = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
window.chrome.webview.addEventListener('message', (e) => { const m = e.data; if (m.ch === 'data') terms[0].write(b64d(m.p)) })
terms[0].onData((d) => window.chrome.webview.postMessage(d))
window.__bakeoffTerms = terms
</script></body></html>
```

- [ ] **Step 4: Build it**

Run (from WSL, after `scripts/win/sync-tree.sh`):

```
cmd.exe /c "call \"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat\" && cmake -S C:\seashell-build\redesign\native\bakeoff\webview2 -B C:\seashell-build\redesign\bakeoff\b-build -A x64 -DCMAKE_TOOLCHAIN_FILE=C:\Users\josh\dev\vcpkg\scripts\buildsystems\vcpkg.cmake && cmake --build C:\seashell-build\redesign\bakeoff\b-build --config Release"
```

Expected: `bakeoff-webview2.exe` under `bakeoff\b-build\Release\`. vcpkg builds `webview2` and `wil` on first use (a few minutes). If `find_package(unofficial-webview2)` fails, read `C:\Users\josh\dev\vcpkg\ports\webview2\usage` and use the target name it prints.

- [ ] **Step 5: The run script and the measurement**

`scripts/bakeoff/run-webview2.ps1`:

```powershell
param([int]$Port = 9341)
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$page = "$root\native\bakeoff\webview2\page"
Copy-Item "$root\node_modules\@xterm\xterm\lib\xterm.js" $page -Force
Copy-Item "$root\node_modules\@xterm\xterm\css\xterm.css" $page -Force
Copy-Item "$root\node_modules\@xterm\addon-webgl\lib\addon-webgl.js" $page -Force
$udf = "$root\bakeoff\webview2-udf"
if (Test-Path $udf) { Remove-Item -Recurse -Force $udf }
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$p = Start-Process -FilePath "$root\bakeoff\b-build\Release\bakeoff-webview2.exe" -ArgumentList "$page", "$udf" -PassThru
Start-Sleep 70
$env:PATH = 'C:\seashell-build\node;' + $env:PATH
Set-Location $root
node scripts\cdp.mjs $Port "window.__bakeoffTerms.length"
node scripts\cdp.mjs $Port --shot "$root\bakeoff\B-webview2.png"
& "$root\scripts\win\measure-ram.ps1" -RootPid $p.Id -UdfSubstring 'webview2-udf' -Label B-webview2
Stop-Process -Id $p.Id
```

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\seashell-build\redesign\scripts\bakeoff\run-webview2.ps1`
Expected: `10`, a PNG with ten green-on-black grids and a zsh prompt in the first, a `B-webview2` row. `node_modules` on the Windows tree comes from `cmd.exe /c "set PATH=C:\seashell-build\node;%PATH% && cd /d C:\seashell-build\redesign && npm ci"` (approve the install scripts the same way the 9/24 note did: `npm install-scripts approve electron esbuild node-pty electron-winstaller` if npm asks).

- [ ] **Step 6: Commit**

```bash
git add native/bakeoff/webview2 scripts/bakeoff/run-webview2.ps1
git commit -m "Measure the WebView2 renderer floor at W10"
```

### Task 4: Candidate C, the Node sidecar floor

**Files:**
- Create: `scripts/bakeoff/sidecar-floor.mjs`
- Create: `scripts/bakeoff/run-sidecar.ps1`

- [ ] **Step 1: The floor script**

`scripts/bakeoff/sidecar-floor.mjs`:

```js
// Candidate C: node.exe + node-pty with ten wsl.exe zsh panes and nothing else.
// The cost of keeping src/main alive as a sidecar.
import pty from 'node-pty'
const n = Number(process.argv[2] ?? 10)
const panes = []
for (let i = 0; i < n; i++) {
  const p = pty.spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--cd', '/Users/joshwald', '-e', 'zsh', '-l'], { name: 'xterm-256color', cols: 120, rows: 40 })
  p.onData(() => {})
  panes.push(p)
}
console.log(JSON.stringify({ pid: process.pid, panes: panes.map((p) => p.pid) }))
setInterval(() => {}, 1 << 30)
```

- [ ] **Step 2: The run script**

`scripts/bakeoff/run-sidecar.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$env:PATH = 'C:\seashell-build\node;' + $env:PATH
Set-Location $root
$p = Start-Process -FilePath 'C:\seashell-build\node\node.exe' -ArgumentList 'scripts\bakeoff\sidecar-floor.mjs', '10' -PassThru -RedirectStandardOutput "$root\bakeoff\C-sidecar.out"
Start-Sleep 70
Get-Content "$root\bakeoff\C-sidecar.out"
& "$root\scripts\win\measure-ram.ps1" -RootPid $p.Id -Label C-sidecar
Stop-Process -Id $p.Id
```

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\seashell-build\redesign\scripts\bakeoff\run-sidecar.ps1`
Expected: a JSON line with ten pane pids and a `C-sidecar` row. The tree walk counts the ten `wsl.exe` relays and any `conhost.exe` ConPTY hosts, which is correct: the product pays for them too.

- [ ] **Step 3: Commit**

```bash
git add scripts/bakeoff/sidecar-floor.mjs scripts/bakeoff/run-sidecar.ps1
git commit -m "Measure the Node sidecar floor at W10"
```

### Task 5: Candidate D, the native floor

**Files:**
- Create: `native/bakeoff/win32/CMakeLists.txt`
- Create: `native/bakeoff/win32/main.cpp`
- Create: `scripts/bakeoff/run-native.ps1`

- [ ] **Step 1: CMake**

```cmake
cmake_minimum_required(VERSION 3.25)
project(seashell_bakeoff_win32 CXX)
set(CMAKE_CXX_STANDARD 17)
add_executable(bakeoff-win32 WIN32 main.cpp)
target_link_libraries(bakeoff-win32 PRIVATE d2d1 dwrite)
target_compile_definitions(bakeoff-win32 PRIVATE UNICODE _UNICODE)
```

- [ ] **Step 2: The floor**

`native/bakeoff/win32/main.cpp`:

```cpp
// Bake-off candidate D: a Win32 window drawing ten 120x40 text grids with
// DirectWrite, grid 0 fed by a ConPTY running wsl.exe zsh (raw bytes, no
// escape parsing). The floor of a native rewrite, not a terminal.
#include <windows.h>
#include <d2d1.h>
#include <dwrite.h>
#include <string>
#include <thread>
#include <mutex>
#include <vector>
#pragma comment(lib, "d2d1") 
#pragma comment(lib, "dwrite")

static ID2D1Factory* g_d2d; static IDWriteFactory* g_dw; static ID2D1HwndRenderTarget* g_rt; static IDWriteTextFormat* g_fmt;
static std::vector<std::wstring> g_grids(10);
static std::mutex g_mu;

static void startPty(HWND hwnd) {
  HANDLE inR, inW, outR, outW; CreatePipe(&inR, &inW, nullptr, 0); CreatePipe(&outR, &outW, nullptr, 0);
  HPCON hpc; COORD size{120, 40}; CreatePseudoConsole(size, inR, outW, 0, &hpc);
  STARTUPINFOEXW si{}; si.StartupInfo.cb = sizeof(si); SIZE_T n = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &n);
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, n);
  InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &n);
  UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, sizeof(hpc), nullptr, nullptr);
  std::wstring cmd = L"wsl.exe -d Ubuntu-24.04 --cd /Users/joshwald -e zsh -l"; PROCESS_INFORMATION pi{};
  CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &si.StartupInfo, &pi);
  std::thread([outR, hwnd] { char buf[4096]; DWORD got; while (ReadFile(outR, buf, sizeof buf, &got, nullptr) && got) {
    std::lock_guard<std::mutex> lk(g_mu); for (DWORD i = 0; i < got; i++) { char c = buf[i]; if (c >= 32 || c == '\n') g_grids[0] += (wchar_t)c; }
    if (g_grids[0].size() > 120 * 40) g_grids[0].erase(0, g_grids[0].size() - 120 * 40);
    InvalidateRect(hwnd, nullptr, FALSE); } }).detach();
}

static void paint(HWND h) {
  if (!g_rt) { RECT r; GetClientRect(h, &r); g_d2d->CreateHwndRenderTarget(D2D1::RenderTargetProperties(), D2D1::HwndRenderTargetProperties(h, D2D1::SizeU(r.right, r.bottom)), &g_rt); }
  g_rt->BeginDraw(); g_rt->Clear(D2D1::ColorF(0, 0, 0));
  ID2D1SolidColorBrush* br; g_rt->CreateSolidColorBrush(D2D1::ColorF(0.157f, 0.996f, 0.078f), &br);
  D2D1_SIZE_F sz = g_rt->GetSize(); float cw = sz.width / 5, chh = sz.height / 2;
  std::lock_guard<std::mutex> lk(g_mu);
  for (int i = 0; i < 10; i++) { D2D1_RECT_F rc = D2D1::RectF((i % 5) * cw, (i / 5) * chh, (i % 5 + 1) * cw, (i / 5 + 1) * chh);
    g_rt->DrawText(g_grids[i].c_str(), (UINT32)g_grids[i].size(), g_fmt, rc, br); }
  br->Release(); g_rt->EndDraw(); ValidateRect(h, nullptr);
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) { case WM_PAINT: paint(h); return 0; case WM_SIZE: if (g_rt) g_rt->Resize(D2D1::SizeU(LOWORD(l), HIWORD(l))); return 0; case WM_DESTROY: PostQuitMessage(0); return 0; }
  return DefWindowProcW(h, m, w, l);
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE, PWSTR, int nShow) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, &g_d2d);
  DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), (IUnknown**)&g_dw);
  g_dw->CreateTextFormat(L"Consolas", nullptr, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, 13.0f, L"en-us", &g_fmt);
  for (int i = 1; i < 10; i++) { std::wstring s; for (int r = 0; r < 40; r++) s += L"zsh idle pane " + std::to_wstring(i) + L" line " + std::to_wstring(r) + L"\n"; g_grids[i] = s; }
  WNDCLASSW wc{}; wc.lpfnWndProc = WndProc; wc.hInstance = hi; wc.lpszClassName = L"SeaShellBakeoffWin32"; RegisterClassW(&wc);
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"SeaShell bakeoff D", WS_OVERLAPPEDWINDOW, 100, 100, 1440, 900, nullptr, nullptr, hi, nullptr);
  ShowWindow(hwnd, nShow); startPty(hwnd);
  MSG msg; while (GetMessageW(&msg, nullptr, 0, 0)) { TranslateMessage(&msg); DispatchMessageW(&msg); } return 0;
}
```

- [ ] **Step 3: Build, run, measure**

Build: same `cmd.exe /c "call ...vcvars64.bat && cmake -S C:\seashell-build\redesign\native\bakeoff\win32 -B C:\seashell-build\redesign\bakeoff\d-build -A x64 && cmake --build C:\seashell-build\redesign\bakeoff\d-build --config Release"`.

`scripts/bakeoff/run-native.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$p = Start-Process -FilePath "$root\bakeoff\d-build\Release\bakeoff-win32.exe" -PassThru
Start-Sleep 70
& "$root\scripts\win\measure-ram.ps1" -RootPid $p.Id -Label D-native
Stop-Process -Id $p.Id
```

Run it. Expected: a `D-native` row. Take a screenshot with `powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = New-Object Drawing.Bitmap 1440,900; $g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(100,100,0,0,$b.Size); $b.Save('C:\seashell-build\redesign\bakeoff\D-native.png')"` while it is up (before the Stop-Process line, or run the script's parts by hand).

- [ ] **Step 4: Commit**

```bash
git add native/bakeoff/win32 scripts/bakeoff/run-native.ps1
git commit -m "Measure the native Win32 floor at W10"
```

### Task 6: The decision

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-seashell-redesign.md` (§13 only)
- Create: `scripts/bakeoff/decide.mjs`
- Create: `test/unit/bakeoff-decide.test.ts`

**Interfaces:**
- Produces: `decide(rows): { rule: 'R1'|'R2'|'R3', chosen: string, bPlusC: number, bPlus25: number }` where `rows` is `parseResults()` output; CLI `node scripts/bakeoff/decide.mjs <results.jsonl>` prints the §13 table in markdown and the rule.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { decide } from '../../scripts/bakeoff/decide.mjs'

const row = (label, wsMB) => ({ label, wsMB, privateMB: wsMB, processes: 1 })
describe('decision rule (spec 3)', () => {
  it('R1 when B + C is under 200', () => {
    expect(decide([row('A-electron', 500), row('B-webview2', 120), row('C-sidecar', 60), row('D-native', 20)]).rule).toBe('R1')
  })
  it('R2 when B + C is 200 or more but B + 25 is under 200', () => {
    expect(decide([row('B-webview2', 160), row('C-sidecar', 60), row('D-native', 20)]).rule).toBe('R2')
  })
  it('R3 otherwise', () => {
    expect(decide([row('B-webview2', 190), row('C-sidecar', 60), row('D-native', 20)]).rule).toBe('R3')
  })
  it('throws when B or C is missing', () => {
    expect(() => decide([row('A-electron', 500)])).toThrow(/B-webview2/)
  })
})
```

- [ ] **Step 2: Run to fail, then implement**

`scripts/bakeoff/decide.mjs`:

```js
import { readFileSync } from 'node:fs'
import { parseResults } from '../win/measure-ram-parse.mjs'

export function decide(rows) {
  const get = (l) => { const r = rows.findLast((x) => x.label === l); if (!r) throw new Error(`no row labelled ${l}`); return r }
  const b = get('B-webview2').wsMB, c = get('C-sidecar').wsMB
  const bPlusC = b + c, bPlus25 = b + 25
  if (bPlusC < 200) return { rule: 'R1', chosen: 'WebView2 host + Node sidecar', bPlusC, bPlus25 }
  if (bPlus25 < 200) return { rule: 'R2', chosen: 'WebView2 host + C++ main', bPlusC, bPlus25 }
  return { rule: 'R3', chosen: 'native', bPlusC, bPlus25 }
}

export function table(rows) {
  const want = ['A-electron', 'B-webview2', 'C-sidecar', 'D-native']
  const lines = ['| Candidate | processes | WS median MB | private median MB |', '|---|---|---|---|']
  for (const l of want) { const r = rows.findLast((x) => x.label === l); lines.push(r ? `| ${l} | ${r.processes} | ${r.wsMB} | ${r.privateMB} |` : `| ${l} | not measured | | |`) }
  const d = decide(rows)
  lines.push(`| B + C | | ${d.bPlusC} | | `)
  lines.push('', `Rule applied: ${d.rule}. Chosen: ${d.chosen}.`)
  return lines.join('\n')
}

if (process.argv[1]?.endsWith('decide.mjs')) console.log(table(parseResults(readFileSync(process.argv[2], 'utf8'))))
```

Run: `npx vitest run test/unit/bakeoff-decide.test.ts --project unit` Expected: PASS, 4 tests.

- [ ] **Step 3: Write §13**

Run: `node scripts/bakeoff/decide.mjs /mnt/c/seashell-build/redesign/bakeoff/results.jsonl` and paste the output into spec §13 in place of the empty table, adding the measured-at line (time, Edge closed yes, display MSI 1x) and the four PNG paths.

- [ ] **Step 4: Gate, snapshot, report**

Run: `npm run typecheck && npm test` Expected: clean, all previous tests plus the new ones.

```bash
git add docs/superpowers/specs/2026-10-02-seashell-redesign.md scripts/bakeoff/decide.mjs test/unit/bakeoff-decide.test.ts
git commit -m "Record the stage 0 measurements and the stack decision"
git branch -f snapshot/1002-after-bakeoff
```

Append the report section "Stage 0: bake-off" to `~/.codex/notes/seashell-report-1002.md` (Task 15 format) with the table, the rule, and the four PNG paths.

**Branch here.** R1: continue with Task 7. R2: do Tasks 7, 9 and 11 against a stub sidecar (the bridge echoes `app:getPaths` only), write `docs/superpowers/plans/2026-10-02-seashell-cpp-main.md` as an addendum listing every `src/main` module with its C++ counterpart, then go to Task 15. R3: go to Task 15 now.

---

## Stage 1: the host (Tasks 7 to 9)

### Task 7: Host window, WebView2, single instance, identity

**Files:**
- Create: `native/host/CMakeLists.txt`, `native/host/vcpkg.json`, `native/host/src/main.cpp`, `native/host/src/window.h`, `native/host/src/window.cpp`, `native/host/src/webview.h`, `native/host/src/webview.cpp`, `native/host/src/paths.h`, `native/host/src/paths.cpp`, `native/host/app.rc`, `native/host/app.manifest`
- Create: `scripts/win/build-host.ps1`

**Interfaces:**
- Produces: `SeaShell.exe` (class `SeaShellHost`, title `SeaShell`, AppUserModelID `dev.seashell.app`, icon from `build/icon.ico`, mutex `Local\SeaShellHost`), reading `SEASHELL_USER_DATA` (default `%APPDATA%\seashell`) and `SEASHELL_CDP_PORT`; `resources\renderer` served as `https://seashell.app/`; saved bounds in `<userData>\window-bounds.json` (same file and keys as `src/main/window-bounds.ts`: `{x,y,width,height,maximized}`), clamped to the matching monitor's work area.
- Produces for Task 8: `HostBridge` with `void post(const std::wstring& json)` (to renderer) and `void onWebMessage(std::function<void(std::wstring)>)`.

- [ ] **Step 1: Manifest, resources, CMake**

`native/host/vcpkg.json`: `{ "name": "seashell-host", "version-string": "0.6.0", "dependencies": ["webview2", "wil", "nlohmann-json"] }`

`native/host/app.manifest` declares `PerMonitorV2` DPI awareness and the common-controls 6 dependency. `native/host/app.rc`: `IDI_APP ICON "..\\..\\build\\icon.ico"` plus a `VERSIONINFO` block with `ProductName "SeaShell"`, `FileDescription "SeaShell"`, version `0.6.0.0`.

`native/host/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.25)
project(seashell_host CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(unofficial-webview2 CONFIG REQUIRED)
find_package(wil CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
add_executable(SeaShell WIN32 src/main.cpp src/window.cpp src/webview.cpp src/paths.cpp src/bridge.cpp src/sidecar.cpp src/hostapi.cpp app.rc)
target_link_libraries(SeaShell PRIVATE unofficial::webview2::webview2 WIL::WIL nlohmann_json::nlohmann_json dwmapi shlwapi)
target_compile_definitions(SeaShell PRIVATE UNICODE _UNICODE)
set_target_properties(SeaShell PROPERTIES LINK_FLAGS "/MANIFEST:EMBED /MANIFESTINPUT:${CMAKE_CURRENT_SOURCE_DIR}/app.manifest")
```

(`bridge.cpp`, `sidecar.cpp`, `hostapi.cpp` are created in Task 8; add them as empty translation units now so the target links.)

- [ ] **Step 2: paths**

`paths.h` / `paths.cpp`: `std::wstring userData()` (env `SEASHELL_USER_DATA` or `%APPDATA%\seashell`, created if missing), `std::wstring resourcesDir()` (`<exe dir>\resources`), `std::wstring webviewUdf()` (`<userData>\webview2`), `int cdpPort()` (env `SEASHELL_CDP_PORT` or 0).

- [ ] **Step 3: window**

`window.cpp`: `RegisterClassW` with `lpszClassName = L"SeaShellHost"`, `hIcon` and `hIconSm` from `IDI_APP`; `SetCurrentProcessExplicitAppUserModelID(L"dev.seashell.app")` before the window exists; `CreateWindowExW(0, L"SeaShellHost", L"SeaShell", WS_OVERLAPPEDWINDOW, ...)` with bounds from `window-bounds.json` clamped to `MonitorFromRect(..., MONITOR_DEFAULTTONEAREST)` work area (default 1440x900 centered on the primary); `WM_SIZE` and `WM_MOVE` write bounds back at most twice a second; `WM_CLOSE` asks the bridge for the quit drain (`app:beforeQuit`) and destroys after the sidecar's `app:quitReply` or 4 s; `WM_DESTROY` posts quit. Single instance: `CreateMutexW(nullptr, TRUE, L"Local\\SeaShellHost")`; if `ERROR_ALREADY_EXISTS`, `FindWindowW(L"SeaShellHost", nullptr)`, `SetForegroundWindow`, exit 0 (and pass the folder argument via `WM_COPYDATA` so `second-instance` reaches the sidecar).

- [ ] **Step 4: webview**

`webview.cpp`: environment with `userDataFolder = webviewUdf()` and `additionalBrowserArguments = "--remote-debugging-port=<port>"` only when `cdpPort() > 0`; controller bounds follow `WM_SIZE`; settings per spec §4.5 (`AreDefaultContextMenusEnabled` false, `IsStatusBarEnabled` false, `AreDevToolsEnabled` = `cdpPort() > 0`, `IsZoomControlEnabled` false); `SetVirtualHostNameToFolderMapping(L"seashell.app", resourcesDir() + L"\\renderer", DENY_CORS)`; `NavigationStarting` cancels any URI not starting with `https://seashell.app/`; `NewWindowRequested` sets `Handled` true and forwards the URI to the host's `open:externalHttp` gate; `Navigate(L"https://seashell.app/index.html")`; `add_WebMessageReceived` hands the JSON string to `HostBridge::onWebMessage`.

- [ ] **Step 5: build script**

`scripts/win/build-host.ps1`:

```powershell
param([string]$Config = 'Release')
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$vc = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$tc = 'C:\Users\josh\dev\vcpkg\scripts\buildsystems\vcpkg.cmake'
cmd.exe /c "call `"$vc`" && cmake -S $root\native\host -B $root\host-build -A x64 -DCMAKE_TOOLCHAIN_FILE=$tc && cmake --build $root\host-build --config $Config"
if ($LASTEXITCODE -ne 0) { throw "host build failed ($LASTEXITCODE)" }
Write-Output "$root\host-build\$Config\SeaShell.exe"
```

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\seashell-build\redesign\scripts\win\build-host.ps1`
Expected: the exe path. Every scratch host from here on is launched from `C:\seashell-build\redesign\release\win-host\SeaShell.exe` (Task 11's final layout), never from `host-build\`, because the kill guard only lets a stop through when the command text contains `release/`. After each host build, stage it: `powershell.exe -NoProfile -Command "New-Item -ItemType Directory -Force C:\seashell-build\redesign\release\win-host | Out-Null; Copy-Item C:\seashell-build\redesign\host-build\Release\SeaShell.exe C:\seashell-build\redesign\release\win-host\ -Force"`. Then launch it once with `SEASHELL_USER_DATA=C:\seashell-build\redesign\scratch\host1` and no renderer yet. Expected: a window titled `SeaShell` with the nautilus icon and a blank WebView2 (the renderer arrives in Task 9). Confirm with `powershell.exe -NoProfile -Command "Get-Process SeaShell | Where-Object Path -like '*release\win-host*' | Select-Object Id,MainWindowTitle"` and stop it with `powershell.exe -NoProfile -Command "Stop-Process -Id <pid>"  # scratch host from release/win-host` (the `release/` in the command text is the guard exemption).

- [ ] **Step 6: Commit**

```bash
git add native/host scripts/win/build-host.ps1
git commit -m "Add the native WebView2 host window"
```

### Task 8: Host bridge, sidecar lifetime, host-owned channels

**Files:**
- Create: `native/host/src/bridge.h`, `native/host/src/bridge.cpp`, `native/host/src/sidecar.h`, `native/host/src/sidecar.cpp`, `native/host/src/hostapi.h`, `native/host/src/hostapi.cpp`
- Create: `src/sidecar/protocol.ts`
- Create: `test/unit/sidecar-protocol.test.ts`

**Interfaces:**
- Produces (TypeScript, shared by sidecar and renderer): `encodeEnvelope(e: Envelope): string` (one line, no newline inside), `decodeEnvelope(line: string): Envelope` (throws on unknown `k`, non-string `ch`, non-object payload for `invoke`), `type Envelope = { k: 'invoke'|'send'|'on'|'reply', ch: string, id?: number, p: unknown }`, `HOST_CHANNELS: readonly string[]` = `['window:minimize','window:toggleMaximize','window:close','window:isMaximized','window:onMaximized','app:pickFolder','clip:read','clip:write','open:withDefaultApp','open:revealInFinder','open:externalHttp','display:list','display:colorization','test:screenshot']`.
- Produces (C++): the host spawns `resources\node\node.exe resources\sidecar\index.cjs --host-pid <pid>` with piped stdin/stdout, env `SEASHELL_USER_DATA` forwarded; relays every renderer envelope whose `ch` is not in `HOST_CHANNELS` to the sidecar and every sidecar line to the renderer; answers `HOST_CHANNELS` itself; restarts nothing (a dead sidecar shows the renderer an `ui:notice` with code `ESIDECAR` and the window stays up).

- [ ] **Step 1: Failing protocol test**

```ts
import { describe, expect, it } from 'vitest'
import { decodeEnvelope, encodeEnvelope, HOST_CHANNELS } from '../../src/sidecar/protocol.js'

describe('bridge envelope', () => {
  it('round trips an invoke with an id', () => {
    const line = encodeEnvelope({ k: 'invoke', ch: 'fs:probe', id: 7, p: { path: '/x' } })
    expect(line.includes('\n')).toBe(false)
    expect(decodeEnvelope(line)).toEqual({ k: 'invoke', ch: 'fs:probe', id: 7, p: { path: '/x' } })
  })
  it('rejects unknown kinds and bad channels', () => {
    expect(() => decodeEnvelope('{"k":"exec","ch":"x","p":{}}')).toThrow(/k/)
    expect(() => decodeEnvelope('{"k":"send","ch":5,"p":{}}')).toThrow(/ch/)
    expect(() => decodeEnvelope('{"k":"invoke","ch":"fs:probe","id":1,"p":"str"}')).toThrow(/payload/)
  })
  it('keeps newlines inside strings escaped', () => {
    const line = encodeEnvelope({ k: 'send', ch: 'pty:write', p: { paneId: 'a', data: 'ls\n' } })
    expect(line.split('\n')).toHaveLength(1)
  })
  it('names the host-owned channels', () => {
    expect(HOST_CHANNELS).toContain('clip:read')
    expect(HOST_CHANNELS).not.toContain('pty:spawn')
  })
})
```

- [ ] **Step 2: Implement protocol.ts**

```ts
/** [pure] The one envelope shape on both bridge legs (spec 4.2). */
export type EnvelopeKind = 'invoke' | 'send' | 'on' | 'reply'
export interface Envelope { k: EnvelopeKind; ch: string; id?: number; p: unknown }
const KINDS: readonly EnvelopeKind[] = ['invoke', 'send', 'on', 'reply']

export const HOST_CHANNELS: readonly string[] = [
  'window:minimize', 'window:toggleMaximize', 'window:close', 'window:isMaximized', 'window:onMaximized',
  'app:pickFolder', 'clip:read', 'clip:write',
  'open:withDefaultApp', 'open:revealInFinder', 'open:externalHttp',
  'display:list', 'display:colorization', 'test:screenshot',
]

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

- [ ] **Step 3: sidecar.cpp**

Spawn with `CreateProcessW` and three pipes (stdin write end kept, stdout read end on a reader thread that splits on `\n` and posts each line to the UI thread as `WM_APP + 2`, stderr appended to `<userData>\sidecar.log`). `Sidecar::send(const std::string& line)` writes `line + "\n"` under a mutex. On process exit, post `WM_APP + 3`; the bridge turns it into `{"k":"on","ch":"ui:notice","p":{"id":"sidecar-dead","level":"error","code":"ESIDECAR","message":"The SeaShell service stopped. Save your work and restart SeaShell."}}`.

- [ ] **Step 4: bridge.cpp**

`HostBridge::onWebMessage(json)`: parse with nlohmann; if `ch` is in the C++ copy of `HOST_CHANNELS` (a `static const std::set<std::string>` kept identical to `protocol.ts`; Task 14 adds a test that greps both files for the same list), call `HostApi::handle(envelope)` and post the reply; otherwise `sidecar.send(json)`. `HostBridge::onSidecarLine(line)`: `webview.PostWebMessageAsJson(utf16(line))`. `HostBridge::post(json)` for host-originated pushes (`window:onMaximized`, `ui:command` from `WM_COPYDATA`).

- [ ] **Step 5: hostapi.cpp**

| channel | implementation |
|---|---|
| `window:minimize` / `toggleMaximize` / `close` / `isMaximized` | `ShowWindow(SW_MINIMIZE)`, `IsZoomed ? SW_RESTORE : SW_MAXIMIZE`, `PostMessage(WM_CLOSE)`, `IsZoomed` |
| `app:pickFolder` | `IFileOpenDialog` with `FOS_PICKFOLDERS`; `{ok:true,path}` as a Linux path when the pick is under `\\wsl.localhost\<distro>\` (reuse the same mapping as `wsl-path.ts`: `\\wsl.localhost\Ubuntu-24.04\a\b` to `/a/b`), otherwise `/mnt/<drive>/...`; `{ok:false,code:'ECANCEL'}` on cancel |
| `clip:read` / `clip:write` | `OpenClipboard` + `CF_UNICODETEXT`; write refuses more than 100 000 chars (D§12) |
| `open:withDefaultApp` | `ShellExecuteW(open, <windows path>)`; Linux paths mapped to UNC first; `{ok:false,error}` on a failure code under 32 |
| `open:revealInFinder` | `ShellExecuteW(L"explorer.exe", L"/select,\"<path>\"")` |
| `open:externalHttp` | only `http://` or `https://` prefixes, else `{ok:false}` |
| `display:list` | `EnumDisplayMonitors` to `[{id, bounds, workArea, scaleFactor, primary}]` |
| `display:colorization` | `RegGetValueW(HKCU, L"Software\\Microsoft\\Windows\\DWM", L"ColorizationColor")` to `{ok:true, argb:"#AARRGGBB"}` or `{ok:false}` |
| `test:screenshot` | only when `cdpPort() > 0`: `PrintWindow` of the host HWND to a PNG at the given path via WIC |

- [ ] **Step 6: Build and smoke the relay without a sidecar**

Build with `build-host.ps1`. Launch the scratch host with `SEASHELL_CDP_PORT=9335` and `resources\renderer\index.html` being a one-line test page `<script>chrome.webview.addEventListener('message', e => window.__last = e.data); chrome.webview.postMessage(JSON.stringify({k:'invoke',ch:'display:list',id:1,p:{}}))</script>`. Over CDP: `node scripts/cdp.mjs 9335 "JSON.stringify(window.__last)"` Expected: a `reply` with `id: 1` listing the two monitors (the MSI 3440x1440 and the Philips 1920x1080 above it). Stop the host by pid.

- [ ] **Step 7: Commit**

```bash
git add native/host/src src/sidecar/protocol.ts test/unit/sidecar-protocol.test.ts
git commit -m "Add the host bridge, sidecar lifetime and host-owned channels"
```

### Task 9: Renderer bridge, serving today's renderer from the host

**Files:**
- Create: `src/renderer/platform/bridge.ts`
- Modify: `src/renderer/main.tsx` (first lines: `import { installBridge } from './platform/bridge.js'; installBridge()` before anything reads `window.seashell`)
- Modify: `src/renderer/platform.ts` (platform comes from the bridge's `app:getPaths` reply field `platform` when preload is absent; add `platform: 'win32'` to the shim's `app:getPaths` response in Task 10)
- Create: `test/unit/bridge-surface.test.ts`
- Create: `scripts/win/pack-renderer.ps1`

**Interfaces:**
- Consumes: `encodeEnvelope`, `decodeEnvelope`, `HOST_CHANNELS` from `src/sidecar/protocol.ts`; the preload key tree in `src/preload/index.ts`.
- Produces: `installBridge(): void`, idempotent; after it, `window.seashell` has the key tree `files, pty, links, fs, watch, open, metrics, projects, session, app, update, window` with the same method names as the preload, every `on*` method returning an unsubscribe function exactly as the preload does.

- [ ] **Step 1: Failing surface test**

```ts
import { describe, expect, it } from 'vitest'
import { PRELOAD_SURFACE } from '../../src/preload/surface.js'
import { buildSurface } from '../../src/renderer/platform/bridge.js'

describe('WebView2 bridge surface', () => {
  it('has every key the preload exposes, with functions at the leaves', () => {
    const fake = { postMessage: () => {}, addEventListener: () => {} }
    const built = buildSurface(fake as never)
    for (const [group, keys] of Object.entries(PRELOAD_SURFACE)) {
      expect(built, group).toHaveProperty(group)
      for (const k of keys) expect(typeof (built as never)[group][k], `${group}.${k}`).toBe('function')
    }
  })
  it('an invoke resolves with the matching reply and ignores other ids', async () => {
    const listeners: Array<(e: { data: string }) => void> = []
    const sent: string[] = []
    const fake = { postMessage: (s: string) => sent.push(s), addEventListener: (_: string, f: (e: { data: string }) => void) => listeners.push(f) }
    const s = buildSurface(fake as never)
    const p = s.fs.probe({ path: '/x' })
    const req = JSON.parse(sent[0]!)
    listeners[0]!({ data: JSON.stringify({ k: 'reply', ch: 'fs:probe', id: req.id + 1, p: { exists: false } }) })
    listeners[0]!({ data: JSON.stringify({ k: 'reply', ch: 'fs:probe', id: req.id, p: { exists: true } }) })
    await expect(p).resolves.toEqual({ exists: true })
  })
})
```

`src/preload/surface.ts` is a new pure module listing the key tree as data (`export const PRELOAD_SURFACE = { files: ['list', ...], pty: ['spawn', 'kill', 'write', 'resize', 'ack', 'reportCwd', 'onData', 'onExit'], ... }`) extracted from `src/preload/index.ts`; the preload imports it and a second assertion in the same test file checks the preload's `api` object against it (import `api` by splitting `src/preload/index.ts` into `api.ts` that builds the object from an `ipcRenderer`-like parameter and `index.ts` that calls `contextBridge.exposeInMainWorld` with it).

- [ ] **Step 2: Implement bridge.ts**

```ts
/**
 * Builds window.seashell over WebView2's postMessage when the Electron preload
 * is absent (spec 4.4). Same key tree, same method names, same unsubscribe
 * contract. Host-owned channels and sidecar channels look identical from here.
 */
import { decodeEnvelope, encodeEnvelope, type Envelope } from '../../sidecar/protocol.js'
import { PRELOAD_SURFACE } from '../../preload/surface.js'
import { CHANNEL_FOR } from './channels.js'

interface WebViewLike { postMessage(s: string): void; addEventListener(t: 'message', f: (e: { data: string }) => void): void }

export function buildSurface(wv: WebViewLike): Record<string, Record<string, (...a: unknown[]) => unknown>> {
  let next = 1
  const pending = new Map<number, (p: unknown) => void>()
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  wv.addEventListener('message', (e) => {
    let env: Envelope
    try { env = decodeEnvelope(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) } catch { return }
    if (env.k === 'reply' && env.id !== undefined) { pending.get(env.id)?.(env.p); pending.delete(env.id); return }
    if (env.k === 'on') for (const f of listeners.get(env.ch) ?? []) f(env.p)
  })
  const invoke = (ch: string) => (p: unknown = {}) => new Promise((res) => { const id = next++; pending.set(id, res); wv.postMessage(encodeEnvelope({ k: 'invoke', ch, id, p })) })
  const send = (ch: string) => (p: unknown) => { wv.postMessage(encodeEnvelope({ k: 'send', ch, p })) }
  const on = (ch: string) => (f: (p: unknown) => void) => { const set = listeners.get(ch) ?? new Set(); set.add(f); listeners.set(ch, set); return () => { set.delete(f) } }
  const out: Record<string, Record<string, (...a: unknown[]) => unknown>> = {}
  for (const [group, keys] of Object.entries(PRELOAD_SURFACE)) {
    out[group] = {}
    for (const k of keys) {
      const spec = CHANNEL_FOR[`${group}.${k}`]
      if (!spec) throw new Error(`bridge: no channel mapping for ${group}.${k}`)
      out[group][k] = spec.kind === 'invoke' ? invoke(spec.ch) : spec.kind === 'send' ? send(spec.ch) : on(spec.ch)
    }
  }
  return out
}

export function installBridge(): void {
  const w = window as unknown as { seashell?: unknown; chrome?: { webview?: WebViewLike } }
  if (w.seashell || !w.chrome?.webview) return
  w.seashell = Object.freeze(buildSurface(w.chrome.webview))
}
```

`src/renderer/platform/channels.ts` is the data table `CHANNEL_FOR: Record<string, {kind:'invoke'|'send'|'on', ch: string}>` built by reading every `ipcRenderer.invoke('<ch>'`, `.send('<ch>'`, `.on('<ch>'` in the current `src/preload/index.ts` and writing one row per method (for example `'pty.spawn': {kind:'invoke', ch:'pty:spawn'}`, `'pty.write': {kind:'send', ch:'pty:write'}`, `'pty.onData': {kind:'on', ch:'pty:data'}`). A third test in `bridge-surface.test.ts` asserts every `PRELOAD_SURFACE` leaf has a `CHANNEL_FOR` row.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run test/unit/bridge-surface.test.ts --project unit` Expected: PASS, 3 tests. Run `npm test` Expected: everything else still green (the preload split must not change its behavior; `test/unit/preload*.test.ts` if present still passes).

- [ ] **Step 4: pack-renderer.ps1 and a first paint**

```powershell
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$dst = "$root\release\win-host\resources\renderer"
New-Item -ItemType Directory -Force $dst | Out-Null
robocopy "$root\out\renderer" $dst /MIR | Out-Null
Write-Output $dst
```

Build the renderer on the Windows tree (`cmd.exe /c "set PATH=C:\seashell-build\node;%PATH% && cd /d C:\seashell-build\redesign && npm run build"`), pack it, copy the host exe into `release\win-host\`, launch with `SEASHELL_USER_DATA=C:\seashell-build\redesign\scratch\host2` and `SEASHELL_CDP_PORT=9335`. Expected: the SeaShell chrome paints (tab bar, empty grid). Panes cannot spawn yet (no sidecar). `node scripts/cdp.mjs 9335 "Object.keys(window.seashell).join(',')"` Expected: the twelve groups. Screenshot to `bakeoff\stage1-first-paint.png`. Stop by pid (path contains `release\win-host`).

- [ ] **Step 5: Gate, snapshot, report**

`npm run typecheck && npm test` clean.

```bash
git add src/renderer/platform/bridge.ts src/renderer/platform/channels.ts src/preload/surface.ts src/preload/api.ts src/preload/index.ts src/renderer/main.tsx src/renderer/platform.ts test/unit/bridge-surface.test.ts scripts/win/pack-renderer.ps1
git commit -m "Serve the renderer from the WebView2 host through a bridge"
git branch -f snapshot/1002-after-host
```

Append "Stage 1: host" to the report.

---

## Stage 2: the sidecar (Task 10)

### Task 10: Electron shim and the sidecar entry

**Files:**
- Create: `src/sidecar/electron-shim.ts`, `src/sidecar/stdio-bridge.ts`, `src/sidecar/index.ts`
- Create: `scripts/build-sidecar.mjs`
- Create: `test/unit/electron-shim.test.ts`, `test/unit/stdio-bridge.test.ts`
- Modify: `src/main/index.ts` only if a top-level statement cannot run under the shim (record each such change in the commit message body as one line; expected: none, the shim is the adapter)

**Interfaces:**
- Consumes: every symbol listed in spec §4.3.
- Produces: `out/sidecar/index.cjs`; the sidecar answers `app:getPaths` with the existing fields plus `platform: 'win32'` and `host: 'webview2'`; `SEASHELL_APP_ID` for panes is `win32-<host pid>` from `--host-pid`.

- [ ] **Step 1: Failing shim tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createShim } from '../../src/sidecar/electron-shim.js'

describe('electron shim', () => {
  const out: string[] = []
  const shim = createShim({ write: (l) => out.push(l), hostPid: 4242, userData: 'C:\\scratch\\ud' })
  it('app paths come from the sidecar options', () => {
    expect(shim.app.getPath('userData')).toBe('C:\\scratch\\ud')
    expect(shim.app.requestSingleInstanceLock()).toBe(true)
  })
  it('webContents.send writes an on envelope', () => {
    shim.BrowserWindow.getAllWindows()[0]!.webContents.send('ui:notice', { id: 'x' })
    expect(JSON.parse(out.at(-1)!)).toEqual({ k: 'on', ch: 'ui:notice', p: { id: 'x' } })
  })
  it('ipcMain.handle answers an invoke with a reply of the same id', async () => {
    shim.ipcMain.handle('fs:probe', async (_e, p: { path: string }) => ({ exists: p.path === '/yes' }))
    await shim.__dispatch({ k: 'invoke', ch: 'fs:probe', id: 9, p: { path: '/yes' } })
    expect(JSON.parse(out.at(-1)!)).toEqual({ k: 'reply', ch: 'fs:probe', id: 9, p: { exists: true } })
  })
  it('an invoke on a channel with no handler replies with an error object instead of hanging', async () => {
    await shim.__dispatch({ k: 'invoke', ch: 'nope:x', id: 10, p: {} })
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ k: 'reply', id: 10, p: { ok: false, code: 'ENOHANDLER' } })
  })
  it('shell and clipboard relay to the host as invokes', async () => {
    void shim.shell.openPath('/Users/joshwald/a.txt')
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ k: 'invoke', ch: 'open:withDefaultApp', p: { path: '/Users/joshwald/a.txt' } })
  })
  it('Menu keeps the template and draws nothing', () => {
    const m = shim.Menu.buildFromTemplate([{ label: 'File', submenu: [{ label: 'New Pane', accelerator: 'Ctrl+Shift+D', click: vi.fn() }] }])
    shim.Menu.setApplicationMenu(m)
    expect(shim.Menu.getApplicationMenu()?.items[0]?.submenu?.items[0]?.accelerator).toBe('Ctrl+Shift+D')
  })
})
```

- [ ] **Step 2: Implement the shim**

`createShim(opts: { write: (line: string) => void, hostPid: number, userData: string })` returns `{ app, BrowserWindow, Menu, ipcMain, net, protocol, screen, shell, clipboard, dialog, __dispatch }` per spec §4.3. The module's default export for the esbuild alias is `createShim(globalThis.__seashellSidecar)` where `index.ts` sets `globalThis.__seashellSidecar` before importing anything from `src/main`. `__dispatch(env)` routes `invoke` to `ipcMain` handlers (reply `{ok:false, code:'ENOHANDLER', message}` when none), `send` to `ipcMain.on` listeners, `reply` to the pending host-invoke map (used by `shell`, `clipboard`, `dialog`, `screen`, which are invokes toward the host and resolve from its replies), and `on` with `ch` starting `app:` to the `app` emitter (`app:beforeQuit` raises `before-quit`, `app:secondInstance` raises `second-instance`).

`stdio-bridge.ts`: `startStdio(shim)` reads `process.stdin` line by line (a `\n` splitter that tolerates CRLF and buffers partial lines), decodes with `decodeEnvelope`, calls `shim.__dispatch`; `write` is `process.stdout.write(line + '\n')`. Test: feed two envelopes in one chunk and one split across chunks; both dispatch.

`index.ts`:

```ts
import { createShim } from './electron-shim.js'
import { startStdio } from './stdio-bridge.js'
const hostPid = Number(process.argv[process.argv.indexOf('--host-pid') + 1] || process.ppid)
const userData = process.env.SEASHELL_USER_DATA || `${process.env.APPDATA}\\seashell`
const shim = createShim({ write: (l) => process.stdout.write(l + '\n'), hostPid, userData })
;(globalThis as Record<string, unknown>).__seashellSidecar = shim
process.env.SEASHELL_APP_ID_OVERRIDE = `win32-${hostPid}`
startStdio(shim)
await import('../main/index.js')
```

`src/shared/wsl-shell.ts` already formats `win32-<pid>`; make it read `process.env.SEASHELL_APP_ID_OVERRIDE` first (one line, with a unit test in the existing wsl-shell test file).

`scripts/build-sidecar.mjs`:

```js
import { build } from 'esbuild'
await build({
  entryPoints: ['src/sidecar/index.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  outfile: 'out/sidecar/index.cjs', external: ['node-pty'],
  alias: { electron: './src/sidecar/electron-shim-default.ts' },
  define: { 'process.env.SEASHELL_HOST': '"webview2"' },
})
console.log('built out/sidecar/index.cjs')
```

`electron-shim-default.ts` exports the named symbols from `globalThis.__seashellSidecar` (so `import { app } from 'electron'` resolves to the live shim).

- [ ] **Step 3: Run the tests, build the sidecar**

`npx vitest run test/unit/electron-shim.test.ts test/unit/stdio-bridge.test.ts --project unit` Expected: PASS. `node scripts/build-sidecar.mjs` Expected: `out/sidecar/index.cjs`. Any `src/main` module that touches an Electron API outside §4.3 fails here with a clear name; add it to the shim with a test, do not stub it silently.

- [ ] **Step 4: First pane under the host**

Pack: renderer (Task 9), `resources\sidecar\index.cjs`, `resources\node\node.exe` (copy of `C:\seashell-build\node\node.exe`), `resources\node_modules\node-pty` (from the Windows tree's `node_modules\node-pty`, prebuild `win32-x64` only). Launch the scratch host (`scratch\host3`, CDP 9335). Expected: the tab bar, one pane, a zsh prompt at `/Users/joshwald`. Over CDP, write into the pane: `node scripts/cdp.mjs 9335 "window.seashell.pty.write({paneId: [...window.__seashellTerminals.keys()][0], data: 'echo $SEASHELL_PANE_ID $SEASHELL_APP_ID $ZDOTDIR; cat ~/.cache/seashell-win/pids/*/pane-*.pid | tail -1\\r'})"`. Read the screen back with `node scripts/cdp.mjs 9335 "[...window.__seashellTerminals.values()][0].term.buffer.active.getLine(1).translateToString()"` and the following lines. Expected: a pane id, `win32-<host pid>`, the shim dir under `~/.cache/seashell-win/zdotdir`, and a pid file line `<pid> pts/N`.

- [ ] **Step 5: The nesting check (Review Focus 3)**

From that pane type `SEASHELL_USER_DATA=C:\seashell-build\redesign\scratch\host4 /mnt/c/seashell-build/redesign/release/win-host/SeaShell.exe &` (a second scratch host launched from inside a pane; the single-instance mutex is per user data folder, so give the second one `SEASHELL_INSTANCE=host4` and make the mutex name `Local\SeaShellHost-<SEASHELL_INSTANCE or 'default'>`; add that to `window.cpp`). In the new window's pane: `echo $SEASHELL_USER_ZDOTDIR` Expected: Josh's real `$HOME`, never a path under `.cache/seashell-win/zdotdir`. Stop both by pid.

- [ ] **Step 6: Throughput (Review Focus 2)**

In a pane: `head -c 50000000 /dev/urandom | base64 | head -c 50000000; echo DONE`. Watch `measure-ram.ps1 -Samples 3 -GapSeconds 5` during it. Expected: the sidecar private memory rises and falls back within 30 s of `DONE`; the UI stays responsive (`cdp.mjs` evaluates in under 2 s during the flood). If private memory climbs past 400 MB, the `pty:ack` window is not being honored across the bridge: check that `pty:ack` sends reach `src/main/pty/manager.ts` (log the count) before any other change.

- [ ] **Step 7: Gate, snapshot, report**

`npm run typecheck && npm test` clean; `node scripts/build-sidecar.mjs` clean.

```bash
git add src/sidecar scripts/build-sidecar.mjs test/unit/electron-shim.test.ts test/unit/stdio-bridge.test.ts src/shared/wsl-shell.ts test/unit/wsl-shell.test.ts
git commit -m "Run the main process as a Node sidecar behind an Electron shim"
git branch -f snapshot/1002-after-sidecar
```

Append "Stage 2: sidecar" to the report.

---

## Stage 3: packaging and the headline number (Task 11)

### Task 11: pack-host.ps1 and the W10 measurement of the real app

**Files:**
- Create: `scripts/win/pack-host.ps1`
- Create: `scripts/bakeoff/run-host.ps1`

- [ ] **Step 1: pack-host.ps1**

```powershell
# Assemble release\win-host from the host build, the renderer, the sidecar and Node (spec 9).
param([string]$Config = 'Release')
$ErrorActionPreference = 'Stop'
$root = 'C:\seashell-build\redesign'
$out = "$root\release\win-host"
New-Item -ItemType Directory -Force "$out\resources\sidecar", "$out\resources\node", "$out\resources\node_modules" | Out-Null
Copy-Item "$root\host-build\$Config\SeaShell.exe" "$out\SeaShell.exe" -Force
robocopy "$root\out\renderer" "$out\resources\renderer" /MIR | Out-Null
Copy-Item "$root\out\sidecar\index.cjs" "$out\resources\sidecar\index.cjs" -Force
Copy-Item 'C:\seashell-build\node\node.exe' "$out\resources\node\node.exe" -Force
robocopy "$root\node_modules\node-pty" "$out\resources\node_modules\node-pty" /MIR /XD prebuilds | Out-Null
robocopy "$root\node_modules\node-pty\prebuilds\win32-x64" "$out\resources\node_modules\node-pty\prebuilds\win32-x64" /MIR | Out-Null
if (-not (Test-Path "$out\resources\node_modules\node-pty\prebuilds\win32-x64")) { throw 'node-pty win32-x64 prebuild missing' }
$size = [math]::Round(((Get-ChildItem $out -Recurse | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Output "packed $out ($size MB)"
```

The host must find `node_modules\node-pty` from the sidecar: set `NODE_PATH=<resources>\node_modules` in the sidecar's environment in `sidecar.cpp` (Task 8) so `require('node-pty')` resolves.

- [ ] **Step 2: run-host.ps1 (the real app at W10)**

Same shape as `run-electron.ps1` with `$Exe = "$root\release\win-host\SeaShell.exe"`, `SEASHELL_CDP_PORT=9342` instead of the Electron flag, label `E-host`, `-UdfSubstring 'host-scratch\webview2'`, scratch `$root\bakeoff\host-scratch`, screenshot `E-host.png`.

- [ ] **Step 3: Run and record**

Expected: `panes: 10`, an `E-host` row. Append it to spec §13 as a fifth measured row ("E, the built app at W10") and to the report. If `E-host` WS is 200 or more while B + C was under 200, list the three biggest processes from the `samples` with their names (extend `measure-ram.ps1` to include a `top3` array of `{name, wsMB}`) and the gap is the first item of Task 15's follow-ups; the run continues.

- [ ] **Step 4: Gate, snapshot, report**

```bash
git add scripts/win/pack-host.ps1 scripts/bakeoff/run-host.ps1 docs/superpowers/specs/2026-10-02-seashell-redesign.md
git commit -m "Package the host build and measure it at W10"
git branch -f snapshot/1002-after-pack
```

Append "Stage 3: package and measure" to the report.

---

## Stage 4: Windows 7 Aero chrome (Task 12)

### Task 12: Retune the aero theme, Win7 controls, desktop colorization, real glass attempt

**Files:**
- Modify: `src/renderer/theme/tokens.ts` (the `aero` entry, values from spec §6.2; `THEME_PANE_STYLE.aero` unchanged)
- Create: `src/renderer/theme/colorization.ts`
- Modify: `src/renderer/theme/apply.ts` (`themeVars` takes an optional `colorization?: string` and overlays `colorizationToTokens` on the aero theme only)
- Modify: `src/renderer/styles.css` (Win7 control rules scoped to `:root[data-theme="aero"]`, spec §6.3)
- Modify: `src/renderer/app.tsx` (on win32 host with no saved theme choice, default `theme: 'aero'`; call `window.seashell.display.colorization()` once at boot through a new `display` group added to `PRELOAD_SURFACE`, `CHANNEL_FOR` and the preload with a `{ok:false}` answer under Electron)
- Modify: `native/host/src/window.cpp` (6.4 attempt behind env `SEASHELL_REAL_GLASS=1`)
- Create: `test/unit/theme-aero.test.ts`, `test/unit/colorization.test.ts`

**Interfaces:**
- Produces: `colorizationToTokens(argb: string | null | undefined): Record<string, string>` (pure): parses `#AARRGGBB` or `#RRGGBB`, derives `--accent`, `--primaryBg`, `--primaryImg`, `--primaryBorder`, `--tabOnMark`, `--barBg` (`rgba(r,g,b,.22)`), `--barImg`, `--gridBg`, `--gridImg`, `--paneBorder`, `--line` by the fixed mixes in spec §6.2 (the table values are what `#881798` must produce exactly); returns the §6.2 table for null, undefined or unparsable input.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { colorizationToTokens } from '../../src/renderer/theme/colorization.js'
import { THEMES } from '../../src/renderer/theme/tokens.js'
import { themeVars } from '../../src/renderer/theme/apply.js'

describe('aero theme', () => {
  it('pins the terminal to Homebrew (decision 6)', () => {
    expect(THEMES.aero.vars['--termBg']).toBe('#000000')
    expect(THEMES.aero.vars['--termFg']).toBe('#28fe14')
    expect(THEMES.aero.vars['--paneBg']).toBe('#000000')
  })
  it('matches the live desktop colorization', () => {
    expect(THEMES.aero.vars['--accent']).toBe('#881798')
    expect(THEMES.aero.vars['--select']).toBe('#3399ff')
    expect(THEMES.aero.vars['--winRadius']).toBe('6px')
  })
  it('colorization 881798 reproduces the table and bad input falls back to it', () => {
    const t = colorizationToTokens('#C4881798')
    expect(t['--accent']).toBe('#881798')
    expect(t['--barBg']).toBe('rgba(136, 23, 152, .22)')
    expect(colorizationToTokens(undefined)).toEqual(t)
    expect(colorizationToTokens('nonsense')).toEqual(t)
  })
  it('themeVars overlays colorization on aero only', () => {
    const blue = themeVars({ theme: 'aero', paneStyle: 'theme', palette: 'native', crt: 'theme', accent: null }, '#FF2B7CD3')
    expect(blue['--accent']).toBe('#2b7cd3')
    const hb = themeVars({ theme: 'homebrew', paneStyle: 'theme', palette: 'native', crt: 'theme', accent: null }, '#FF2B7CD3')
    expect(hb['--accent']).toBe('#28fe14')
  })
})
```

- [ ] **Step 2: Implement tokens, colorization.ts, apply.ts**

Replace the `aero` vars with spec §6.2 (every row of the table; keep `--fu`, `--fm`, `--onAccent`, `--glassBlur`, `--barShadow`, `--cardShadow`, `--cardRotate`, `--btnText`, `--body`, `--sunken`, `--tabRadius`, `--tabOnBg`, `--tabOnImg`, `--winBorder`, `--winShadow`, `--g --c --y --r --b --m --gr` as they are). `colorization.ts`: parse, then `mix(hex, white, k)` and `mix(hex, black, k)` helpers with the k values chosen so `#881798` yields exactly the table (`--primaryImg` light stop = mix with white .45 = `#c09ccb`, dark stop = mix with black .22 = `#6a1277`, `--primaryBorder` = mix with black .34 = `#5a0f66`, `--paneBorder` = mix with white .25 then saturate... state the exact mixes you used in a comment and assert the table in the test; if a derived value cannot hit the table exactly, the table wins and the function returns the literal for `#881798` while deriving for other inputs). `apply.ts`: `themeVars(choice, colorization?)`.

- [ ] **Step 3: Win7 control CSS**

Append to `styles.css` under a `/* Windows 7 controls (aero theme only) */` comment, scoped `:root[data-theme="aero"]` (`applyTheme` sets `data-theme` on the element; add that one line if it does not): the button, scrollbar, tab, status bar, menu, card and pane title rules from spec §6.3 with the literal values there. The terminal's own scrollbar (`term/app-scrollbar.ts`) is untouched.

- [ ] **Step 4: Default and live colorization**

In `app.tsx`, where the saved `ThemeChoice` is read: if none is saved and `platform === 'win32'` and `window.seashell.app.getPaths()` reported `host: 'webview2'`, use `{ theme: 'aero', paneStyle: 'theme', palette: 'native', crt: 'theme', accent: null }`. Call `display.colorization()` once and pass its `argb` to `themeVars`. Hooks stay above the `if (!ready) return` line.

- [ ] **Step 5: Real glass attempt**

In `window.cpp`, when `SEASHELL_REAL_GLASS=1`: `MARGINS m{0, 0, <tab bar px>, 0}; DwmExtendFrameIntoClientArea(hwnd, &m)` after creation, and in `webview.cpp` `ICoreWebView2Controller2::put_DefaultBackgroundColor({0,0,0,0})`. In the renderer, when the `app:getPaths` reply carries `realGlass: true` (the host sets it from the env), set `--barBg: transparent` and `--barImg: none` on the aero theme. Launch a scratch host with the env, screenshot the tab strip with `test:screenshot`. Keep it if the strip shows the desktop through purple glass; if it is black or opaque, remove the env from `run-host.ps1` and record "painted glass" in the report. Either way, commit the code behind the env.

- [ ] **Step 6: Screenshots at 1x**

With the packed app at W10 on the MSI (DPR 1): whole window, tab strip, explorer with a selected row, the Restore card (relaunch the scratch to get it). Save as `bakeoff\aero-*.png`.

- [ ] **Step 7: Gate, snapshot, report**

`npm run typecheck && npm test` clean; repack; `E-host` measured again (theme CSS must not move the number by more than 5 MB).

```bash
git add src/renderer/theme/tokens.ts src/renderer/theme/colorization.ts src/renderer/theme/apply.ts src/renderer/styles.css src/renderer/app.tsx src/preload/surface.ts src/renderer/platform/channels.ts native/host/src/window.cpp native/host/src/webview.cpp test/unit/theme-aero.test.ts
git commit -m "Finish the Windows 7 Aero chrome and follow the desktop colorization"
git branch -f snapshot/1002-after-aero
```

Append "Stage 4: Aero chrome" with the PNG paths and the real-glass outcome.

---

## Stage 5: path double-click (Task 13)

### Task 13: The §7 matrix on the packed app

**Files:**
- Create: `scripts/bakeoff/path-matrix.mjs`
- Modify: `test/unit/tokenizer.test.ts` (add the Review Focus 4 row if absent: `'/Users/joshwald/My Notes/a.md:12'` quoted and unquoted yields path `/Users/joshwald/My Notes/a.md`, line 12)

- [ ] **Step 1: Unit row**

Add to the tokenizer test: `expect(tokenizeLine("'/Users/joshwald/My Notes/a.md:12'")[0]).toMatchObject({ path: '/Users/joshwald/My Notes/a.md', line: 12 })`. Run it. If it fails, fix the quote-then-suffix order in `tokenizer.ts` step 4 so a quoted path with a suffix inside the quotes still splits; commit separately as `Split a line suffix inside a quoted path`.

- [ ] **Step 2: The driver**

`scripts/bakeoff/path-matrix.mjs` (run with the Windows Node against CDP 9342 on the packed scratch host whose pane cwd is `/Users/joshwald/seashell-wt/redesign`):

```js
// Prints three paths in a real pane, double-clicks each, and asserts the explorer
// row / preview pane the spec section 7 matrix expects. Exit 1 on the first miss.
import { execFileSync } from 'node:child_process'
const port = process.argv[2] ?? '9342'
const cdp = (expr) => JSON.parse(execFileSync('node', ['scripts/cdp.mjs', port, expr], { encoding: 'utf8' }).trim())
const click = (x, y, mods = 0) => execFileSync('node', ['scripts/cdp.mjs', port, '--dblclick', String(x), String(y), String(mods)])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CASES = [
  { print: '/Users/joshwald/seashell-wt/redesign/README.md', reveal: '\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\seashell-wt\\redesign\\README.md', preview: 'README.md' },
  { print: '/mnt/c/seashell-build/redesign/bakeoff/results.jsonl', reveal: 'C:\\seashell-build\\redesign\\bakeoff\\results.jsonl', preview: 'results.jsonl' },
  { print: 'src/main/index.ts:45', reveal: '\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\seashell-wt\\redesign\\src\\main\\index.ts', preview: 'index.ts', line: 45 },
  { print: "'/Users/joshwald/My Notes/a.md:12'", reveal: null, toast: true },
]

const paneId = cdp('[...window.__seashellTerminals.keys()][0]')
cdp(`window.seashell.pty.write({paneId: ${JSON.stringify(paneId)}, data: 'clear; cd ~/seashell-wt/redesign\\r'})`)
await sleep(800)
for (const c of CASES) {
  cdp(`window.seashell.pty.write({paneId: ${JSON.stringify(paneId)}, data: ${JSON.stringify('printf %s\\\\n ' + JSON.stringify(c.print) + '\r')}})`)
  await sleep(600)
  const geo = cdp(`(() => { const t = [...window.__seashellTerminals.values()][0]; const cell = t.term._core._renderService.dimensions.css.cell; const el = t.term.element.getBoundingClientRect(); const buf = t.term.buffer.active; let row = -1; for (let r = buf.baseY + buf.cursorY - 1; r >= 0; r--) { if (buf.getLine(r).translateToString().includes(${JSON.stringify(c.print.replace(/^'|'$/g, ''))})) { row = r - buf.viewportY; break } } return { x: el.left + cell.width * 3, y: el.top + cell.height * (row + 0.5) } })()`)
  click(geo.x, geo.y)
  await sleep(1200)
  if (c.reveal) {
    const sel = cdp(`document.querySelector('.node--selected')?.getAttribute('data-path') ?? null`)
    if (sel !== c.reveal) { console.error(`MISS reveal for ${c.print}: got ${sel}`); process.exit(1) }
    click(geo.x, geo.y, 2)
    await sleep(1200)
    const title = cdp(`[...document.querySelectorAll('.pane__title')].map(e => e.textContent.trim()).find(t => t.endsWith(${JSON.stringify(c.preview)})) ?? null`)
    if (!title) { console.error(`MISS preview for ${c.print}`); process.exit(1) }
    if (c.line) {
      const visible = cdp(`(() => { const v = document.querySelector('.viewer'); if (!v) return null; const ln = v.querySelector('[data-line="${c.line}"]'); if (!ln) return null; const r = ln.getBoundingClientRect(), b = v.getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom })()`)
      if (visible !== true) { console.error(`MISS line ${c.line} not visible for ${c.print}`); process.exit(1) }
    }
  } else if (c.toast) {
    const toast = cdp(`document.querySelector('.toast')?.textContent ?? null`)
    if (!toast) { console.error(`MISS toast for ${c.print}`); process.exit(1) }
  }
  console.log(`ok ${c.print}`)
}
console.log('matrix passed')
```

The selectors `.node--selected`, `data-path`, `.pane__title`, `.viewer`, `[data-line]`, `.toast` are the ones in `src/renderer/explorer/Explorer.tsx`, `src/renderer/panes`, `src/renderer/viewer` and the toast component today; if a name differs, read the component and use its real class, do not change the component for the test.

- [ ] **Step 3: Run it, save evidence**

Launch the packed scratch host (`scratch\host-matrix`, CDP 9342), run `node scripts/bakeoff/path-matrix.mjs 9342` from `C:\seashell-build\redesign` with the Windows Node. Expected: four `ok` lines and `matrix passed`. Screenshot after the third case to `bakeoff\path-line45.png`. Any `MISS` is a real regression: fix it in the renderer or sidecar code path it names (never in the driver), rerun, and record the fix in the report.

- [ ] **Step 4: Gate, snapshot, report**

```bash
git add scripts/bakeoff/path-matrix.mjs test/unit/tokenizer.test.ts
git commit -m "Prove path double-click on the host build"
git branch -f snapshot/1002-after-paths
```

Append "Stage 5: path double-click" with the four results and the PNG.

---

## Stage 6: contracts (Task 14)

### Task 14: Control endpoint, session files, pane env, window identity

**Files:**
- Create: `scripts/bakeoff/contracts.sh`
- Create: `test/unit/host-channels-sync.test.ts`

- [ ] **Step 1: The host/sidecar channel list stays in sync**

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOST_CHANNELS } from '../../src/sidecar/protocol.js'

describe('HOST_CHANNELS', () => {
  it('is the same list in bridge.cpp', () => {
    const cpp = readFileSync('native/host/src/bridge.cpp', 'utf8')
    for (const ch of HOST_CHANNELS) expect(cpp, ch).toContain(`"${ch}"`)
    const count = (cpp.match(/"[a-z]+:[A-Za-z]+"/g) ?? []).filter((s) => HOST_CHANNELS.includes(s.slice(1, -1))).length
    expect(count).toBe(HOST_CHANNELS.length)
  })
})
```

- [ ] **Step 2: contracts.sh**

```bash
#!/usr/bin/env bash
# Runs the four control clients and the session checks against a scratch host (spec 8).
set -euo pipefail
SCRATCH_WIN="${1:-C:\\seashell-build\\redesign\\scratch\\host-contracts}"
SCRATCH="/mnt/c/seashell-build/redesign/scratch/host-contracts"
export SEASHELL_CONTROL_JSON="$SCRATCH_WIN\\control.json"
test -s "$SCRATCH/control.json" || { echo "no control.json in scratch"; exit 1; }
PANE=$(python3 - <<'EOF'
import json,glob,os
# the registry entry the pane's claude wrote; pick the newest win32- app id
rows=sorted(glob.glob(os.path.expanduser('~/.claude/session-registry/*.json')), key=os.path.getmtime)
for r in reversed(rows):
    d=json.load(open(r))
    if str(d.get('app_id','')).startswith('win32-'): print(d.get('pane_id','')); break
EOF
)
echo "pane: $PANE"
python3 ~/.claude/bin/send-to-pane.py "$PANE" "reply with only the word ok" && echo "send-to-pane: ok"
python3 ~/.claude/bin/register-session.py --check 2>/dev/null || echo "register-session: see its own log"
python3 ~/autopilot/restart/restart_seashell.py --probe 2>&1 | tail -3
echo "--- session files"
python3 - "$SCRATCH" <<'EOF'
import json,sys,os
d=sys.argv[1]
ls=json.load(open(os.path.join(d,'last-session.json')))
assert ls['schemaVersion']==1, ls['schemaVersion']
panes=[p for t in ls['tabs'] for p in t['panes'].values()]
cl=[p for p in panes if p['command']=='claude']
assert cl and all('claudeSessionId' in p for p in cl), 'claude pane saved without an id'
print('last-session.json ok:', len(ls['tabs']), 'tabs', len(panes), 'panes', len(cl), 'claude with ids')
EOF
echo "--- window identity"
powershell.exe -NoProfile -Command "Get-Process SeaShell | Where-Object Path -like '*win-host*' | Select-Object Id,MainWindowTitle,Path | Format-List" | tr -d '\r'
```

If `register-session.py` or `restart_seashell.py` has no `--check` / `--probe` flag, read the script's argument parsing and use what it offers (the 10/01 run used `restart_seashell.py` connect-only logging); never run their restart paths.

- [ ] **Step 3: Run it**

Launch the packed scratch host (`scratch\host-contracts`, CDP 9343); in its pane start `claude --dangerously-skip-permissions`; wait for the badge; run `scripts/bakeoff/contracts.sh`. Expected: `send-to-pane: ok` with claude answering `ok` in the pane, a `last-session.json ok` line with 1 claude pane carrying an id, the window row with title `SeaShell` and the `win-host` path. Then quit the scratch host through its own close button over CDP (`window.seashell.window.close()`), relaunch it, and confirm the Restore card offers the claude pane and resumes it (screenshot `bakeoff\restore-host.png`). Stop by pid.

Also run, in WSL: `pane-hook` equivalence check: `grep -n 'Chrome_WidgetWin_1\|SEASHELL_APP_ID' ~/.config/seashell-work/pane-hook.zsh` and whatever file the SC Cockpit matcher lives in (search `~/.claude/throttle-work-pages` or the `throttle-work-pages` memory for its path). Copy the exact lines into the report's follow-up with the replacement class `SeaShellHost`. Do not edit them.

- [ ] **Step 4: Gate, snapshot, report**

```bash
git add scripts/bakeoff/contracts.sh test/unit/host-channels-sync.test.ts
git commit -m "Prove the control, session and identity contracts on the host build"
git branch -f snapshot/1002-after-contracts
```

Append "Stage 6: contracts" to the report.

---

## Stage 7: report (Task 15)

### Task 15: The report Josh reads

**Files:**
- Create or finish: `~/.codex/notes/seashell-report-1002.md`
- Modify: `README.md` (a "Host build (Windows, experimental)" paragraph: what it is, where it builds, that it is not the installed app)

- [ ] **Step 1: Sections, in this order**

```
# SeaShell redesign, 10/02 (report)
## Where it stopped (one line: stage reached, time, why)
## Stage 0: bake-off (the section 13 table, rule, chosen, four PNGs)
## Stage 1: host
## Stage 2: sidecar
## Stage 3: package and measure (E-host number vs 416/555 baseline, pass or not)
## Stage 4: Aero chrome (PNGs, real glass outcome)
## Stage 5: path double-click (four results, PNG)
## Stage 6: contracts (clients, session files, identity)
## Branch and snapshots (redesign/1002 head, every snapshot/1002-* sha)
## Scratch build path and how to launch it (SEASHELL_USER_DATA, never Programs\SeaShell)
## Follow-ups (cockpit matcher + pane-hook lines with SeaShellHost; autopilot restart; updater asset name; anything dropped)
## Not verified
```

Each stage task above appends its section when it finishes; this task writes "Where it stopped", "Branch and snapshots", "Scratch build path", "Follow-ups", "Not verified", and fills any stage section that was skipped with one line saying so and why.

- [ ] **Step 2: Final checks**

Run: `git -C ~/Desktop/seashell status -sb` Expected: `## main...origin/main`, clean. `git -C ~/seashell-wt/redesign log --oneline main..HEAD` lists the one-line commits. `powershell.exe -NoProfile -Command "Get-Process SeaShell | Select-Object Id,Path"` lists only Josh's `Programs\SeaShell` processes (every scratch instance stopped). `ls %APPDATA%\seashell` was never written by the run: `ls -la --time-style=full-iso /mnt/c/Users/josh/AppData/Roaming/seashell/` shows no mtime after 08:00 today except what Josh's own app wrote (`last-session.json` ticks every 30 s; `projects.json` only on his saves).

- [ ] **Step 3: Commit and final snapshot**

```bash
git add README.md
git commit -m "Describe the experimental Windows host build"
git branch -f snapshot/1002-final
```

Nothing is pushed. The report file is outside the repo.
