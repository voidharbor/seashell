#!/usr/bin/env node
// The pane hook proof (Phase 3 plan Task 3 step 2): the hook SC Cockpit's
// NEW <TOOL> keys rely on (~/.config/seashell-work/pane-hook.zsh) fires in a
// fresh pane of the native build and refuses what it must. Nothing is ever
// claimed and run: every request is one the hook refuses (a command off its
// list, another SeaShell's app id, or a stale file), and a whitelisted command
// is never written with this run's app id.
//
// Usage (from WSL): node scripts/native-panehook.mjs
//
// Launches scratch k3 (one zsh pane, the driver on, never focused), reads the
// pane's SEASHELL_APP_ID and SEASHELL_PANE_ID by typing an echo after a tty
// check that fails closed (no readable pid file, or a claude process on the
// tty, and nothing is typed), then makes three requests, each written to
// ~/.cache/seashell-work/next-pane and followed by the driver's pane.new:
//   p3a notalisted win32-<k3 pid>  expects "p3a refused, not on the list: notalisted"
//   p3b ccli win32-1               expects "p3b refused, request is for SeaShell 'win32-1' ..."
//   p3c notalisted win32-<k3 pid>  written 10 s before the pane.new, expects "p3c stale ..."
// Each line must reach the hook's log within 5 s of the pane.new, and the pane
// that claimed the request must be the one the pane.new created: the claiming
// zsh's pid is read from its rename of next-pane to next-pane.claimed.<pid>
// (seen through inotify, so nothing is written for it) and matched to the
// pane pid files; the stale and wrong-app lines also name the pane. Removes
// only its own files (next-pane while it still holds this run's request,
// claimed.p3a to p3c, and the next-pane.claimed.<pid> names it saw), never
// writes the hook's log, prints one line per claim, always quits the scratch
// through its driver and exits non-zero on any failure.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import {
  PIDS,
  SCRATCH_WIN,
  claudeOn,
  gridRows,
  launchShell,
  model,
  must,
  pidAlive,
  quitShell,
  sleep,
  toLocal,
  waitFile,
  waitText,
  writeBounds,
} from './native-gates.mjs'

const HOME = process.env.HOME
const WORK = `${HOME}/.cache/seashell-work`
const REQ = `${WORK}/next-pane`
const LOG = `${WORK}/log`
const HOOK = `${HOME}/.config/seashell-work/pane-hook.zsh`
const NAME = 'k3'
const UD = `${SCRATCH_WIN}\\${NAME}`
const UD_LINUX = toLocal(UD)
const CLAIM_MS = 5000
const STALE_S = 10
const WHITELIST = ['ccli', 'gptcli', 'gemcli', 'occli', 'jarvis', 'ultron']

const now = () => Date.now()
// "P3ENV" typed as P3EN''V so the echoed command line never matches the output.
const marker = (tag) => `${tag.slice(0, -1)}''${tag.slice(-1)}`

function logLines() {
  try {
    return readFileSync(LOG, 'utf8').split('\n').filter((l) => l.length > 0)
  } catch {
    return []
  }
}

const IDS = ['p3a', 'p3b', 'p3c']
const workEntries = () => (existsSync(WORK) ? readdirSync(WORK) : [])

// Pane id to pane shell pid, from the pid files the core writes for the
// scratch (spec 9): pane-<paneId>.pid holding "<pid> pts/<n>".
function paneShells(shellPid) {
  const dir = `${PIDS}/${shellPid}`
  const out = new Map()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    const m = /^pane-(.+)\.pid$/.exec(f)
    if (!m) continue
    try {
      const l = /^(\d+) (pts\/\d+)$/.exec(readFileSync(`${dir}/${f}`, 'utf8').trim())
      if (l) out.set(m[1], { pid: Number(l[1]), tty: l[2] })
    } catch {}
  }
  return out
}

