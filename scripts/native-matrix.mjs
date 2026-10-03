#!/usr/bin/env node
// The path matrix (plan Task 7b): four double-clicks on printed paths in a
// scratch native shell, each checked in the model or in shell.log. Under the
// test driver an open is logged ("open:withDefaultApp <C:\ path>") and never
// executed, so nothing opens on the desktop. No preview row: previews are not
// in this build (plan amendment 10/03).
//
// Usage (from WSL): node scripts/native-matrix.mjs
//
// Launches scratch g7b (one zsh pane, the driver on, never focused), types
// each row as an echo after the tty check, double-clicks the printed path,
// prints one `matrix: <n> ok` line per row, takes bakeoff\P2-matrix.png of
// the revealed state, and quits the scratch through its driver. Exits
// non-zero on any failure.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILD_WIN,
  PIDS,
  SCRATCH_WIN,
  drive,
  gridRows,
  launchShell,
  model,
  must,
  pidAlive,
  quitShell,
  run,
  sleep,
  toLocal,
  waitFile,
  waitText,
  writeBounds,
} from './native-gates.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'g7b'
const UD = `${SCRATCH_WIN}\\${NAME}`
const UD_LINUX = toLocal(UD)
const LOG = `${UD_LINUX}/shell.log`
const SHOT = `${BUILD_WIN}\\bakeoff\\P2-matrix.png`
const README = `${ROOT}/README.md`
const SPACED = `${ROOT}/test/fixtures/width corpus.txt`
const JSONL = '/mnt/c/seashell-build/redesign/bakeoff/results.jsonl'
const DISTRO = 'Ubuntu-24.04'
const uncOf = (p) => `\\\\wsl.localhost\\${DISTRO}${p.replace(/\//g, '\\')}`

const now = () => Date.now()

async function poll(what, timeoutMs, fn) {
  const end = now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (last.ok) return last
    if (now() >= end) throw new Error(`${what} (${last.why})`)
    await sleep(200)
  }
}

const logSize = () => (existsSync(LOG) ? statSync(LOG).size : 0)
const logSince = (from) => (existsSync(LOG) ? readFileSync(LOG).subarray(from).toString('utf8') : '')

// The one term pane, checked before each step: a real mouse on the scratch
// window can disturb it while Josh works, and the row is then run again.
async function soloPane() {
  const m = await model(UD)
  if (m.panes.length !== 1 || m.panes[0].kind !== 'term') {
    throw Object.assign(new Error(`the scratch holds ${JSON.stringify(m.panes.map((p) => p.kind))}, not one term pane`), { disturbed: true })
  }
  return m.panes[0].id
}

// Clears the pane, echoes `cmd`, and returns the viewport row whose text is
// exactly `printed` (the command line itself starts with the prompt).
async function echoRow(paneId, pid, cmd, printed) {
  await run(UD, 'clear', pid)
  await poll('the pane never cleared', 10000, async () => {
    const rows = await gridRows(UD, paneId)
    return { ok: !rows.some((r) => r.includes('echo ')), why: rows.filter((r) => r.trim()).slice(-3).join(' | ') }
  })
  await run(UD, cmd, pid)
  const hit = await poll(`"${printed}" was never printed`, 15000, async () => {
    const rows = await gridRows(UD, paneId)
    const row = rows.findIndex((r) => r.trimEnd() === printed)
    return { ok: row >= 0, row, why: rows.filter((r) => r.trim()).slice(-3).join(' | ') }
  })
  return hit.row
}

async function dblclick(paneId, row, col, mods) {
  await must(UD, { cmd: 'dblclick', paneId, row, col, mods }, 'dblclick')
}

async function revealed(path) {
  const want = `row:${path}`
  return poll(`no reveal of ${path}`, 15000, async () => {
    const m = await model(UD)
    const ok = m.sidebar.visible === true && m.sidebar.revealRowId === want && m.panes.every((p) => p.kind === 'term')
    return { ok, why: `visible ${m.sidebar.visible}, revealRowId ${m.sidebar.revealRowId}, toast ${JSON.stringify(m.toast)}` }
  })
}

