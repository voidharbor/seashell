#!/usr/bin/env node
// The Phase 1 gates (plan Task 18 steps 1 to 6), plus the Phase 2 relay line
// (Task 1) and the Phase 2 gate's matrix, inventory and W10 lines (Task 20),
// against a running scratch native shell, driven through its loopback test
// driver. Prints one line per gate and writes the numbers as
// JSON. Runs under WSL's node so it can read the core's /proc entry and the
// pid files directly.
//
// Usage (from WSL, or from scripts/win/run-native-gates.ps1 through wsl.exe):
//   node scripts/native-gates.mjs <userDataWin> --shell-pid <pid>
//        [--gates env,throughput,latency,relay,nesting,control,restore,matrix,inventory] [--out <C:\...json>]
//
// env, throughput, latency, relay, control and nesting run against the shell whose
// userData is given. restore seeds and launches its own scratch (two launches)
// and nesting launches a second shell from inside a pane; both are quit through
// their own driver and only ever stopped by pid, never by image name. matrix
// and inventory (Phase 2 Task 20) run scripts/native-matrix.mjs and
// scripts/native-inventory.mjs from the worktree, each with its own scratch,
// and print one summary line. w10a and w10b (not in the default list, run on
// purpose with Edge closed and no other release shell up) run
// scripts/win/run-native-w10.ps1 -Variant a or b; with Edge open they print
// "not measured, Edge was open" and launch nothing.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.HOME
const BUILD_WIN = 'C:\\seashell-build\\redesign'
const RELEASE_WIN = `${BUILD_WIN}\\release\\win-native`
const RELEASE_LINUX = '/mnt/c/seashell-build/redesign/release/win-native'
const SCRATCH_WIN = `${BUILD_WIN}\\scratch`
const SHIM_ZDOTDIR = `${HOME}/.cache/seashell-win/zdotdir`
const PIDS = `${HOME}/.cache/seashell-win/pids`
const REGISTRY = `${HOME}/.claude/session-registry`
const SEND_TO_PANE = `${HOME}/.claude/bin/send-to-pane.py`
const MAKE_SESSION = join(ROOT, 'scripts', 'bakeoff', 'make-session.mjs')
// The worktree the C:\ copy is synced from (scripts/win/sync-tree.sh). The
// matrix and the inventory run from there: the matrix's printed paths are the
// worktree's, and the inventory writes its status doc next to the spec.
const WORKTREE = (() => {
  const w = process.env.SEASHELL_WORKTREE || `${HOME}/seashell-wt/redesign`
  return existsSync(join(w, 'scripts', 'native-matrix.mjs')) ? w : ROOT
})()
const STATUS_DOC = join(WORKTREE, 'docs', 'superpowers', 'specs', '2026-10-02-seashell-inventory-status.md')
// The W10 bar (redesign spec section 2) and Phase 1's figure (Task 18).
const W10_BAR_MB = 200
const W10_PHASE1_MB = 110.8
// Spec 4.7: the shell's own budget is 70 MB working set; the throughput gate
// allows the budget plus 40 MB at the peak of the flood.
const SHELL_BUDGET_MB = 70

// Run as a CLI, or imported for its helpers (scripts/native-matrix.mjs), in
// which case nothing below reads the arguments and no gate runs.
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
const argv = isMain ? process.argv.slice(2) : []
const udWin = argv[0]
if (isMain && (!udWin || udWin.startsWith('--'))) {
  console.error('usage: node scripts/native-gates.mjs <userDataWin> --shell-pid <pid> [--gates a,b,c] [--out <json>]')
  process.exit(2)
}
const opt = (name, d) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const shellPid = Number(opt('--shell-pid', '0'))
const gates = opt('--gates', 'env,throughput,latency,relay,nesting,control,restore,matrix,inventory').split(',').map((s) => s.trim()).filter(Boolean)
const outPath = opt('--out', '')

const toLocal = (p) => {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const r1 = (n) => Math.round(n * 10) / 10

// ---------------------------------------------------------------- the driver

function readTestJson(ud) {
  return JSON.parse(readFileSync(`${toLocal(ud)}/test.json`, 'utf8'))
}

function direct(port, line, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let settled = false
    const sock = connect({ host: '127.0.0.1', port })
    const done = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(err)
      else resolve(value)
    }
    const timer = setTimeout(() => done(Object.assign(new Error('timed out'), { connected: true })), timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(line + '\n'))
    sock.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl >= 0) done(null, buf.slice(0, nl))
    })
    sock.on('error', (e) => done(Object.assign(e, { connected: sock.bytesWritten > 0 })))
    sock.on('close', () => done(Object.assign(new Error('closed without a reply'), { connected: true })))
  })
}

// The request goes in as base64 so no quoting survives into PowerShell.
function relay(port, line, timeoutMs) {
  const b64 = Buffer.from(line + '\n', 'utf8').toString('base64')
  const ps = [
    `$c = New-Object System.Net.Sockets.TcpClient('127.0.0.1', ${port})`,
    `$c.ReceiveTimeout = ${timeoutMs}`,
    '$s = $c.GetStream()',
    `$b = [Convert]::FromBase64String('${b64}')`,
    '$s.Write($b, 0, $b.Length)',
    '$r = New-Object System.IO.StreamReader($s, [System.Text.Encoding]::UTF8)',
    '[Console]::Out.Write($r.ReadLine())',
    '$c.Close()',
  ].join('; ')
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { cwd: '/mnt/c', encoding: 'utf8', timeout: timeoutMs + 10000 }).trim()
}

// One request to the shell behind `ud`; the parsed reply. A wait or waitText
// runs up to its own timeoutMs on the shell's side.
async function drive(ud, req) {
  const { port, token } = readTestJson(ud)
  const line = JSON.stringify({ ...req, token })
  const timeoutMs = (typeof req.timeoutMs === 'number' ? req.timeoutMs : 0) + 20000
  let reply
  try {
    reply = await direct(port, line, timeoutMs)
  } catch (e) {
    if (e.connected) throw new Error(`driver ${req.cmd}: ${e.message}`)
    reply = relay(port, line, timeoutMs)
  }
  return JSON.parse(reply)
}

async function model(ud) {
  const m = await drive(ud, { cmd: 'model' })
  if (m.ok === false) throw new Error(`driver model: ${m.code}`)
  return m
}

async function must(ud, req, what) {
  const r = await drive(ud, req)
  if (!r.ok) throw new Error(`${what}: ${r.code || 'failed'}${r.error ? ' ' + r.error : ''}`)
  return r
}

// stats replies with the numbers and no ok field.
async function stats(ud) {
  const s = await drive(ud, { cmd: 'stats' })
  if (!s.frameMs) throw new Error(`stats: ${s.code || 'no frameMs'}`)
  return s
}

async function focusedPane(ud) {
  const m = await model(ud)
  const p = m.panes.find((x) => x.focused) || m.panes[0]
  if (!p) throw new Error('no pane in the model')
  return p.id
}

// The shell pid behind `ud`: the one given, the main scratch's, or the pid
// its control.json records; 0 when none is known (the tty check then refuses).
function shellPidOf(ud, pid) {
  if (pid) return pid
  if (ud === udWin && shellPid) return shellPid
  try {
    return Number(JSON.parse(readFileSync(`${toLocal(ud)}/control.json`, 'utf8')).pid) || 0
  } catch {
    return 0
  }
}