// Types a line into `paneId` only when it is the focused pane, its pid file
// names its tty, and no claude process is on that tty. Unlike run() in
// native-gates.mjs this fails closed: no readable pid file, no typing.
async function typeChecked(paneId, shellPid, line) {
  const focused = (await model(UD)).panes.find((p) => p.focused)
  if (!focused || focused.id !== paneId) throw new Error(`refusing to type: the focused pane is ${focused ? focused.id : 'none'}, not ${paneId}`)
  const pf = `${PIDS}/${shellPid}/pane-${paneId}.pid`
  await waitFile(pf, 10000)
  let tty = ''
  try {
    const m = /^(\d+) (pts\/\d+)$/.exec(readFileSync(pf, 'utf8').trim())
    if (m) tty = m[2]
  } catch {}
  if (!tty) throw new Error(`refusing to type into ${paneId}: no readable pid file line in ${pf}`)
  const c = claudeOn(tty)
  if (c) throw new Error(`refusing to type into ${paneId}: claude (pid ${c}) is running on ${tty}`)
  await must(UD, { cmd: 'text', s: line }, 'text')
  await must(UD, { cmd: 'key', chord: 'Enter' }, 'key Enter')
}

// Step 1: the env the hook keys on, read from inside the first pane.
async function readEnv(shellPid) {
  const m = await model(UD)
  if (m.panes.length !== 1) throw new Error(`the scratch opened ${m.panes.length} panes, not 1`)
  const paneId = m.panes[0].id
  await waitText(UD, paneId, '%', 60000)
  const typed = `echo ${marker('P3ENV')} $SEASHELL_APP_ID $SEASHELL_PANE_ID`
  await typeChecked(paneId, shellPid, typed)
  await waitText(UD, paneId, 'P3ENV ', 15000)
  const row = (await gridRows(UD, paneId)).map((r) => r.trimEnd()).filter((r) => r.startsWith('P3ENV ')).pop()
  if (!row) throw new Error('no row starting with "P3ENV " in the first pane')
  const [app = '', pane = ''] = row.slice('P3ENV '.length).split(' ')
  const bad = []
  if (!pane.startsWith('pane-')) bad.push(`SEASHELL_PANE_ID "${pane}" does not match the hook's pane-*`)
  if (!app.startsWith('win32-')) bad.push(`SEASHELL_APP_ID "${app}" does not match the hook's win32-*`)
  if (app !== `win32-${shellPid}`) bad.push(`SEASHELL_APP_ID "${app}" is not win32-${shellPid} (the scratch's pid)`)
  if (pane !== paneId) bad.push(`SEASHELL_PANE_ID "${pane}" is not the model's pane ${paneId}`)
  const detail = `typed ${JSON.stringify(typed)} after the tty check, read ${JSON.stringify(row)}`
  return { ok: bad.length === 0, line: bad.length ? `env: fail ${bad.join('; ')} (${detail})` : `env: ok (${detail}; the hook's pane-* and win32-* conditions hold)`, app, pane }
}