async function opened(from, target) {
  const line = `open:withDefaultApp ${target}`
  await poll(`shell.log never logged ${line}`, 15000, async () => {
    const tail = logSince(from)
    return { ok: tail.split(/\r?\n/).some((l) => l.endsWith(line)), why: tail.split(/\r?\n/).filter((l) => l.includes('open:')).slice(-2).join(' | ') || 'no open: line' }
  })
  const m = await model(UD)
  if (!m.panes.every((p) => p.kind === 'term')) throw new Error(`a pane that is not a term: ${JSON.stringify(m.panes.map((p) => p.kind))}`)
  return line
}

const rows = [
  {
    what: 'plain double-click reveals',
    async run(paneId, pid) {
      const r = await echoRow(paneId, pid, `echo ${README}`, README)
      await dblclick(paneId, r, 5, { ctrl: false, alt: false, shift: false })
      await revealed(README)
      return `plain dblclick revealed row:${README}`
    },
  },
  {
    what: 'Ctrl double-click hands the file to the default app',
    async run(paneId, pid) {
      const r = await echoRow(paneId, pid, `echo ${README}`, README)
      const from = logSize()
      await dblclick(paneId, r, 5, { ctrl: true, alt: false, shift: false })
      const line = await opened(from, uncOf(README))
      return `Ctrl dblclick logged "${line}", panes all term`
    },
  },
  {
    what: 'Ctrl+Alt double-click hands the file to the default app',
    async run(paneId, pid) {
      const r = await echoRow(paneId, pid, `echo ${JSONL}`, JSONL)
      const from = logSize()
      await dblclick(paneId, r, 5, { ctrl: true, alt: true, shift: false })
      const line = await opened(from, 'C:\\seashell-build\\redesign\\bakeoff\\results.jsonl')
      return `Ctrl+Alt dblclick logged "${line}"`
    },
  },
  {
    what: 'a quoted path with a space and a :12 suffix reveals',
    async run(paneId, pid) {
      // The suffix sits outside the quotes: the tokenizer takes a quoted span
      // verbatim (spec 8.2), so a `:12` inside them would be part of the name.
      // Single quotes keep the double quotes in the printed line.
      const printed = `"${SPACED}":12`
      const r = await echoRow(paneId, pid, `echo '${printed}'`, printed)
      await dblclick(paneId, r, 5, { ctrl: false, alt: false, shift: false })
      await revealed(SPACED)
      await sleep(600)
      const shot = await must(UD, { cmd: 'shot', path: SHOT }, 'shot')
      return `plain dblclick on ${printed} revealed row:${SPACED}; shot ${shot.path}`
    },
  },
]

async function main() {
  for (const p of [README, SPACED, JSONL]) if (!existsSync(p)) throw new Error(`missing ${p}`)
  rmSync(UD_LINUX, { recursive: true, force: true })
  mkdirSync(UD_LINUX, { recursive: true })
  writeBounds(UD_LINUX, { x: 1028, y: -979 })   // the second display, as the inventory
  const pid = launchShell(NAME)
  console.log(`launched scratch ${NAME} (pid ${pid})`)
  let failed = 0
  try {
    if (!(await waitFile(`${UD_LINUX}/test.json`, 30000))) throw new Error('no test.json in 30 s')
    await must(UD, { cmd: 'wait', path: '/panes/0/status', equals: 'live', timeoutMs: 60000 }, 'first pane live')
    const first = await soloPane()
    await waitText(UD, first, '%', 60000)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      let line = ''
      for (let attempt = 1; attempt <= 2 && !line; attempt++) {
        try {
          const paneId = await soloPane()
          line = `matrix: ${i + 1} ok (${await row.run(paneId, pid)})`
        } catch (e) {
          if (attempt === 2 || !e.disturbed) {
            line = `matrix: ${i + 1} fail ${row.what}: ${e.message}`
            failed++
          } else {
            console.error(`matrix: ${i + 1} disturbed, running it again (${e.message})`)
          }
        }
      }
      console.log(line)
    }
  } catch (e) {
    console.log(`matrix: fail ${e.message}`)
    failed++
  }
  const how = await quitShell(UD, pid, NAME)
  console.log(`scratch ${NAME}: ${how}`)
  if (how !== 'quit') failed++
  if (!pidAlive(pid)) rmSync(`${PIDS}/${pid}`, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

await main()