// Types a command line and presses Enter through the shell's own key path,
// after the tty check of every grid that could take the keys (guardKeys): it
// refuses while a claude process is on that tty, since the line would land in
// claude's input box and the Enter would submit it as a prompt, and it refuses
// when the tty cannot be resolved at all (fails closed).
async function run(ud, cmdline, pid) {
  const checkPid = shellPidOf(ud, pid)
  await guardKeys(ud, checkPid)
  await must(ud, { cmd: 'text', s: cmdline }, 'text')
  await guardKeys(ud, checkPid)
  await must(ud, { cmd: 'key', chord: 'Enter' }, 'key Enter')
}

// "GATE-END" typed as GATE-EN''D so the echoed command line never matches
// the marker the output prints.
const marker = (tag) => `${tag.slice(0, -1)}''${tag.slice(-1)}`

async function gridRows(ud, paneId) {
  const g = await must(ud, { cmd: 'grid', paneId }, 'grid')
  return g.text
}

async function waitText(ud, paneId, contains, timeoutMs) {
  const r = await drive(ud, { cmd: 'waitText', paneId, contains, timeoutMs })
  if (!r.ok) {
    const tail = Array.isArray(r.text) ? r.text.filter((t) => t.trim()).slice(-6).join(' | ') : ''
    throw new Error(`"${contains}" never appeared in ${timeoutMs} ms (${tail})`)
  }
}

// Polls the grid until one of `needles` is on screen. For a prompt whose
// exact frame glyphs depend on the user's Claude Code configuration.
async function waitAny(ud, paneId, needles, timeoutMs) {
  const end = now() + timeoutMs
  let rows = []
  for (;;) {
    rows = await gridRows(ud, paneId)
    const all = rows.join('\n')
    const hit = needles.find((n) => all.includes(n))
    if (hit) return hit
    if (now() >= end) break
    await sleep(1000)
  }
  const tail = rows.filter((t) => t.trim()).slice(-6).join(' | ')
  throw new Error(`none of ${JSON.stringify(needles)} appeared in ${timeoutMs} ms (${tail})`)
}

// The value after `key=` on the last grid row that starts with it.
function field(rows, key) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].startsWith(key + '=')) return rows[i].slice(key.length + 1)
  return null
}

// ------------------------------------------------------------ Windows helpers

function powershell(cmd, timeout = 60000) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', `Set-Location C:\\; ${cmd}`], { cwd: '/mnt/c', encoding: 'utf8', timeout }).trim()
}

function pidAlive(pid) {
  return powershell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`) === 'alive'
}

async function waitGone(pid, timeoutMs) {
  const end = now() + timeoutMs
  while (now() < end) {
    if (!pidAlive(pid)) return true
    await sleep(500)
  }
  return !pidAlive(pid)
}

// Every scratch a gate prepares starts with the tutorial seen (plan Task 14):
// on a fresh userData the first-run tutorial sheet would hold the keyboard and
// dim the window. Whatever else ui-state.json already holds is kept.
function seedUiState(udLinux) {
  mkdirSync(udLinux, { recursive: true })
  const file = `${udLinux}/ui-state.json`
  let state = {}
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  if (typeof state !== 'object' || state === null || Array.isArray(state)) state = {}
  writeFileSync(file, JSON.stringify({ ...state, tutorialSeen: true }, null, 2))
}

// Launches release\win-native\SeaShell.exe for the scratch `name` without
// SEASHELL_CORE_DIR (the core is staged, spec 4.5) and with the test driver
// on, so the window never takes focus. Returns the Windows pid. The scratch's
// ui-state.json says the tutorial was seen unless `tutorial` is set (the
// tutorial's own check launches it on a fresh userData).
function launchShell(name, { tutorial = false } = {}) {
  const ud = `${SCRATCH_WIN}\\${name}`
  if (!tutorial) seedUiState(toLocal(ud))
  const ps = [
    `Set-Location '${RELEASE_WIN}'`,
    `New-Item -ItemType Directory -Force -Path '${ud}' | Out-Null`,
    'Remove-Item Env:SEASHELL_CORE_DIR -ErrorAction SilentlyContinue',
    `$env:SEASHELL_USER_DATA = '${ud}'`,
    "$env:SEASHELL_TEST_PORT = '0'",
    `$env:SEASHELL_INSTANCE = '${name}'`,
    `$env:SEASHELL_SHELL_LOG = '${ud}\\shell.log'`,
    `$p = Start-Process -FilePath '${RELEASE_WIN}\\SeaShell.exe' -WorkingDirectory '${RELEASE_WIN}' -PassThru`,
    'Write-Output $p.Id',
  ].join('; ')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { cwd: '/mnt/c', encoding: 'utf8' }).trim()
  const pid = Number(out.split(/\s+/).pop())
  if (!pid) throw new Error(`launch of ${name} printed no pid: ${out}`)
  return pid
}

async function waitFile(path, timeoutMs) {
  const end = now() + timeoutMs
  while (now() < end) {
    if (existsSync(path)) return true
    await sleep(250)
  }
  return existsSync(path)
}

// Quit through the driver, then wait for the pid. A shell that stays is
// stopped by its own pid (the command names release/win-native, as the kill
// guard requires); never by image name.
async function quitShell(ud, pid, label) {
  try {
    await drive(ud, { cmd: 'quit' })
  } catch (e) {
    console.error(`${label}: driver quit failed: ${e.message}`)
  }
  if (await waitGone(pid, 20000)) return 'quit'
  // stop-tree.ps1 stops the root and its children by pid and refuses any
  // process from Programs\SeaShell (the scratch ${label} runs from release/win-native).
  try {
    powershell(`& '${BUILD_WIN}\\scripts\\win\\stop-tree.ps1' -RootPid ${pid}`)
  } catch (e) {
    return `not stopped: stop-tree failed (${e.message.split('\n')[0]})`
  }
  await waitGone(pid, 5000)
  return 'stopped by pid (stop-tree) after the driver quit'
}

// Pids of SeaShell.exe processes running from the release layout.
function releaseShellPids() {
  const out = powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq '${RELEASE_WIN}\\SeaShell.exe' } | ForEach-Object { $_.ProcessId }`)
  return out.split(/\s+/).map(Number).filter((n) => n > 0)
}

// window-bounds.json holds DIPs, as Electron writes it (Phase 3 Task 7: the
// shell multiplies them by the DPI of the monitor they fall on): 1440x900 DIP
// at 100,100 (or x, y), not maximized, written unscaled.
function writeBounds(udLinux, { x = 100, y = 100 } = {}) {
  writeFileSync(`${udLinux}/window-bounds.json`, `{"x":${x},"y":${y},"width":1440,"height":900,"maximized":false}`)
}

function coreRssMB(pid) {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
  return m ? r1(Number(m[1]) / 1024) : NaN
}

function corePidOf(ud) {
  return Number(JSON.parse(readFileSync(`${toLocal(ud)}/control.json`, 'utf8')).corePid)
}

// --------------------------------------------------------------------- gates