// One request: write next-pane, wait ageS, pane.new, then the log line, the
// new pane and the pane that claimed it.
async function claim(shellPid, claimers, req) {
  const { id, cmd, app, ageS = 0 } = req
  const text = `${id} ${cmd} ${app}`
  if (WHITELIST.includes(cmd) && app === `win32-${shellPid}`) throw new Error(`refusing to write "${text}": a whitelisted command with this run's app id would run`)
  if (existsSync(REQ)) throw new Error(`${REQ} already exists; not overwriting it`)
  const before = new Set([...(await model(UD)).panes.map((p) => p.id), ...paneShells(shellPid).keys()])
  const n0 = logLines().length
  claimers.length = 0
  writeFileSync(REQ, text)
  req.written = text
  if (ageS) await sleep(ageS * 1000)
  const t0 = now()
  await must(UD, { cmd: 'coreSend', ch: 'ui:command', p: { command: 'pane.new' } }, 'pane.new')
  let line = null
  while (!line && now() - t0 < CLAIM_MS) {
    line = logLines().slice(n0).find((l) => l.split(' ')[1] === id) || null
    if (!line) await sleep(100)
  }
  const ms = now() - t0
  let newPane = null
  for (const end = now() + 10000; !newPane && now() < end; ) {
    newPane = (await model(UD)).panes.map((p) => p.id).find((p) => !before.has(p)) || null
    if (!newPane) await sleep(200)
  }
  const stillThere = existsSync(REQ)
  if (stillThere && readFileSync(REQ, 'utf8') === text) rmSync(REQ, { force: true })
  if (!line) {
    throw new Error(`no log line for ${id} within ${CLAIM_MS} ms of pane.new (new pane ${newPane || 'none'}; next-pane ${stillThere ? 'still there, unclaimed, removed' : 'gone'}; hook ${existsSync(HOOK) ? 'present' : 'missing'})`)
  }
  if (!newPane) throw new Error(`pane.new created no pane in 10 s (log "${line}")`)
  // The claiming zsh's pid, from its rename, matched to the pane pid files.
  const zsh = claimers.length ? claimers[0] : null
  let by = null
  for (const end = now() + 10000; zsh && !by && now() < end; ) {
    for (const [pane, s] of paneShells(shellPid)) if (s.pid === zsh) by = pane
    if (!by) await sleep(200)
  }
  const rest = line.slice(line.indexOf(' ') + 1)
  const bad = []
  if (!req.expect(rest, newPane)) bad.push(`log line "${rest}" is not the expected refusal`)
  const named = /(?:by pane|but pane) (\S+)/.exec(rest)
  if (named && named[1] !== newPane) bad.push(`the log names pane ${named[1]}, not the new pane ${newPane}`)
  if (!zsh) bad.push('no next-pane.claimed.<pid> rename was seen')
  else if (!by) bad.push(`the claiming zsh ${zsh} is in no pane pid file of the scratch`)
  else if (by !== newPane) bad.push(`claimed by pane ${by} (zsh ${zsh}), not the new pane ${newPane}`)
  if (claimers.length > 1) bad.push(`claimed ${claimers.length} times (zsh ${claimers.join(', ')})`)
  if (before.has(newPane)) bad.push(`pane ${newPane} existed before the pane.new`)
  if (stillThere) bad.push('next-pane was still there after the claim')
  // The new pane's zsh is past the hook before the next request is written.
  await waitText(UD, newPane, '%', 30000)
  const detail = `claimed by new pane ${newPane} (zsh ${zsh}), log line ${ms} ms after pane.new: "${line}"`
  if (bad.length) throw new Error(`${bad.join('; ')} (${detail})`)
  return `${id}: ok (${detail})`
}

