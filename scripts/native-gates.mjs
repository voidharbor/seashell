#!/usr/bin/env node
// The Phase 1 gates (plan Task 18 steps 1 to 6), plus the Phase 2 relay line
// (Task 1), against a running scratch native shell, driven through its
// loopback test driver. Prints one line per gate and writes the numbers as
// JSON. Runs under WSL's node so it can read the core's /proc entry and the
// pid files directly.
//
// Usage (from WSL, or from scripts/win/run-native-gates.ps1 through wsl.exe):
//   node scripts/native-gates.mjs <userDataWin> --shell-pid <pid>
//        [--gates env,throughput,latency,relay,nesting,control,restore] [--out <C:\...json>]
//
// env, throughput, latency, relay, control and nesting run against the shell whose
// userData is given. restore seeds and launches its own scratch (two launches)
// and nesting launches a second shell from inside a pane; both are quit through
// their own driver and only ever stopped by pid, never by image name.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const gates = opt('--gates', 'env,throughput,latency,relay,nesting,control,restore').split(',').map((s) => s.trim()).filter(Boolean)
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

// Types a command line and presses Enter through the shell's own key path.
// In the main scratch (or any shell whose pid is given) it refuses while a
// claude process is on the focused pane's tty, since the line would land in
// claude's input box and the Enter would submit it as a prompt.
async function run(ud, cmdline, pid) {
  const checkPid = pid || (ud === udWin ? shellPid : 0)
  if (checkPid) {
    const paneId = await focusedPane(ud)
    let tty = ''
    try { tty = paneTty(paneId, checkPid) } catch {}
    if (tty && claudeOn(tty)) throw new Error(`refusing to type into ${paneId}: claude is running on ${tty}`)
  }
  await must(ud, { cmd: 'text', s: cmdline }, 'text')
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

// The DPI the shell scales its saved window size by (run-native-w10.ps1 does
// the same): 1440x900 DIP at 100,100 (or x, y), not maximized.
function writeBounds(udLinux, { x = 100, y = 100 } = {}) {
  let dpi = Number(powershell("(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI"))
  if (!dpi) dpi = 96
  const w = Math.round((1440 * dpi) / 96)
  const h = Math.round((900 * dpi) / 96)
  writeFileSync(`${udLinux}/window-bounds.json`, `{"x":${x},"y":${y},"width":${w},"height":${h},"maximized":false}`)
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
  const samples = []
  const t0 = now()
  await run(ud, `head -c 50000000 /dev/urandom | base64 | head -c 50000000; echo; echo ${marker('FLOOD-DONE')}`)
  let done = false
  while (!done) {
    const r = await drive(ud, { cmd: 'waitText', paneId, contains: 'FLOOD-DONE', timeoutMs: 1000 })
    done = !!r.ok
    const s = await stats(ud)
    const rss = coreRssMB(corePid)
    samples.push({ t: r1((now() - t0) / 1000), p95: s.frameMs.p95, frames5s: s.framesLast5s, shellWsMB: s.shellWsMB, coreRssMB: rss, ptyBytesLast5s: s.ptyBytesLast5s })
    // p95 is 0 when no frame landed in the window, which is not a fast frame.
    if (s.framesLast5s > 0) peak.p95 = Math.max(peak.p95, s.frameMs.p95)
    if (!done) floodFrames += s.framesLast5s
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
  const numbers = `p95=${peak.p95}ms shellWs start=${start.shellWsMB} peak=${peak.shellWsMB} after30s=${after.shellWsMB} ` +
    `coreRss start=${start.coreRssMB} peak=${peak.coreRssMB} after30s=${after.coreRssMB} after120s=${settle[settle.length - 1].coreRssMB} ` +
    `(${settled ? `within 30 MB of the start at ${settled.t} s` : 'not within 30 MB of the start by 120 s'}) flood=${floodS}s peakPty5s=${r1(peak.ptyBytesLast5s / 1048576)}MB floodFrames=${floodFrames}`
  const values = { start, peak, after, settle, floodS, samples }
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
  return { line: ok ? line : `${line}; the bar is under 2`, ok, values: { perMove, median, average, ...r, orientation: d.orientation } }
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
// snapshot, on this gate's own scratch.
async function gateRestore() {
  const name = 'gates-restore'
  const ud = `${SCRATCH_WIN}\\${name}`
  const udLinux = toLocal(ud)
  rmSync(udLinux, { recursive: true, force: true })
  mkdirSync(udLinux, { recursive: true })
  execFileSync('/usr/bin/node', [MAKE_SESSION, udLinux, HOME], { encoding: 'utf8' })
  writeBounds(udLinux)
  const savedAt = () => JSON.parse(readFileSync(`${udLinux}/last-session.json`, 'utf8')).savedAt
  const seededAt = savedAt()
  const prompts = []
  const restoreOnce = async (which) => {
    const pid = launchShell(name)
    let err = null
    let out = null
    try {
      if (!(await waitFile(`${udLinux}/test.json`, 30000))) throw new Error(`${which}: no test.json in 30 s`)
      const card = await must(ud, { cmd: 'wait', path: '/restore/tabs', timeoutMs: 90000 }, `${which}: the restore card`)
      const m0 = await model(ud)
      if (!(m0.restore && m0.restore.tabs === 9 && m0.restore.panes === 10)) {
        throw new Error(`${which}: the restore card reads ${JSON.stringify(m0.restore)}, not 9 tabs, 10 panes`)
      }
      await must(ud, { cmd: 'click', target: 'restore:yes' }, 'restore:yes')
      await must(ud, { cmd: 'wait', path: '/tabs/8/id', timeoutMs: 60000 }, `${which}: nine tabs`)
      const tabs = (await model(ud)).tabs
      if (tabs.length !== 9) throw new Error(`${which}: ${tabs.length} tabs, not 9`)
      let count = 0
      for (let i = 0; i < tabs.length; i++) {
        await must(ud, { cmd: 'click', target: `tab:${tabs[i].id}` }, 'tab click')
        await must(ud, { cmd: 'wait', path: `/tabs/${i}/active`, equals: true, timeoutMs: 10000 }, `${which}: tab ${i + 1} active`)
        const want = i === 0 ? 2 : 1
        let panes = []
        const end = now() + 30000
        do {
          panes = (await model(ud)).panes
          if (panes.length < want) await sleep(200)
        } while (panes.length < want && now() < end)
        for (const p of panes) {
          await waitText(ud, p.id, '%', 90000)
          count++
        }
      }
      await must(ud, { cmd: 'click', target: `tab:${tabs[0].id}` }, 'tab click')
      if (count !== 10) throw new Error(`${which}: ${count} prompts, not 10`)
      prompts.push(count)
      out = { card: card.value, tabs: m0.restore.tabs, panes: m0.restore.panes, prompts: count }
    } catch (e) {
      err = e
    }
    const how = await quitShell(ud, pid, name)
    if (err) throw new Error(`${err.message} (shell ${how})`)
    if (how !== 'quit') throw new Error(`${which}: ${how}`)
    return out
  }
  const first = await restoreOnce('first launch')
  // The quit drain must have written its own snapshot; otherwise the relaunch
  // would restore the seeded file and prove nothing.
  const quitAt = savedAt()
  if (!(quitAt > seededAt)) throw new Error(`last-session.json was not rewritten by the quit (savedAt ${quitAt}, seeded ${seededAt})`)
  const second = await restoreOnce('relaunch')
  return {
    line: `restore: ok (card 9 tabs, 10 panes on both launches; ${first.prompts} and ${second.prompts} prompts; the quit snapshot was rewritten at ${quitAt}; quit through the driver both times)`,
    ok: true,
    values: { first, second, seededAt, quitAt },
  }
}

// The tty of a pane, from the pid file the core writes (spec 9).
function paneTty(paneId, pid = shellPid) {
  const m = /^(\d+) (pts\/\d+)$/.exec(readFileSync(`${PIDS}/${pid}/pane-${paneId}.pid`, 'utf8').trim())
  if (!m) throw new Error(`no pid file line for ${paneId}`)
  return m[2]
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

// ---------------------------------------------------------------------- main

export { BUILD_WIN, RELEASE_WIN, SCRATCH_WIN, PIDS, toLocal, sleep, drive, model, must, focusedPane, run, gridRows, waitText, launchShell, waitFile, quitShell, writeBounds, seedUiState, paneTty, claudeOn, pidAlive }

if (isMain) {
  const runners = { env: gateEnv, throughput: gateThroughput, latency: gateLatency, relay: gateRelay, restore: gateRestore, control: gateControl, nesting: gateNesting }
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