// Step 1: the pane env and the pid file (spec 9), read from inside the pane.
async function gateEnv(ud) {
  await must(ud, { cmd: 'wait', path: '/panes/0/status', equals: 'live', timeoutMs: 60000 }, 'first pane live')
  const paneId = await focusedPane(ud)
  await run(ud, 'echo ID=$SEASHELL_PANE_ID; echo APP=$SEASHELL_APP_ID; echo Z=$ZDOTDIR; echo U=$SEASHELL_USER_ZDOTDIR; ' +
    'echo C=$(tr "\\0" "\\n" < /proc/$$/environ | grep "^COLORTERM=" | cut -d= -f2-); echo CL=${COLORTERM:-unset}; echo PID=$$; echo TTY=$(tty); ' +
    'echo PF=$(cat ~/.cache/seashell-win/pids/${SEASHELL_APP_ID#win32-}/pane-$SEASHELL_PANE_ID.pid); echo ' + marker('ENV-END'))
  await waitText(ud, paneId, 'ENV-END', 20000)
  const rows = await gridRows(ud, paneId)
  const got = Object.fromEntries(['ID', 'APP', 'Z', 'U', 'C', 'CL', 'PID', 'TTY', 'PF'].map((k) => [k, field(rows, k)]))
  const pf = /^(\d+) (pts\/\d+)$/.exec(got.PF || '')
  const bad = []
  if (got.ID !== paneId) bad.push(`ID=${got.ID} (model pane ${paneId})`)
  if (got.APP !== `win32-${shellPid}`) bad.push(`APP=${got.APP} (shell pid ${shellPid})`)
  if (got.Z !== SHIM_ZDOTDIR) bad.push(`Z=${got.Z}`)
  if (got.U !== HOME) bad.push(`U=${got.U}`)
  // C is COLORTERM in the pane's spawn-time environment (/proc/$$/environ);
  // CL is the live value, which Josh's own .zshrc exports as truecolor.
  if (got.C !== '') bad.push(`COLORTERM=${got.C} at spawn`)
  if (!pf) bad.push(`pid file line "${got.PF}"`)
  else {
    if (pf[1] !== got.PID) bad.push(`pid file pid ${pf[1]} is not the pane shell ${got.PID}`)
    if (`/dev/${pf[2]}` !== got.TTY) bad.push(`pid file tty ${pf[2]} is not the pane tty ${got.TTY}`)
  }
  const detail = `pane ${got.ID}, app ${got.APP}, ZDOTDIR shim, SEASHELL_USER_ZDOTDIR ${got.U}, COLORTERM unset at spawn (live ${got.CL}, from .zshrc), pid file "${got.PF}"`
  if (bad.length) throw new Error(`${bad.join('; ')} (${detail})`)
  return { line: `env: ok (${detail})`, ok: true, values: got }
}

// Step 2: a pane prints 50 MB (Review Focus 2). Polls stats every second and
// the core's RSS from /proc, then watches the settle for 30 s after DONE.
async function gateThroughput(ud) {
  const paneId = await focusedPane(ud)
  const corePid = corePidOf(ud)
  const s0 = await stats(ud)
  const start = { shellWsMB: s0.shellWsMB, coreRssMB: coreRssMB(corePid) }
  const peak = { p95: 0, shellWsMB: start.shellWsMB, coreRssMB: start.coreRssMB, ptyBytesLast5s: 0 }
  let floodFrames = 0   // frames painted in the 5 s windows sampled during the flood
  // stats.paint (Phase 3 Task 4): the busiest second of body paints in any
  // window sampled up to DONE, and the refresh rate the shell caps them at.
  let paintMax = null
  let refreshHz = null
  const samples = []
  const t0 = now()
  await run(ud, `head -c 50000000 /dev/urandom | base64 | head -c 50000000; echo; echo ${marker('FLOOD-DONE')}`)
  let done = false
  while (!done) {
    const r = await drive(ud, { cmd: 'waitText', paneId, contains: 'FLOOD-DONE', timeoutMs: 1000 })
    done = !!r.ok
    const s = await stats(ud)
    const rss = coreRssMB(corePid)
    samples.push({ t: r1((now() - t0) / 1000), p95: s.frameMs.p95, frames5s: s.framesLast5s, shellWsMB: s.shellWsMB, coreRssMB: rss, ptyBytesLast5s: s.ptyBytesLast5s, paintMax5s: s.paint?.perSecondMax ?? null })
    // p95 is 0 when no frame landed in the window, which is not a fast frame.
    if (s.framesLast5s > 0) peak.p95 = Math.max(peak.p95, s.frameMs.p95)
    if (!done) floodFrames += s.framesLast5s
    if (s.paint) {
      paintMax = Math.max(paintMax ?? 0, s.paint.perSecondMax)
      refreshHz = s.paint.refreshHz
    }
    peak.shellWsMB = Math.max(peak.shellWsMB, s.shellWsMB)
    peak.coreRssMB = Math.max(peak.coreRssMB, rss)
    peak.ptyBytesLast5s = Math.max(peak.ptyBytesLast5s, s.ptyBytesLast5s)
    if (!done && now() - t0 > 120000) {
      throw new Error(`the flood did not finish in 120 s (p95 ${peak.p95} ms, shell ${peak.shellWsMB} MB, core ${peak.coreRssMB} MB)`)
    }
  }
  const floodS = r1((now() - t0) / 1000)
  await sleep(30000)
  const s1 = await stats(ud)
  const after = { shellWsMB: s1.shellWsMB, coreRssMB: coreRssMB(corePid) }
  // The plan's criterion is the 30 s point; the settle is followed to 120 s
  // for the report, 15 s apart, without touching the pane.
  const settle = [{ t: 30, shellWsMB: after.shellWsMB, coreRssMB: after.coreRssMB }]
  for (let t = 45; t <= 120; t += 15) {
    await sleep(15000)
    const sx = await stats(ud)
    settle.push({ t, shellWsMB: sx.shellWsMB, coreRssMB: coreRssMB(corePid) })
  }
  const settled = settle.find((x) => x.coreRssMB <= start.coreRssMB + 30)
  const bad = []
  if (floodFrames === 0) bad.push('no frame was painted in any window sampled during the flood')
  if (!(peak.p95 < 32)) bad.push(`frameMs.p95 peak ${peak.p95} is not under 32`)
  if (!(peak.shellWsMB < SHELL_BUDGET_MB + 40)) bad.push(`shell peak ${peak.shellWsMB} MB is not under ${SHELL_BUDGET_MB + 40}`)
  if (!(after.shellWsMB <= start.shellWsMB + 20)) bad.push(`shell ${after.shellWsMB} MB 30 s after DONE is not within 20 MB of the start ${start.shellWsMB}`)
  if (!(after.coreRssMB <= start.coreRssMB + 30)) bad.push(`core RSS ${after.coreRssMB} MB 30 s after DONE is not within 30 MB of the start ${start.coreRssMB}`)
  if (paintMax !== null && !(paintMax <= refreshHz + 5)) bad.push(`paintMax ${paintMax}/s is over the refresh rate ${refreshHz} plus 5`)
  const numbers = `p95=${peak.p95}ms shellWs start=${start.shellWsMB} peak=${peak.shellWsMB} after30s=${after.shellWsMB} ` +
    `coreRss start=${start.coreRssMB} peak=${peak.coreRssMB} after30s=${after.coreRssMB} after120s=${settle[settle.length - 1].coreRssMB} ` +
    `(${settled ? `within 30 MB of the start at ${settled.t} s` : 'not within 30 MB of the start by 120 s'}) flood=${floodS}s peakPty5s=${r1(peak.ptyBytesLast5s / 1048576)}MB floodFrames=${floodFrames} ` +
    `paintMax=${paintMax ?? 'n/a'}/s refreshHz=${refreshHz ?? 'n/a'}`
  const values = { start, peak, after, settle, floodS, samples, paintMax, refreshHz }
  if (bad.length) return { line: `throughput: fail ${numbers} (${bad.join('; ')})`, ok: false, values }
  return { line: `throughput: ok ${numbers}`, ok: true, values }
}