async function main() {
  if (existsSync(REQ)) {
    console.log(`panehook: fail ${REQ} already exists before the run; nothing launched`)
    process.exit(1)
  }
  if (!existsSync(WORK)) {
    console.log(`panehook: fail ${WORK} does not exist; nothing launched`)
    process.exit(1)
  }
  // The claim watcher exists before the scratch does, so it cannot fail with k3 up.
  const claimers = []
  const seen = new Set()
  let watcher
  try {
    watcher = watch(WORK, (_ev, name) => {
      const m = /^next-pane\.claimed\.(\d+)$/.exec(String(name || ''))
      if (!m) return
      seen.add(m[1])
      if (!claimers.includes(Number(m[1]))) claimers.push(Number(m[1]))
    })
  } catch (e) {
    console.log(`panehook: fail cannot watch ${WORK} (${e.message}); nothing launched`)
    process.exit(1)
  }
  const log0 = logLines().length
  let pid = 0
  let reqs = []
  let failed = 0
  let corePid = 0
  try {
    rmSync(UD_LINUX, { recursive: true, force: true })
    mkdirSync(UD_LINUX, { recursive: true })
    writeBounds(UD_LINUX, { x: 1028, y: -979 })   // the second display, as the matrix
    pid = launchShell(NAME)
    console.log(`launched scratch ${NAME} (pid ${pid})`)
    reqs = [
      { id: 'p3a', cmd: 'notalisted', app: `win32-${pid}`, expect: (r) => r === 'p3a refused, not on the list: notalisted' },
      { id: 'p3b', cmd: 'ccli', app: 'win32-1', expect: (r, p) => r === `p3b refused, request is for SeaShell 'win32-1' but pane ${p} belongs to 'win32-${pid}'` },
      {
        id: 'p3c',
        cmd: 'notalisted',
        app: `win32-${pid}`,
        ageS: STALE_S,
        expect: (r, p) => {
          const m = /^p3c stale \(age (\d+) s\), ignored by pane (\S+)$/.exec(r)
          return !!m && Number(m[1]) >= STALE_S - 1 && m[2] === p
        },
      },
    ]
    if (pid === 1) throw new Error('the scratch pid is 1, so p3b would carry its app id')
    if (!(await waitFile(`${UD_LINUX}/test.json`, 30000))) throw new Error('no test.json in 30 s')
    await must(UD, { cmd: 'wait', path: '/panes/0/status', equals: 'live', timeoutMs: 60000 }, 'first pane live')
    try {
      corePid = Number(JSON.parse(readFileSync(`${UD_LINUX}/control.json`, 'utf8')).corePid) || 0
    } catch {}
    const env = await readEnv(pid)
    console.log(env.line)
    if (!env.ok) failed++
    for (const r of reqs) {
      try {
        console.log(await claim(pid, claimers, r))
      } catch (e) {
        console.log(`${r.id}: fail ${e.message}`)
        failed++
      }
    }
  } catch (e) {
    console.log(`panehook: fail ${e.message}`)
    failed++
  } finally {
    watcher.close()
    // Only this run's own files: next-pane while it still holds one of this
    // run's requests, the hook's claimed.<id> records for p3a to p3c, and the
    // next-pane.claimed.<pid> renames seen during the run. Anything else
    // (a real SC Cockpit request or claim) is left alone.
    const ours = new Set(reqs.map((r) => r.written).filter(Boolean))
    let reqOurs = false
    try {
      reqOurs = existsSync(REQ) && ours.has(readFileSync(REQ, 'utf8'))
      if (reqOurs) rmSync(REQ, { force: true })
    } catch {}
    const own = [...IDS.map((id) => `claimed.${id}`), ...[...seen].map((p) => `next-pane.claimed.${p}`)]
    const removed = reqOurs ? ['next-pane'] : []
    for (const f of own) {
      try {
        if (existsSync(`${WORK}/${f}`)) {
          rmSync(`${WORK}/${f}`, { force: true })
          removed.push(f)
        }
      } catch {}
    }
    if (pid) {
      let how = 'not stopped'
      try {
        how = await quitShell(UD, pid, NAME)
      } catch (e) {
        how = `not stopped: ${e.message}`
      }
      let coreGone = !corePid
      for (const end = now() + 10000; corePid && !coreGone && now() < end; ) {
        coreGone = !existsSync(`/proc/${corePid}`)
        if (!coreGone) await sleep(250)
      }
      console.log(`scratch ${NAME}: ${how}${corePid ? `; core ${corePid} ${coreGone ? 'gone' : 'STILL RUNNING'}` : ''}`)
      if (how !== 'quit' || !coreGone) failed++
      if (!pidAlive(pid)) rmSync(`${PIDS}/${pid}`, { recursive: true, force: true })
    }
    let reqLeft = false
    try {
      reqLeft = existsSync(REQ) && ours.has(readFileSync(REQ, 'utf8'))
    } catch {}
    const left = [...(reqLeft ? ['next-pane'] : []), ...own.filter((f) => existsSync(`${WORK}/${f}`))]
    const other = existsSync(REQ) && !reqLeft ? '; next-pane is not this run\'s, left alone' : ''
    console.log(`leftovers: ${left.length ? left.join(', ') : 'none'}${removed.length ? ` (removed ${removed.join(', ')})` : ''}${other}; ${logLines().length - log0} new log lines`)
    if (left.length) failed++
  }
  process.exit(failed ? 1 : 0)
}

await main()