// Step 3: a divider drag of 200 moves, each waited for its ui:model.
async function gateLatency(ud) {
  await must(ud, { cmd: 'key', chord: 'Ctrl+Shift+D' }, 'key Ctrl+Shift+D')
  await must(ud, { cmd: 'wait', path: '/dividers/0/id', timeoutMs: 10000 }, 'a divider after the split')
  await must(ud, { cmd: 'wait', path: '/panes/1/status', equals: 'live', timeoutMs: 60000 }, 'second pane live')
  const m = await model(ud)
  const d = m.dividers[0]
  const along = d.orientation === 'vertical' ? { dx: 200, dy: 0 } : { dx: 0, dy: 200 }
  const r = await must(ud, { cmd: 'drag', target: `divider:${d.id}`, ...along, steps: 200, stepTimeoutMs: 2000 }, 'drag')
  // Spec 10's bar is the median move-to-model time over the 200 moves (the
  // driver's moveMs). The average per step also carries each step's post and
  // wake and the release; it is printed beside it, and judged only when the
  // driver gave no moveMs.
  const average = r1(r.ms / r.steps)
  const median = typeof r.moveMs?.median === 'number' ? r.moveMs.median : null
  const perMove = median ?? average
  const counts = `${r.ms} ms for ${r.steps} moves, ${r.models} models, ${r.timeouts} timeouts, ${d.orientation} divider`
  const line = median !== null
    ? `latency: ${median} ms median per move (${average} ms average, ${counts})`
    : `latency: ${average} ms average per move (no moveMs from the driver, ${counts})`
  const ok = perMove < 2 && r.timeouts === 0
  // The model path and the paint block after the drag, for the json only.
  const st = await stats(ud)
  const after = { modelMs: st.modelMs ?? null, paint: st.paint ?? null }
  return { line: ok ? line : `${line}; the bar is under 2`, ok, values: { perMove, median, average, ...r, orientation: d.orientation, after } }
}

// Phase 2 Task 1: a bare core round trip, 200 in a row, timed by the driver
// (core:ping, answered on the core's stdin line handler without touching the
// controller). A measurement, not a bar: a median over 1.0 ms puts the
// divider's cost in the wsl.exe stdio relay rather than the shell.
async function gateRelay(ud) {
  const r = await must(ud, { cmd: 'pingCore', n: 200 }, 'pingCore')
  return { line: `relay: ${r.medianMs} ms per core:ping round trip (n=${r.n})`, ok: true, values: r }
}

// Step 4: the W10 session restored, quit, and restored again from the quit
// snapshot, on this gate's own scratch (on the second display). The seeded
// session also holds a file and a web pane in tab 1 (make-session.mjs
// --previews; plan Task 20 step 1.3): both launches must bring them back as
// the placeholder pane (kind file and web in the model, no pty, the shell's
// placeholder view, whose copy is "Previews are not in this build"), and on
// the relaunch pane.closeAll (the menu's Close All Panes) must remove them.
const PLACEHOLDER_COPY = 'Previews are not in this build'

// The placeholder's copy as the release shell carries it (a UTF-16 literal in
// panes.cpp); a screenshot cannot be read back, so the binary is.
function placeholderCopyInShell() {
  return readFileSync(`${RELEASE_LINUX}/SeaShell.exe`).includes(Buffer.from(PLACEHOLDER_COPY, 'utf16le'))
}

// The menu path of the item labelled `label` in the driver's `menu` reply.
function menuPath(items, label) {
  for (const it of items || []) {
    if (it.label === label) return it.path
    const sub = menuPath(it.submenu, label)
    if (sub) return sub
  }
  return null
}

async function gateRestore() {
  const name = 'gates-restore'
  const ud = `${SCRATCH_WIN}\\${name}`
  const udLinux = toLocal(ud)
  rmSync(udLinux, { recursive: true, force: true })
  mkdirSync(udLinux, { recursive: true })
  execFileSync('/usr/bin/node', [MAKE_SESSION, udLinux, HOME, '--previews'], { encoding: 'utf8' })
  writeBounds(udLinux, { x: 1028, y: -979 })
  const seeded = JSON.parse(readFileSync(`${udLinux}/last-session.json`, 'utf8'))
  const seededPreviews = Object.values(seeded.tabs[0].panes).filter((p) => p.kind !== 'term')
  const wantPreview = { file: seededPreviews.find((p) => p.kind === 'file'), web: seededPreviews.find((p) => p.kind === 'web') }
  if (!wantPreview.file || !wantPreview.web) throw new Error('make-session --previews seeded no file and web pane in tab 1')
  if (!placeholderCopyInShell()) throw new Error(`${RELEASE_WIN}\\SeaShell.exe does not carry "${PLACEHOLDER_COPY}"`)
  const savedAt = () => JSON.parse(readFileSync(`${udLinux}/last-session.json`, 'utf8')).savedAt
  const seededAt = savedAt()
  const prompts = []
  // A preview pane in the model: kind file or web, live, its saved path or
  // URL as the tooltip, no pty (no pid file, while the terminals have one),
  // and the shell's placeholder view (pane:<id>:view) in place of a grid.
  const checkPreview = async (which, pid, p) => {
    const want = wantPreview[p.kind]
    const where = p.kind === 'file' ? want.filePath : want.url
    if (p.tooltip !== where) throw new Error(`${which}: the ${p.kind} pane's tooltip is ${JSON.stringify(p.tooltip)}, not ${where}`)
    if (p.status !== 'live') throw new Error(`${which}: the ${p.kind} pane is ${p.status}`)
    if (existsSync(`${PIDS}/${pid}/pane-${p.id}.pid`)) throw new Error(`${which}: the ${p.kind} pane ${p.id} has a pty pid file`)
    let view = null
    const end = now() + 10000
    while (!view && now() < end) {
      const r = await drive(ud, { cmd: 'rect', target: `pane:${p.id}:view` })
      if (r.ok && r.w > 0 && r.h > 0) view = r
      else await sleep(200)
    }
    if (!view) throw new Error(`${which}: the ${p.kind} pane ${p.id} has no placeholder view (pane:${p.id}:view)`)
    if ((await drive(ud, { cmd: 'rect', target: `pane:${p.id}:grid` })).ok) throw new Error(`${which}: the ${p.kind} pane ${p.id} has a grid`)
  }
  const restoreOnce = async (which, closeAll) => {
    const pid = launchShell(name)
    let err = null
    let out = null
    try {
      if (!(await waitFile(`${udLinux}/test.json`, 30000))) throw new Error(`${which}: no test.json in 30 s`)
      const card = await must(ud, { cmd: 'wait', path: '/restore/tabs', timeoutMs: 90000 }, `${which}: the restore card`)
      const m0 = await model(ud)
      if (!(m0.restore && m0.restore.tabs === 9 && m0.restore.panes === 12)) {
        throw new Error(`${which}: the restore card reads ${JSON.stringify(m0.restore)}, not 9 tabs, 12 panes (10 terminals, a file and a web pane)`)
      }
      await must(ud, { cmd: 'click', target: 'restore:yes' }, 'restore:yes')
      await must(ud, { cmd: 'wait', path: '/tabs/8/id', timeoutMs: 60000 }, `${which}: nine tabs`)
      const tabs = (await model(ud)).tabs
      if (tabs.length !== 9) throw new Error(`${which}: ${tabs.length} tabs, not 9`)
      let count = 0
      const previews = []
      for (let i = 0; i < tabs.length; i++) {
        await must(ud, { cmd: 'click', target: `tab:${tabs[i].id}` }, 'tab click')
        await must(ud, { cmd: 'wait', path: `/tabs/${i}/active`, equals: true, timeoutMs: 10000 }, `${which}: tab ${i + 1} active`)
        const want = i === 0 ? 4 : 1
        let panes = []
        const end = now() + 30000
        do {
          panes = (await model(ud)).panes
          if (panes.length < want) await sleep(200)
        } while (panes.length < want && now() < end)
        if (panes.length !== want) throw new Error(`${which}: tab ${i + 1} holds ${panes.length} panes, not ${want}`)
        for (const p of panes) {
          if (p.kind !== 'term') {
            if (i !== 0) throw new Error(`${which}: a ${p.kind} pane in tab ${i + 1}`)
            await checkPreview(which, pid, p)
            previews.push(p.kind)
            continue
          }
          await waitText(ud, p.id, '%', 90000)
          if (!existsSync(`${PIDS}/${pid}/pane-${p.id}.pid`)) throw new Error(`${which}: the terminal ${p.id} has no pid file, so the no-pty check proves nothing`)
          count++
        }
      }
      if (previews.sort().join(',') !== 'file,web') throw new Error(`${which}: tab 1 restored previews [${previews.join(',')}], not a file and a web pane`)
      await must(ud, { cmd: 'click', target: `tab:${tabs[0].id}` }, 'tab click')
      await must(ud, { cmd: 'wait', path: '/tabs/0/active', equals: true, timeoutMs: 10000 }, `${which}: tab 1 active`)
      if (count !== 10) throw new Error(`${which}: ${count} prompts, not 10`)
      prompts.push(count)
      let closed = null
      if (closeAll) {
        const path = menuPath((await must(ud, { cmd: 'menu' }, 'menu')).items, 'Close All Panes')
        if (!path) throw new Error(`${which}: no Close All Panes in the menu`)
        await must(ud, { cmd: 'menuPick', path }, 'menuPick Close All Panes')
        let m = null
        const end = now() + 10000
        do {
          m = await model(ud)
          if (m.panes.some((p) => p.kind !== 'term')) await sleep(200)
        } while (m.panes.some((p) => p.kind !== 'term') && now() < end)
        const kinds = m.panes.map((p) => p.kind)
        if (kinds.length !== 2 || kinds.some((k) => k !== 'term')) throw new Error(`${which}: after pane.closeAll tab 1 holds [${kinds.join(',')}], not two terminals`)
        closed = path
      }
      out = { card: card.value, tabs: m0.restore.tabs, panes: m0.restore.panes, prompts: count, previews, closeAllPath: closed }
    } catch (e) {
      err = e
    }
    const how = await quitShell(ud, pid, name)
    if (how === 'quit' && !pidAlive(pid)) rmSync(`${PIDS}/${pid}`, { recursive: true, force: true })
    if (err) throw new Error(`${err.message} (shell ${how})`)
    if (how !== 'quit') throw new Error(`${which}: ${how}`)
    return out
  }
  const first = await restoreOnce('first launch', false)
  // The quit drain must have written its own snapshot; otherwise the relaunch
  // would restore the seeded file and prove nothing.
  const quitAt = savedAt()
  if (!(quitAt > seededAt)) throw new Error(`last-session.json was not rewritten by the quit (savedAt ${quitAt}, seeded ${seededAt})`)
  const second = await restoreOnce('relaunch', true)
  return {
    line: `restore: ok (card 9 tabs, 12 panes on both launches; ${first.prompts} and ${second.prompts} prompts; the file and web panes came back both times as placeholders (kind file and web, live, no pty, the shell's placeholder view, "${PLACEHOLDER_COPY}" in SeaShell.exe); pane.closeAll (menu ${JSON.stringify(second.closeAllPath)}) removed both and kept the 2 terminals; the quit snapshot was rewritten at ${quitAt}; quit through the driver both times)`,
    ok: true,
    values: { first, second, seededAt, quitAt },
  }
}

// A pty id as the pid file names it (src/shared/wsl-shell.ts paneFileKey):
// anything outside [A-Za-z0-9_-] becomes `_`, so the drawer `drawer:pane-3`
// writes pane-drawer_pane-3.pid.
const paneFileKey = (paneId) => paneId.replace(/[^A-Za-z0-9_-]/g, '_')
const pidFileOf = (paneId, pid) => `${PIDS}/${pid}/pane-${paneFileKey(paneId)}.pid`

// The tty of a pane, from the pid file the shim writes (spec 9). Throws when
// the file is missing, unreadable or holds no `<pid> pts/<n>` line.
function paneTty(paneId, pid = shellPid) {
  const m = /^(\d+) (pts\/\d+)$/.exec(readFileSync(pidFileOf(paneId, pid), 'utf8').trim())
  if (!m) throw new Error(`no pid file line for ${paneId}`)
  return m[2]
}

// pid -> tty (`pts/3`) for the given pids that are alive and have one.
function ttysOf(pids) {
  const out = new Map()
  if (!pids.length) return out
  let text = ''
  try {
    text = execFileSync('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')], { encoding: 'utf8' })
  } catch (e) {
    text = e.stdout || ''   // ps exits 1 when some pid is gone
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(pts\/\d+)\s*$/.exec(line)
    if (m) out.set(Number(m[1]), m[2])
  }
  return out
}

// The tty from the pane's pid file, only while the pid it names is alive on
// that tty (a stale file from an exited shell resolves nothing).
function ttyFromPidFile(paneId, pid) {
  let text
  try {
    text = readFileSync(pidFileOf(paneId, pid), 'utf8').trim()
  } catch {
    return null
  }
  const m = /^(\d+) (pts\/\d+)$/.exec(text)
  if (!m) return null
  return ttysOf([Number(m[1])]).get(Number(m[1])) === m[2] ? m[2] : null
}

// The tty of the scratch's processes whose start environment carries this
// pty's SEASHELL_PANE_ID and the scratch's SEASHELL_APP_ID (win32-<shell
// pid>): every process in that pane shell's tree, so all on one tty. Null
// when none is found or they disagree.
function ttyFromEnviron(paneId, pid) {
  const wantPane = `SEASHELL_PANE_ID=${paneId}`
  const wantApp = `SEASHELL_APP_ID=win32-${pid}`
  const hits = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let env
    try {
      env = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0')
    } catch {
      continue
    }
    if (env.includes(wantPane) && env.includes(wantApp)) hits.push(Number(name))
  }
  const ttys = new Set(ttysOf(hits).values())
  return ttys.size === 1 ? [...ttys][0] : null
}

// The tty check, fail closed (Phase 3 Task 7). Resolves the tty of pty
// `paneId` of the shell `pid`: its pid file (the drawer's under its file key),
// and for a drawer, if that resolves nothing, the environ scan above. Waits up
// to waitMs for a shell that is still starting. Throws "refusing to type"
// when no tty resolves, or when a claude process is on it; else returns the
// tty and how it was found.
async function ttyGuard(paneId, pid, { waitMs = 10000 } = {}) {
  if (!pid) throw new Error(`refusing to type into ${paneId}: no shell pid to find its pid file by`)
  const end = now() + waitMs
  let tty = null
  let via = ''
  for (;;) {
    tty = ttyFromPidFile(paneId, pid)
    if (tty) via = `pid file pane-${paneFileKey(paneId)}.pid`
    else if (paneId.startsWith('drawer:')) {
      tty = ttyFromEnviron(paneId, pid)
      if (tty) via = `the environ of the scratch's processes (SEASHELL_PANE_ID=${paneId})`
    }
    if (tty || now() >= end) break
    await sleep(250)
  }
  if (!tty) throw new Error(`refusing to type into ${paneId}: no tty resolved (pid file ${pidFileOf(paneId, pid)} missing, unreadable or stale${paneId.startsWith('drawer:') ? ', and no process carries its SEASHELL_PANE_ID' : ''})`)
  const c = claudeOn(tty)
  if (c) throw new Error(`refusing to type into ${paneId}: claude (pid ${c}) is running on ${tty}`)
  return { tty, via }
}

// Before any key or text: the tty check of every grid that could take the
// keys, whatever the input is aimed at (a field that loses the keys hands them
// to a grid): the shell's own focused grid (stats.focusedGrid), the model's
// focused terminal pane and the drawer while it has the keys. With no grid at
// all (the empty state) there is nothing to type into.
async function guardKeys(ud, pid) {
  const m = await model(ud)
  const s = await drive(ud, { cmd: 'stats' })
  const ids = new Set()
  if (typeof s.focusedGrid === 'string' && s.focusedGrid) ids.add(s.focusedGrid)
  const f = m.panes.find((p) => p.focused)
  if (f && f.kind === 'term') ids.add(f.id)
  if (m.drawer && m.drawer.open && m.drawer.focused && m.drawer.ptyId) ids.add(m.drawer.ptyId)
  if (!ids.size && m.panes.some((p) => p.kind === 'term')) ids.add((m.panes.find((p) => p.kind === 'term')).id)
  const out = []
  for (const id of ids) out.push({ id, ...(await ttyGuard(id, pid)) })
  return out
}

// The pid of a claude process on that tty, or 0.
function claudeOn(tty) {
  const out = execFileSync('ps', ['-eo', 'pid=,tty=,comm='], { encoding: 'utf8' })
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)/.exec(line)
    if (m && m[2] === tty && m[3] === 'claude') return Number(m[1])
  }
  return 0
}

async function waitNoClaude(tty, timeoutMs) {
  const end = now() + timeoutMs
  while (now() < end) {
    if (!claudeOn(tty)) return true
    await sleep(500)
  }
  return !claudeOn(tty)
}

// A fresh zsh pane in the active tab (Ctrl+Shift+D), focused; its id.
async function newPane(ud) {
  const before = (await model(ud)).panes.length
  await must(ud, { cmd: 'key', chord: 'Ctrl+Shift+D' }, 'key Ctrl+Shift+D')
  await must(ud, { cmd: 'wait', path: `/panes/${before}/status`, equals: 'live', timeoutMs: 60000 }, 'new pane live')
  const m = await model(ud)
  const p = m.panes.find((x) => x.focused) || m.panes[before]
  await waitText(ud, p.id, '%', 60000)
  return p.id
}

// Leaves claude without ever typing a line that could be submitted as a
// prompt: Ctrl+C presses until no claude process is on the pane's tty. A
// claude that stays is left to the scratch quit, and nothing more is typed
// into that pane (the typed text would land in its input box and the next
// Enter would submit it). Only once claude is gone is the zsh prompt
// confirmed with a typed marker.
async function leaveClaude(ud, paneId, tty) {
  for (let round = 0; round < 4 && claudeOn(tty); round++) {
    for (let i = 0; i < 3; i++) {
      await must(ud, { cmd: 'key', chord: 'Ctrl+C' }, 'key Ctrl+C')
      await sleep(300)
    }
    await waitNoClaude(tty, 5000)
  }
  if (claudeOn(tty)) return false
  await run(ud, `echo ${marker('CTL-BACK')}`)
  const r = await drive(ud, { cmd: 'waitText', paneId, contains: 'CTL-BACK', timeoutMs: 10000 })
  return !!r.ok
}

// Step 5: the control endpoint (spec 9) typing into a claude pane through
// send-to-pane.py with SEASHELL_CONTROL_JSON pointed at the scratch file.
// claude runs in plan mode in its own fresh pane, so a line that reached it
// as a prompt could read but never change anything.
async function gateControl(ud) {
  const paneId = await newPane(ud)
  const tty = paneTty(paneId)
  const udLinux = toLocal(ud)
  // The plan allows "not verified" only when claude is not on the pane's
  // PATH, so the pane itself is asked.
  await run(ud, `echo CLD=$(command -v claude || echo none); echo ${marker('CLD-END')}`)
  await waitText(ud, paneId, 'CLD-END', 20000)
  const claudePath = field(await gridRows(ud, paneId), 'CLD') || 'none'
  if (claudePath === 'none') return { line: 'control: not verified (no claude on the pane PATH)', ok: true, verified: false }
  const before = new Set(existsSync(REGISTRY) ? readdirSync(REGISTRY) : [])
  await run(ud, 'claude --permission-mode plan')
  try {
    // The input frame: the plan's box corner, or the chevron prompt line
    // Josh's configuration draws between horizontal rules.
    await waitAny(ud, paneId, ['\u256d', '\u276f', '\u2500\u2500\u2500\u2500\u2500\u2500'], 90000)
  } catch (e) {
    const back = await leaveClaude(ud, paneId, tty)
    throw new Error(`claude (${claudePath}) showed no prompt frame: ${e.message}; ${back ? 'left' : 'claude still running at quit'}`)
  }
  let rec = null
  const end = now() + 30000
  while (!rec && now() < end) {
    for (const f of existsSync(REGISTRY) ? readdirSync(REGISTRY) : []) {
      if (before.has(f) || !f.endsWith('.json')) continue
      try {
        const r = JSON.parse(readFileSync(join(REGISTRY, f), 'utf8'))
        // The hook stamps pane_id from SEASHELL_PANE_ID; app_id (spec 9) is
        // reported when present, since the hook that runs may predate it.
        if (r.pane_id === paneId) rec = r
      } catch {}
    }
    if (!rec) await sleep(500)
  }
  if (!rec) {
    const back = await leaveClaude(ud, paneId, tty)
    throw new Error(`no session registry entry with pane_id ${paneId} appeared in 30 s (${back ? 'left claude' : 'claude still running'})`)
  }
  await sleep(2000)   // claude is the foreground process by now
  let out = ''
  let code = 0
  try {
    out = execFileSync('python3', [SEND_TO_PANE, rec.session_id, 'hello from the endpoint'],
      { encoding: 'utf8', env: { ...process.env, SEASHELL_CONTROL_JSON: `${udLinux}/control.json` }, timeout: 30000 })
  } catch (e) {
    code = e.status ?? 1
    out = `${e.stdout || ''}${e.stderr || ''}`
  }
  out = out.trim().split('\n')[0] || ''
  let seen = false
  try {
    await waitText(ud, paneId, 'hello from the endpoint', 15000)
    seen = true
  } catch {}
  const back = await leaveClaude(ud, paneId, tty)
  const appId = 'app_id' in rec ? rec.app_id : 'absent (the hook that ran writes none)'
  const detail = `send-to-pane exit ${code}: "${out}"; text ${seen ? 'visible' : 'NOT visible'} in the grid; registry app ${rec.app} pane_id ${rec.pane_id} tty ${rec.tty} app_id ${appId}; ${back ? 'back at the zsh prompt' : 'claude stayed up on Ctrl+C and was ended by the scratch quit'}`
  if (code !== 0 || !seen) throw new Error(detail)
  return { line: `control: ok (${detail})`, ok: true, verified: true, values: { out, registry: rec } }
}

// Step 6: the shell launched from inside one of its own panes (Review Focus 3),
// in a fresh pane of its own. WSL interop passes a Linux variable to a Windows
// exe only through WSLENV, so the command names the four the nested shell
// needs; SEASHELL_TEST_PORT keeps the nested window from taking focus. The
// job's stdin is /dev/null: the interop relay reads it, and a background job
// reading the tty is stopped.
async function gateNesting(ud) {
  const paneId = await newPane(ud)
  const name = 'nest'
  const nestUd = `${SCRATCH_WIN}\\${name}`
  const nestLinux = toLocal(nestUd)
  rmSync(nestLinux, { recursive: true, force: true })
  mkdirSync(nestLinux, { recursive: true })
  seedUiState(nestLinux)
  const launchLog = `/tmp/seashell-nest-launch-${process.pid}.log`
  rmSync(launchLog, { force: true })
  const others = new Set(releaseShellPids())   // release shells already up (the main scratch)
  await run(ud, `WSLENV=SEASHELL_INSTANCE:SEASHELL_USER_DATA:SEASHELL_TEST_PORT:SEASHELL_SHELL_LOG SEASHELL_INSTANCE=${name} ` +
    `SEASHELL_USER_DATA='${nestUd}' SEASHELL_TEST_PORT=0 SEASHELL_SHELL_LOG='${nestUd}\\shell.log' ${RELEASE_LINUX}/SeaShell.exe < /dev/null > ${launchLog} 2>&1 &`)
  let nestPid = 0
  try {
    if (!(await waitFile(`${nestLinux}/test.json`, 30000))) {
      const log = existsSync(launchLog) ? readFileSync(launchLog, 'utf8').trim().split('\n').slice(0, 3).join(' | ') : 'no launch log'
      const rows = (await gridRows(ud, paneId)).filter((t) => t.trim()).slice(-4).join(' | ')
      throw new Error(`the nested shell wrote no test.json in 30 s (launch: ${log}; pane: ${rows})`)
    }
    await must(nestUd, { cmd: 'wait', path: '/panes/0/status', equals: 'live', timeoutMs: 60000 }, 'nested first pane live')
    if (!(await waitFile(`${nestLinux}/control.json`, 10000))) throw new Error('the nested core wrote no control.json')
    nestPid = Number(JSON.parse(readFileSync(`${nestLinux}/control.json`, 'utf8')).pid)
    const nestPane = await focusedPane(nestUd)
    await run(nestUd, `echo U=$SEASHELL_USER_ZDOTDIR; echo Z=$ZDOTDIR; echo A=$SEASHELL_APP_ID; echo ${marker('NEST-END')}`)
    await waitText(nestUd, nestPane, 'NEST-END', 20000)
    const rows = await gridRows(nestUd, nestPane)
    const u = field(rows, 'U')
    const z = field(rows, 'Z')
    const a = field(rows, 'A')
    const bad = []
    if (u !== HOME) bad.push(`U=${u}`)
    if (typeof u === 'string' && u.includes('.cache/seashell-win/zdotdir')) bad.push('SEASHELL_USER_ZDOTDIR is the shim path')
    if (z !== SHIM_ZDOTDIR) bad.push(`Z=${z}`)
    if (a !== `win32-${nestPid}`) bad.push(`A=${a} (nested shell pid ${nestPid})`)
    const detail = `nested pane U=${u}, Z shim, APP ${a}, nested shell pid ${nestPid}`
    if (bad.length) throw new Error(`${bad.join('; ')} (${detail})`)
    return { line: `nesting: ok (${detail})`, ok: true, values: { u, z, a, nestPid } }
  } finally {
    if (nestPid) {
      const how = await quitShell(nestUd, nestPid, name)
      if (how !== 'quit') console.error(`nesting: the nested shell was ${how}`)
    } else {
      // No control.json, so no pid from the nested shell itself: any release
      // shell that was not up before the launch is the nested one.
      try { await drive(nestUd, { cmd: 'quit' }) } catch {}
      await sleep(3000)
      for (const pid of releaseShellPids()) {
        if (others.has(pid) || pid === shellPid) continue
        const how = await quitShell(nestUd, pid, name)
        console.error(`nesting: a nested shell (pid ${pid}) without control.json was ${how}`)
      }
    }
  }
}

// ------------------------------------------------------- Phase 2 (Task 20)

// Runs `node scripts/<script>` from the worktree, its stderr (progress) passed
// through and its stdout returned as lines. A run past `timeoutMs` is ended and
// its scratch is asked to quit through its own driver.
function runScript(script, scratch, timeoutMs) {
  const t0 = now()
  const r = spawnSync(process.execPath, [join('scripts', script)], {
    cwd: WORKTREE, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const lines = (r.stdout || '').split('\n').map((l) => l.trimEnd()).filter(Boolean)
  return { code: r.status, signal: r.signal, timedOut: r.error?.code === 'ETIMEDOUT', lines, t0, scratch }
}

async function afterTimeout(r) {
  if (!r.timedOut) return ''
  try {
    await drive(`${SCRATCH_WIN}\\${r.scratch}`, { cmd: 'quit' })
    return `; timed out, scratch ${r.scratch} asked to quit`
  } catch (e) {
    return `; timed out, scratch ${r.scratch} quit failed (${e.message})`
  }
}

// Task 20 step 1.4: the path matrix (Task 7b), four rows ok.
async function gateMatrix() {
  const r = runScript('native-matrix.mjs', 'g7b', 15 * 60000)
  const rowLines = r.lines.filter((l) => /^matrix: \d+ /.test(l))
  const okRows = rowLines.filter((l) => /^matrix: \d+ ok\b/.test(l)).length
  const scratchLine = r.lines.find((l) => l.startsWith('scratch g7b:')) || 'scratch g7b: no quit line'
  const values = { exit: r.code, signal: r.signal, lines: r.lines }
  if (r.code === 0 && okRows === 4 && rowLines.length === 4) return { line: `matrix: ok (${okRows} rows ok)`, ok: true, values }
  const first = r.lines.find((l) => /^matrix: (\d+ )?fail\b/.test(l)) ||
    (scratchLine !== 'scratch g7b: quit' ? scratchLine : `exit ${r.code ?? r.signal}, ${okRows} of 4 rows ok`)
  return { line: `matrix: fail ${first.replace(/^matrix: /, '')}${await afterTimeout(r)}`, ok: false, values }
}

// Task 20 step 1.5: the inventory walk (Task 18), no fail, the status doc written.
async function gateInventory() {
  const r = runScript('native-inventory.mjs', 'j18', 60 * 60000)
  // totals: A ok live, B ok via another row, C ok unit-only, D not driven,
  // E replaced by the native design, F skipped, G deferred, H fail (N rows)
  const t = r.lines.map((l) => /^totals: (\d+) ok live, (\d+) ok via another row, (\d+) ok unit-only, (\d+) not driven, (\d+) replaced by the native design, (\d+) skipped, (\d+) deferred, (\d+) fail \((\d+) rows\)$/.exec(l)).find(Boolean)
  const failRows = r.lines.filter((l) => /^[A-Z]\d+ fail\b/.test(l))
  const scratchLine = r.lines.find((l) => l.startsWith('scratch j18:')) || 'scratch j18: no quit line'
  const docWritten = existsSync(STATUS_DOC) && statSync(STATUS_DOC).mtimeMs >= r.t0
  const values = { exit: r.code, signal: r.signal, totals: t ? t.slice(1).map(Number) : null, failRows, statusDoc: STATUS_DOC, docWritten }
  if (r.code === 0 && t && t[8] === '0' && docWritten) {
    return {
      line: `inventory: ok (${t[1]} ok live, ${t[2]} ok via another row, ${t[3]} ok unit-only, ${t[4]} not driven, ${t[5]} replaced by the native design, ${t[6]} skipped, ${t[7]} deferred, 0 fail; status doc written)`,
      ok: true,
      values,
    }
  }
  const why = failRows.length
    ? failRows.map((l) => (l.length > 200 ? l.slice(0, 197) + '...' : l)).join(' | ')
    : !t ? `no totals line (exit ${r.code ?? r.signal})`
      : !docWritten ? `the status doc ${STATUS_DOC} was not written`
        : scratchLine
  return { line: `inventory: fail ${why}${await afterTimeout(r)}`, ok: false, values }
}

// Task 20 step 1.6: W10 (a) as Phase 1 measured it, or (b) with the sidebar
// open at home two levels deep and the drawer open on one pane, through
// run-native-w10.ps1 (five samples after the 60 s idle). measure-ram.ps1
// refuses while Edge runs; this checks first and then launches nothing, and
// it never closes Edge.
async function gateW10(variant) {
  const g = `w10${variant}`
  const edge = Number(powershell('@(Get-Process -Name msedge -ErrorAction SilentlyContinue).Count'))
  if (edge > 0) return { line: `${g}: not measured, Edge was open`, ok: true, measured: false }
  const others = releaseShellPids()
  if (others.length) return { line: `${g}: fail a release shell is already running (pid ${others.join(',')}); W10 measures alone`, ok: false }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Set-Location C:\\; & '${BUILD_WIN}\\scripts\\win\\run-native-w10.ps1' -Variant ${variant}`],
  { cwd: '/mnt/c', encoding: 'utf8', timeout: 20 * 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = (r.stdout || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
  for (const l of lines) console.error(`${g}: ${l}`)
  const errTail = (r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 2).join(' | ')
  if (lines.includes('measure: not measured, Edge was open')) return { line: `${g}: not measured, Edge was open`, ok: true, measured: false, values: { lines } }
  let row = null
  for (const l of lines) {
    if (!l.startsWith('{')) continue
    try {
      const j = JSON.parse(l)
      if (j.label === `P2-w10-${variant}`) row = j
    } catch {}
  }
  const quitLine = lines.find((l) => l.startsWith('quit:')) || 'quit: no line'
  if (!row) {
    const why = lines.find((l) => l.startsWith('measure: failed')) || errTail || `exit ${r.status ?? r.signal}`
    return { line: `${g}: fail ${why} (${quitLine})`, ok: false, values: { lines, stderr: r.stderr } }
  }
  const line = `${g}: ${row.wsMB} MB working set, ${row.processes} processes, ${row.privateMB} MB private, core RSS ${row.coreRssMB} MB (bar ${W10_BAR_MB}; Phase 1 ${W10_PHASE1_MB})`
  const bad = []
  if (!(row.wsMB < W10_BAR_MB)) bad.push(`over the ${W10_BAR_MB} MB bar`)
  if (!quitLine.startsWith('quit: the tree is gone')) bad.push(quitLine)
  if (r.status !== 0) bad.push(`run-native-w10.ps1 exit ${r.status ?? r.signal}`)
  return { line: bad.length ? `${line}; ${bad.join('; ')}` : line, ok: bad.length === 0, measured: true, values: { row, lines } }
}

// ---------------------------------------------------------------------- main

export { BUILD_WIN, RELEASE_WIN, SCRATCH_WIN, PIDS, toLocal, sleep, drive, model, must, focusedPane, run, gridRows, waitText, launchShell, waitFile, quitShell, writeBounds, seedUiState, paneTty, paneFileKey, ttyFromEnviron, ttyGuard, guardKeys, claudeOn, pidAlive }

if (isMain) {
  const runners = {
    env: gateEnv, throughput: gateThroughput, latency: gateLatency, relay: gateRelay, restore: gateRestore, control: gateControl, nesting: gateNesting,
    matrix: gateMatrix, inventory: gateInventory, w10a: () => gateW10('a'), w10b: () => gateW10('b'),
  }
  const results = {}
  let failed = 0
  for (const g of gates) {
    const fn = runners[g]
    if (!fn) {
      console.log(`${g}: unknown gate`)
      failed++
      continue
    }
    const t0 = now()
    try {
      const r = await fn(udWin)
      results[g] = { ...r, seconds: r1((now() - t0) / 1000) }
      if (!r.ok) failed++
      console.log(r.line)
    } catch (e) {
      results[g] = { line: `${g}: fail ${e.message}`, ok: false, seconds: r1((now() - t0) / 1000) }
      failed++
      console.log(results[g].line)
    }
  }
  if (outPath) {
    const local = toLocal(outPath)
    mkdirSync(dirname(local), { recursive: true })
    writeFileSync(local, JSON.stringify({ at: new Date().toISOString(), userData: udWin, shellPid, results }, null, 2) + '\n')
  }
  process.exit(failed ? 1 : 0)
}
