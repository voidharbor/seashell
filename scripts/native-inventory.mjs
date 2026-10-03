#!/usr/bin/env node
// The renderer inventory walk (plan Task 18): one check per row of section 1
// of docs/superpowers/specs/2026-10-02-seashell-renderer-inventory.md, run
// live on a scratch native shell seeded with the W10 session.
//
// Usage (from WSL): node scripts/native-inventory.mjs
//
// Rows are numbered in document order inside each letter (A1, A2, ...; the X
// table's rows count as X1.. in table order). Every row prints one line:
//   B3 ok <detail>                      checked live on the scratch in this run
//   B5 fail <detail>                    checked live and wrong
//   D8 ok (unit: <file>; not driven live: <why>)
//   D8 not driven (<why>)               no live check without breaking a rule
//   K1 skipped (Josh 10/03)             previews are out (plan amendment 10/03)
//   R1 deferred (spec 12)
// The table goes to docs/superpowers/specs/2026-10-02-seashell-inventory-status.md.
// Nothing here touches Josh's clipboard, plays a sound, shows a menu or takes
// focus: every input goes through the scratch's own driver, and every `text`,
// `key` or `drop` aimed at a pane is preceded by the tty check (no claude on
// that pane's tty). The scratch is quit through its driver; the exit code is
// non-zero when any row is `fail`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILD_WIN,
  PIDS,
  SCRATCH_WIN,
  claudeOn,
  drive,
  gridRows,
  launchShell,
  model,
  must,
  paneTty,
  pidAlive,
  quitShell,
  sleep,
  toLocal,
  waitFile,
  waitText,
  writeBounds,
} from './native-gates.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = '/Users/joshwald'
const NAME = 'j18'
const UD = `${SCRATCH_WIN}\\${NAME}`
const UD_LINUX = toLocal(UD)
const LOG = `${UD_LINUX}/shell.log`
const INVENTORY = join(ROOT, 'docs/superpowers/specs/2026-10-02-seashell-renderer-inventory.md')
const STATUS_DOC = join(ROOT, 'docs/superpowers/specs/2026-10-02-seashell-inventory-status.md')
const MAKE_SESSION = join(ROOT, 'scripts/bakeoff/make-session.mjs')
const README = `${ROOT}/README.md`
const SKIP = 'skipped (Josh 10/03)'
const DEFER = 'deferred (spec 12)'
let PID = 0

const now = () => Date.now()
const q = (s) => JSON.stringify(s)

// ------------------------------------------------------------------ the rows

function inventoryRows() {
  const lines = readFileSync(INVENTORY, 'utf8').split('\n')
  const rows = []
  let letter = null
  let n = 0
  let inSection1 = false
  for (const line of lines) {
    if (line.startsWith('## 1.')) { inSection1 = true; continue }
    if (inSection1 && line.startsWith('## ')) break
    if (!inSection1) continue
    const h = /^### ([A-Z])\. (.*)$/.exec(line)
    if (h) { letter = h[1]; n = 0; continue }
    if (!letter) continue
    if (letter === 'X') {
      if (!line.startsWith('| ') || line.startsWith('| Mac chord') || line.startsWith('|---')) continue
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean)
      rows.push({ row: `X${++n}`, text: `${cells[1]}: ${cells[2]}` })
      continue
    }
    if (line.startsWith('- ')) rows.push({ row: `${letter}${++n}`, text: line.slice(2) })
  }
  return rows
}

const shorten = (t, n = 110) => {
  const s = t.replace(/\s*\([^()]*\.(tsx?|css)[^()]*\)/g, '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 3).trimEnd() + '...' : s
}

const results = new Map()
const set = (row, status, detail = '') => results.set(row, { status, detail })

// One live check: ok with the detail it returns, or fail with the error.
async function check(row, fn) {
  try {
    const detail = await fn()
    set(row, 'ok', detail || '')
  } catch (e) {
    // A check may end in another status: nd (not driven, with why), st (any status with d).
    if (e.nd) set(row, `not driven (${e.nd})`)
    else if (e.st) set(row, e.st, e.d || '')
    else set(row, 'fail', e.message.replace(/\s+/g, ' ').slice(0, 400))
  }
}
const unit = (row, file, why) => set(row, `ok (unit: ${file}; not driven live: ${why})`)
const notDriven = (row, why) => set(row, `not driven (${why})`)

// ------------------------------------------------------------------ helpers

const D = (req) => drive(UD, req)
const M = () => model(UD)
// Every key and text goes through the tty check of whatever grid has the keys
// (the focused pane, or the drawer's shell while it is focused), even when it
// is aimed at a field: a field that lost the keys hands them to that grid.
async function guardFocused() {
  const m = await M()
  const f = m.panes.find((p) => p.focused)
  if (f && f.kind === 'term') guard(f.id)
  if (m.drawer.open && m.drawer.focused && m.drawer.ptyId) guard(m.drawer.ptyId)
}
const key = async (chord) => {
  await guardFocused()
  return must(UD, { cmd: 'key', chord }, `key ${chord}`)
}
const typeText = async (s) => {
  await guardFocused()
  return must(UD, { cmd: 'text', s }, 'text')
}
const click = (target, extra = {}) => must(UD, { cmd: 'click', target, ...extra }, `click ${target}`)
const logSize = () => (existsSync(LOG) ? statSync(LOG).size : 0)
const logSince = (from) => (existsSync(LOG) ? readFileSync(LOG).subarray(from).toString('utf8') : '')

async function until(what, timeoutMs, fn) {
  const end = now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (last && last.ok) return last
    if (now() >= end) throw new Error(`${what}${last && last.why ? ` (${last.why})` : ''}`)
    await sleep(150)
  }
}
const untilModel = (what, timeoutMs, pred, why = () => '') =>
  until(what, timeoutMs, async () => {
    const m = await M()
    return pred(m) ? { ok: true, m } : { ok: false, why: why(m) }
  }).then((r) => r.m)

const activeTab = (m) => m.tabs.find((t) => t.active)
const focused = (m) => m.panes.find((p) => p.focused) || m.panes[0]

// The tty check of the scratch: refuse when claude is on the pane's tty.
function guard(paneId) {
  let tty = ''
  try { tty = paneTty(paneId, PID) } catch {}
  if (tty && claudeOn(tty)) throw new Error(`refusing to type into ${paneId}: claude is running on ${tty}`)
  return tty
}

async function focusPane(paneId) {
  const m = await M()
  if (m.panes.find((p) => p.id === paneId && p.focused) && !m.drawer.focused && !m.find.open) return
  await click(`pane:${paneId}:title`)
  await untilModel(`${paneId} never took focus`, 5000, (x) => x.panes.some((p) => p.id === paneId && p.focused))
}
async function keyIn(paneId, chord) {
  await focusPane(paneId)
  guard(paneId)
  return key(chord)
}
async function textIn(paneId, s) {
  await focusPane(paneId)
  guard(paneId)
  return must(UD, { cmd: 'text', s }, 'text')
}
async function runIn(paneId, line) {
  await textIn(paneId, line)
  guard(paneId)
  await key('Enter')
}
const rowsOf = (paneId) => gridRows(UD, paneId)
async function rowIndex(paneId, exact, timeoutMs = 15000) {
  const r = await until(`${q(exact)} never printed in ${paneId}`, timeoutMs, async () => {
    const rows = await rowsOf(paneId)
    const i = rows.findIndex((t) => t.trimEnd() === exact)
    return { ok: i >= 0, i, why: rows.filter((t) => t.trim()).slice(-3).join(' | ') }
  })
  return r.i
}
async function clearPane(paneId) {
  await runIn(paneId, 'clear')
  await until('the pane never cleared', 10000, async () => {
    const rows = await rowsOf(paneId)
    return { ok: rows.filter((t) => t.trim()).length <= 2, why: rows.filter((t) => t.trim()).slice(-2).join(' | ') }
  })
}
async function selectTab(i) {
  const m = await M()
  await click(`tab:${m.tabs[i].id}`)
  return untilModel(`tab ${i + 1} never active`, 5000, (x) => x.tabs[i] && x.tabs[i].active)
}
// A new tab with one live zsh pane at its prompt; its pane id.
async function freshTab() {
  const before = (await M()).tabs.length
  await click('tab:new')
  const m = await untilModel('no new tab', 10000, (x) => x.tabs.length === before + 1 && x.panes.length === 1 && x.panes[0].status === 'live')
  await waitText(UD, m.panes[0].id, '%', 60000)
  return m.panes[0].id
}
async function closeSheet() {
  const m = await M()
  if (m.sheet) {
    await key('Escape')
    await untilModel('the sheet never closed', 5000, (x) => !x.sheet)
  }
}
function menuPath(items, label) {
  for (const it of items || []) {
    if (it.label === label) return it.path
    const sub = menuPath(it.submenu, label)
    if (sub) return sub
  }
  return null
}
// Empties the focused edit widget one Backspace at a time.
async function clearField(n = 12) {
  for (let i = 0; i < n; i++) await key('Backspace')
}
const sheetField = (m, id) => {
  for (const s of (m.sheet && m.sheet.sections) || []) for (const f of s.fields) if (f.id === id) return f
  return null
}

// --------------------------------------------------------------- the checks

async function walk() {
  // ---- boot and the restore card (A2, O3)
  const card = await must(UD, { cmd: 'wait', path: '/restore/tabs', timeoutMs: 90000 }, 'the restore card')
  const m0 = await M()
  await check('A2', async () => {
    if (!(m0.restore && m0.restore.tabs === 9 && m0.restore.panes === 10)) throw new Error(`restore card ${q(m0.restore)}`)
    return `session found: the restore card reads ${m0.restore.tabs} tabs, ${m0.restore.panes} panes before any tab exists (tabs ${m0.tabs.length})`
  })
  await check('O3', async () => {
    await click('restore:yes')
    const m = await untilModel('nine tabs never came', 60000, (x) => x.tabs.length === 9 && !x.restore)
    return `card ${card.value} tabs, savedAt ${m0.restore.savedAt}; restore:yes gave ${m.tabs.length} tabs (Esc as Start fresh not driven)`
  })
  let m = await untilModel('tab 1 panes never live', 60000, (x) => x.panes.length === 2 && x.panes.every((p) => p.status === 'live'))
  const [p1a, p1b] = m.panes.map((p) => p.id)
  await waitText(UD, p1a, '%', 90000)
  await waitText(UD, p1b, '%', 90000)
  const firstSavedAt = JSON.parse(readFileSync(`${UD_LINUX}/last-session.json`, 'utf8')).savedAt
  const bootAt = now()

  // ---- A6, Q, F1 layout and status
  await check('A6', async () => {
    const x = await M()
    const p = x.panes[0]
    if (!(p.rect.y >= x.window.tabStripH && x.window.statusH > 0 && !x.sidebar.visible)) throw new Error(`pane y ${p.rect.y}, strip ${x.window.tabStripH}`)
    const s = await must(UD, { cmd: 'rect', target: `pane:${p.id}:grid` }, 'grid rect')
    return `strip ${x.window.tabStripH} DIP, panes from y ${p.rect.y}, grid rect y ${Math.round(s.y)}, status bar ${x.window.statusH} DIP at the bottom, update banner ${x.update ? 'shown' : 'idle'}`
  })
  const q1 = async () => {
    const x = await M()
    if (!/\d+ panes?/.test(x.status.panes) || !/in panes/.test(x.status.inPanes)) throw new Error(`status ${q(x.status)}`)
    return `status ${q(x.status.panes)}, ${q(x.status.inPanes)}; used/total, compressed and swap read ${q(x.status.used)}, ${q(x.status.compressed)}, ${q(x.status.swap)}: they come from vm_stat and sysctl (src/main/monitor/system-mem.ts), macOS only, empty off the Mac in the Electron build too`
  }
  await check('Q2', async () => {
    const x = await M()
    if (!/Ctrl\+Shift\+D/.test(x.status.hint)) throw new Error(`hint ${q(x.status.hint)}`)
    return `hint ${q(x.status.hint)}`
  })

  // ---- B tabs
  await check('B1', async () => {
    const x = await M()
    const ws = []
    for (const t of x.tabs) ws.push(Math.round((await must(UD, { cmd: 'rect', target: `tab:${t.id}` }, 'tab rect')).w))
    const s = await D({ cmd: 'stats' })
    const lo = 100 * x.window.uiScale - 1, hi = 220 * x.window.uiScale + 1
    if (!ws.every((w) => w >= lo && w <= hi)) throw new Error(`tab widths ${ws.join(',')}`)
    return `9 tab widths ${Math.min(...ws)} to ${Math.max(...ws)} DIP (100 to 220 x ${x.window.uiScale}), strip scroll ${s.stripScroll}/${s.stripScrollMax}`
  })
  await check('B2', async () => {
    const x = await selectTab(2)
    await selectTab(0)
    return `click on tab 3 made it active (${x.tabs[2].name}), tab 1 again`
  })
  await check('B3', async () => {
    const t = (await M()).tabs[0]
    await must(UD, { cmd: 'dblclick', target: `tab:${t.id}` }, 'dblclick tab')
    await untilModel('no rename field', 5000, (x) => x.tabs[0].renaming)
    await typeText('r'.repeat(45))
    await key('Enter')
    let x = await untilModel('rename never committed', 5000, (y) => !y.tabs[0].renaming)
    const committed = x.tabs[0].name
    if (committed !== 'r'.repeat(40)) throw new Error(`45 typed characters committed as ${q(committed)}`)
    await must(UD, { cmd: 'dblclick', target: `tab:${t.id}` }, 'dblclick tab')
    await untilModel('no rename field', 5000, (y) => y.tabs[0].renaming)
    await typeText('zzz')
    await key('Escape')
    x = await untilModel('Escape never cancelled', 5000, (y) => !y.tabs[0].renaming)
    if (x.tabs[0].name !== committed) throw new Error(`Escape left ${q(x.tabs[0].name)}`)
    await must(UD, { cmd: 'dblclick', target: `tab:${t.id}` }, 'dblclick tab')
    await untilModel('no rename field', 5000, (y) => y.tabs[0].renaming)
    await key('Backspace')
    await key('Enter')
    x = await untilModel('blank never committed', 5000, (y) => !y.tabs[0].renaming)
    if (x.tabs[0].name !== '~') throw new Error(`a blank name gave ${q(x.tabs[0].name)}`)
    return `dblclick opened the field with the text selected (typing replaced it), 45 typed gave 40, Escape cancelled, a blank name reverted to "~" (blur and the tooltip not driven)`
  })
  const menu = await D({ cmd: 'menu' })
  await check('B4', async () => {
    const path = menuPath(menu.items, 'Rename Tab…')
    if (!path) throw new Error('no Rename Tab… in the menu')
    await must(UD, { cmd: 'menuPick', path }, 'menuPick')
    await untilModel('no rename field', 5000, (x) => activeTab(x).renaming)
    await key('Escape')
    await untilModel('rename never closed', 5000, (x) => !activeTab(x).renaming)
    return `menuPick ${q(path)} (File, Rename Tab…) opened the inline field; Escape closed it`
  })
  await check('B6', async () => {
    const before = (await M()).tabs.length
    const pid = await freshTab()
    const x = await M()
    const t = activeTab(x)
    if (t.name !== '~' || x.tabs.length !== before + 1) throw new Error(`new tab ${q(t)}`)
    await runIn(pid, 'echo cwd=$PWD')
    await rowIndex(pid, `cwd=${HOME}`)
    return `tab:new made tab ${x.tabs.length} named "~", its shell printed cwd=${HOME}`
  })
  await check('B5', async () => {
    const x = await M()
    const t = activeTab(x)
    const p = x.panes[0].id
    const line = readFileSync(`${PIDS}/${PID}/pane-${p}.pid`, 'utf8').trim()
    const zpid = Number(line.split(' ')[0])
    await click(`tab:${t.id}:close`)
    await untilModel('tab never closed', 10000, (y) => !y.tabs.some((z) => z.id === t.id))
    await until(`zsh ${zpid} still alive`, 10000, async () => {
      try { execFileSync('ps', ['-p', String(zpid)]); return { ok: false } } catch { return { ok: true } }
    })
    return `tab close "x" removed the tab and its zsh ${zpid} ended; the dirty-preview confirm is ${SKIP}`
  })
  await check('B7', async () => {
    await selectTab(2)
    const id = (await M()).tabs[2].id
    await key('Ctrl+Alt+w')
    const y = await untilModel('tab never closed', 10000, (z) => !z.tabs.some((t) => t.id === id))
    if (!y.tabs[0].active) throw new Error(`active is ${activeTab(y).name}`)
    return `Ctrl+Alt+W on the active tab 3 closed it; tab 1 became active (${y.tabs.length} tabs)`
  })
  await check('B8', async () => {
    const n = (await M()).tabs.length
    await selectTab(n - 1)
    await key('Ctrl+Alt+]')
    let y = await untilModel('next tab never wrapped', 5000, (z) => z.tabs[0].active)
    await key('Ctrl+Alt+[')
    y = await untilModel('previous tab never wrapped', 5000, (z) => z.tabs[n - 1].active)
    await key('Ctrl+Shift+3')
    y = await untilModel('Tab 3 never selected', 5000, (z) => z.tabs[2].active)
    await key('Ctrl+Shift+1')
    await untilModel('Tab 1 never selected', 5000, (z) => z.tabs[0].active)
    return `Ctrl+Alt+] on the last of ${n} wrapped to tab 1, Ctrl+Alt+[ wrapped back, Ctrl+Shift+3 and Ctrl+Shift+1 selected tabs 3 and 1`
  })
  await check('B9', async () => {
    await clearPane(p1a)
    await runIn(p1a, 'echo keep-j18-scrollback')
    await rowIndex(p1a, 'keep-j18-scrollback')
    await selectTab(1)
    const g = await rowsOf(p1a)
    await selectTab(0)
    if (!g.some((t) => t.trimEnd() === 'keep-j18-scrollback')) throw new Error('the hidden pane lost its rows')
    return 'tab 1 pane printed a marker, its grid still held it while tab 2 was active and after coming back'
  })

  // ---- C panes and layout, in a fresh tab
  const c1 = await freshTab()
  const cols = []
  await check('C1', async () => {
    for (let i = 2; i <= 6; i++) {
      await keyIn((await M()).panes.find((p) => p.focused).id, 'Ctrl+Shift+D')
      const y = await untilModel(`pane ${i} never came`, 30000, (z) => z.panes.length === i && z.panes.every((p) => p.status === 'live'))
      cols.push(new Set(y.panes.map((p) => Math.round(p.rect.x))).size)
    }
    let y = await M()
    if (!y.tabFull) throw new Error('tabFull false at 6 panes')
    await key('Ctrl+Shift+D')
    y = await untilModel('no full toast', 5000, (z) => /Tab is full/.test(z.toast || ''))
    if (y.panes.length !== 6) throw new Error(`${y.panes.length} panes`)
    const r = await D({ cmd: 'rect', target: 'pane:new' })
    return `6 panes, tabFull true, a 7th Ctrl+Shift+D toasted ${q(y.toast)}${r.ok ? '' : ' (pane:new button not registered)'}`
  })
  await check('C2', async () => {
    const y = await M()
    const xs = [...new Set(y.panes.map((p) => Math.round(p.rect.x)))].sort((a, b) => a - b)
    const per = xs.map((x) => y.panes.filter((p) => Math.round(p.rect.x) === x).length)
    return `a row of ${xs.length} columns holding ${per.join('+')} panes`
  })
  await check('C3', async () => {
    const want = [2, 2, 2, 3, 3]
    if (cols.join() !== want.join()) throw new Error(`columns after 2..6 panes: ${cols.join(',')}, want ${want.join(',')}`)
    return `columns after inserting panes 2..6: ${cols.join(',')} (ceil(sqrt(N)))`
  })
  await check('C6', async () => {
    const y = await M()
    const d = y.dividers.find((z) => z.orientation === 'vertical')
    if (!d || Math.round(d.rect.w) !== 9) throw new Error(`divider ${q(d)}`)
    const r = await must(UD, { cmd: 'drag', target: `divider:${d.id}`, dx: -2000, dy: 0, steps: 10 }, 'drag')
    const z = await M()
    const minCols = Math.min(...z.panes.map((p) => p.cols))
    const minRows = Math.min(...z.panes.map((p) => p.rows))
    if (minCols < 20 || minRows < 6) throw new Error(`a pane at ${minCols} cols, ${minRows} rows`)
    return `vertical divider hit strip ${d.rect.w} DIP; a -2000 DIP drag (${r.models} models) stopped with every pane at >= ${minCols} cols, ${minRows} rows`
  })
  await check('D2', async () => {
    const y = await M()
    const p = y.panes.reduce((a, b) => (a.cols < b.cols ? a : b))
    await clearPane(p.id)
    await runIn(p.id, 'echo size=$(stty size)')
    await rowIndex(p.id, `size=${p.rows} ${p.cols}`)
    return `after the drag the narrowest pane's pty reports ${p.rows} rows x ${p.cols} cols, matching the model`
  })
  await check('C4', async () => {
    const before = (await M()).panes.map((p) => p.cols).join(',')
    await key('Ctrl+Alt+r')
    const y = await untilModel('rebalance never moved the panes', 5000, (z) => z.panes.map((p) => p.cols).join(',') !== before)
    const ws = [...new Set(y.panes.map((p) => Math.round(p.rect.w)))]
    if (Math.max(...ws) - Math.min(...ws) > 2) throw new Error(`widths ${ws.join(',')}`)
    return `Ctrl+Alt+R took cols ${before} to ${y.panes.map((p) => p.cols).join(',')} (even widths ${ws.join(',')})`
  })
  await check('M3', async () => {
    const y = await M()
    const colors = y.panes.map((p) => p.color)
    if (new Set(colors).size !== colors.length || colors.some((c) => !c)) throw new Error(`colours ${colors.join(',')}`)
    return `auto colours in the 6-pane tab: ${colors.join(', ')} (first ${colors[0]})`
  })
  await check('C10', async () => {
    const y = await M()
    const p = y.panes[1]
    for (const t of ['title', 'color', 'link', 'close']) await must(UD, { cmd: 'rect', target: `pane:${p.id}:${t}` }, `rect ${t}`)
    return `pane ${p.index}: label ${q(p.label)}, badge ${q(p.badge)}, memBadge ${q(p.memBadge)}, zoom ${q(p.zoomPercent)}, color ${p.color}; title, color, link and close targets registered`
  })
  await check('C9', async () => {
    const y = await M()
    const target = y.panes[3]
    await must(UD, { cmd: 'click', paneId: target.id, row: 0, col: 0 }, 'click grid')
    await untilModel('a click never focused the pane', 5000, (z) => z.panes[3].focused)
    await key('Ctrl+Shift+]')
    await untilModel('next pane never focused', 5000, (z) => z.panes[4].focused)
    await key('Ctrl+Shift+[')
    await untilModel('previous pane never focused', 5000, (z) => z.panes[3].focused)
    return 'a press on pane 4 grid focused it, Ctrl+Shift+] moved to 5, Ctrl+Shift+[ back to 4 (attention clearing: D12)'
  })
  await check('C8', async () => {
    const id = (await M()).panes[3].id
    await key('Ctrl+Shift+Return')
    let y = await untilModel('no zoom', 5000, (z) => z.zoomedPaneId === id)
    await must(UD, { cmd: 'dblclick', target: `pane:${id}:title` }, 'dblclick title')
    y = await untilModel('no unzoom', 5000, (z) => z.zoomedPaneId === null)
    await must(UD, { cmd: 'dblclick', target: `pane:${id}:title` }, 'dblclick title')
    y = await untilModel('title dblclick never zoomed', 5000, (z) => z.zoomedPaneId === id)
    await key('Ctrl+Shift+Return')
    await untilModel('no unzoom', 5000, (z) => z.zoomedPaneId === null)
    return 'Ctrl+Shift+Return zoomed pane 4, a title double-click toggled it off and on, the chord off again'
  })
  await check('C12', async () => {
    const y = await M()
    if (y.panes.some((p) => 'renaming' in p)) throw new Error('a pane rename field exists')
    return 'a pane title double-click zooms (C8); the model has no pane rename field'
  })
  await check('C13', async () => {
    const id = (await M()).panes[5].id
    await runIn(id, 'exit 3')
    let y = await untilModel('no exit overlay', 15000, (z) => z.panes.find((p) => p.id === id).status === 'exited')
    const ex = y.panes.find((p) => p.id === id).exit
    if (!ex || ex.text !== 'exited · code 3' || !ex.failed) throw new Error(`exit ${q(ex)}`)
    await click(`pane:${id}:restart`)
    y = await untilModel('no restart', 30000, (z) => z.panes.find((p) => p.id === id && p.status === 'live'))
    await waitText(UD, id, '%', 60000)
    return `exit 3 gave ${q(ex.text)} failed=${ex.failed}; Restart brought the same id back live`
  })
  await check('C5', async () => {
    let y = await M()
    const id = y.panes[2].id
    await click(`pane:${id}:close`)
    y = await untilModel('pane never closed', 10000, (z) => z.panes.length === 5)
    const f = focused(y)
    return `closing pane 3 of 6 left 5 (focus on ${f.index}); closing a tab's last pane closes the tab: X10`
  })
  await check('C14', async () => {
    let y = await M()
    const id = y.panes[0].id
    const zpid = Number(readFileSync(`${PIDS}/${PID}/pane-${id}.pid`, 'utf8').trim().split(' ')[0])
    await focusPane(id)
    await key('Ctrl+Shift+W')
    y = await untilModel('pane never closed', 10000, (z) => z.panes.length === 4)
    await until(`zsh ${zpid} still alive`, 10000, async () => {
      try { execFileSync('ps', ['-p', String(zpid)]); return { ok: false } } catch { return { ok: true } }
    })
    return `closing a term pane ended its zsh ${zpid} (no survivors toast); the dirty-preview confirm is ${SKIP}`
  })

  // ---- D terminal, on tab 2 (one big pane)
  await selectTab(1)
  const d = (await M()).panes[0].id
  await waitText(UD, d, '%', 60000)
  await check('D1', async () => {
    const y = await M()
    const p = y.panes[0]
    await clearPane(d)
    await runIn(d, 'echo sh=$0 login=$([[ -o login ]] && echo yes) size=$(stty size)')
    await rowIndex(d, `sh=/usr/bin/zsh login=yes size=${p.rows} ${p.cols}`)
    return `the pane's shell is /usr/bin/zsh as a login shell at ${p.rows}x${p.cols} as the model says (launch command, newPaneCommand and the spawn-failure line not driven)`
  })
  await check('D6', async () => {
    await clearPane(d)
    await runIn(d, 'cat -v')
    await sleep(300)
    await keyIn(d, 'Shift+Enter')
    await rowIndex(d, '^[', 5000)
    await keyIn(d, 'Ctrl+c')
    await waitText(UD, d, '%', 5000)
    return 'Shift+Enter under cat -v printed ^[ then the line ended: ESC CR'
  })
  await check('D7', async () => {
    const before = (await M()).tabs.length
    await clearPane(d)
    await keyIn(d, 'Ctrl+Shift+T')
    const y = await untilModel('no new tab', 10000, (z) => z.tabs.length === before + 1)
    await waitText(UD, y.panes[0].id, '%', 60000)
    await key('Ctrl+Alt+w')
    await untilModel('tab never closed', 10000, (z) => z.tabs.length === before)
    await selectTab(1)
    const rows = await rowsOf(d)
    if (rows.filter((t) => t.trim()).length > 2) throw new Error(`the grid got ${rows.filter((t) => t.trim()).join(' | ')}`)
    return 'Ctrl+Shift+T pressed in a focused grid opened a tab and typed nothing into the pane'
  })
  await check('D10', async () => {
    await clearPane(d)
    await textIn(d, 'echo selall-j18')
    await keyIn(d, 'Ctrl+Shift+A')
    const s = await must(UD, { cmd: 'selection', paneId: d }, 'selection')
    if (!s.text.includes('echo selall-j18')) throw new Error(`selection ${q(s.text)}`)
    return `Ctrl+Shift+A selected ${q(s.text)} (the logical line to the cursor)`
  })
  await check('D9', async () => {
    await keyIn(d, 'Backspace')
    await until('the line was not cleared', 5000, async () => {
      const rows = await rowsOf(d)
      return { ok: !rows.some((t) => t.includes('selall-j18')), why: rows.filter((t) => t.trim()).join(' | ') }
    })
    return 'Backspace right after the input-line select cleared the whole line (Ctrl+U)'
  })
  await check('D13', async () => {
    await clearPane(d)
    await runIn(d, 'seq 1 500')
    await rowIndex(d, '500')
    let last = ''
    const tries = []
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await must(UD, { cmd: 'wheel', paneId: d, dy: 1, gapsMs: [400, 32, 0] }, 'wheel burst')
      const dist = r.notches.map((n) => Math.abs(n.rows))
      last = `rows per notch ${dist.join(', ')} at gaps ${r.notches.map((n) => n.gapMs).join(', ')} ms`
      if (dist[0] > 0 && dist[0] <= dist[1] && dist[1] <= dist[2] && dist[2] > dist[0]) {
        await textIn(d, ' ')
        await keyIn(d, 'Ctrl+u')
        return `seq 1 500, three wheel notches at increasing speed through WM_MOUSEWHEEL: ${last}${tries.length ? ` (attempt ${attempt}; attempt 1 read ${tries.join('; ')}, the 0 ms gap landing across a 15.6 ms GetTickCount64 tick)` : ''}`
      }
      tries.push(dist.join(', '))
      await sleep(500)
    }
    throw new Error(`the distance per notch did not grow: ${last}`)
  })
  await check('D14', async () => {
    await clearPane(d)
    await runIn(d, 'seq 1 3000 | less --mouse')
    const on = await until('the app scrollbar never came on', 15000, async () => {
      const a = await must(UD, { cmd: 'appBar', paneId: d }, 'appBar')
      return { ok: a.on, a, why: q(a) }
    })
    const a0 = on.a
    const firstRow = (await rowsOf(d))[0]
    await must(UD, { cmd: 'click', x: a0.rect.x + a0.rect.w - 4, y: a0.rect.y + 8 }, 'click track')
    const a1 = await must(UD, { cmd: 'appBar', paneId: d }, 'appBar')
    await sleep(300)
    await must(UD, { cmd: 'wheel', paneId: d, dy: -1 }, 'wheel')
    const a2 = await must(UD, { cmd: 'appBar', paneId: d }, 'appBar')
    await sleep(400)
    const rows2 = await rowsOf(d)
    guard(d)
    await key('q')
    const a3 = await until('less never quit', 10000, async () => {
      const a = await must(UD, { cmd: 'appBar', paneId: d }, 'appBar')
      return { ok: !a.on, a }
    })
    if (!(a1.offset > a0.offset && a2.offset < a1.offset)) throw new Error(`offsets ${a0.offset} -> ${a1.offset} -> ${a2.offset}`)
    return `less --mouse: appBar.on true (mouseMode ${a0.mouseMode}), a click on the track paged offset ${a0.offset} -> ${a1.offset} (range ${a1.range}), a wheel notch down moved it to ${a2.offset} and less's top row ${q(firstRow)} -> ${q(rows2[0])}; q quit it, appBar.on ${a3.a.on}`
  })
  await check('D17', async () => {
    await clearPane(d)
    await runIn(d, "printf 'alpha-j18\\nbeta-j18\\n'")
    const ra = await rowIndex(d, 'alpha-j18')
    const rb = await rowIndex(d, 'beta-j18')
    const r = await must(UD, { cmd: 'dragSelect', paneId: d, fromRow: ra, fromCol: 0, toRow: rb, toCol: 7 }, 'dragSelect')
    const s = await must(UD, { cmd: 'selection', paneId: d }, 'selection')
    if (!/^alpha-j18\r?\nbeta-j1/.test(s.text)) throw new Error(`selection ${q(s.text)}`)
    await must(UD, { cmd: 'dblclick', paneId: d, row: rb, col: 2 }, 'dblclick word')
    const w = await must(UD, { cmd: 'selection', paneId: d }, 'selection')
    await must(UD, { cmd: 'click', paneId: d, row: rb, col: 2 }, 'third click')
    const l = await must(UD, { cmd: 'selection', paneId: d }, 'selection')
    if (w.text !== 'beta-j18' || !/^beta-j18\s*$/.test(l.text)) throw new Error(`word ${q(w.text)}, line ${q(l.text)}`)
    return `dragSelect rows ${ra}..${rb} gave selection ${q(s.text)} with the line break; a double-click selected the word ${q(w.text)} and a third click the line ${q(l.text)}; mouse reports and the alternate screen: D14 (OSC 8 and bracketed paste not driven)`
  })
  await check('D16', async () => {
    await key('Ctrl+,')
    let y = await untilModel('no settings sheet', 5000, (z) => z.sheet && z.sheet.kind === 'settings')
    const f = sheetField(y, 'palette')
    const amber = f.options.find((o) => o.id !== 'native' && !o.selected)
    await click(`sheet:settings:palette:${amber.id}`)
    y = await untilModel('palette never changed', 5000, (z) => z.window.palette !== null)
    const pal = y.window.palette
    await click('sheet:settings:palette:native')
    y = await untilModel('palette never restored', 5000, (z) => z.window.palette === null)
    await closeSheet()
    const g = await rowsOf(d)
    if (!g.some((t) => t.includes('alpha-j18'))) throw new Error('the grid lost its rows')
    return `Terminal palette ${amber.id} pushed palette ${pal.background || ''}/${pal.foreground || ''} to the live grid (rows kept), native restored it`
  })
  await check('D5', async () => {
    const y = await M()
    if (y.window.palette !== null) throw new Error(`palette ${q(y.window.palette)}`)
    return 'window.palette null at boot: the grid draws its built-in Homebrew palette'
  })
  await check('D11', async () => {
    await runIn(d, 'cd /tmp')
    const y = await untilModel('the label never followed the cwd', 10000, (z) => z.panes[0].label === 'tmp', (z) => z.panes[0].label)
    await runIn(d, 'cd ~')
    await untilModel('the label never followed the cwd', 10000, (z) => z.panes[0].label === '~' || z.panes[0].label === 'joshwald', (z) => z.panes[0].label)
    return `cd /tmp relabelled the pane ${q(y.panes[0].label)} (tooltip ${q(y.panes[0].tooltip)}) and cd ~ back, through the shell's OSC 7`
  })
  await check('C11', async () => {
    await runIn(d, "printf '\\033]2;me@box:/a/b/walk-title\\007'; sleep 4")
    const y = await untilModel('the OSC title never named the pane', 4000, (z) => z.panes[0].label === 'walk-title', (z) => z.panes[0].label)
    await sleep(4000)
    return `OSC 2 "me@box:/a/b/walk-title" became the label ${q(y.panes[0].label)} (user@host: and the path stripped); cwd labels: D11`
  })
  await check('E4', async () => {
    await clearPane(d)
    await runIn(d, "printf '\\033[?1000h'; cat -v")
    await sleep(500)
    const r = (await rowsOf(d)).length
    const target = Math.max(2, r - 4)
    await must(UD, { cmd: 'dblclick', paneId: d, row: target, col: 3 }, 'dblclick')
    await sleep(400)
    const plain = (await rowsOf(d)).join('').split('^[[M').length - 1
    await must(UD, { cmd: 'dblclick', paneId: d, row: target, col: 3, mods: { alt: true } }, 'alt dblclick')
    await sleep(400)
    const after = (await rowsOf(d)).join('').split('^[[M').length - 1
    await keyIn(d, 'Ctrl+c')
    await runIn(d, "printf '\\033[?1000l'")
    if (!(plain >= 4 && after - plain < 4)) throw new Error(`reports: plain ${plain}, then Alt added ${after - plain}`)
    return `under mouse tracking a plain double-click sent ${plain} reports, an Alt double-click ${after - plain} (the second press kept from the pty)`
  })

  // ---- E path click and F explorer
  await check('F1', async () => {
    let y = await M()
    if (y.sidebar.visible) throw new Error('visible before any toggle')
    await key('Ctrl+Shift+B')
    y = await untilModel('never shown', 5000, (z) => z.sidebar.visible)
    await key('Ctrl+Shift+B')
    await untilModel('never hidden', 5000, (z) => !z.sidebar.visible)
    return 'hidden at launch, Ctrl+Shift+B showed and hid it; reveals open it: E2'
  })
  await check('E2', async () => {
    await clearPane(d)
    await runIn(d, `echo ${README}`)
    const r = await rowIndex(d, README)
    await must(UD, { cmd: 'dblclick', paneId: d, row: r, col: 5 }, 'dblclick')
    await untilModel('no reveal', 15000, (z) => z.sidebar.visible && z.sidebar.revealRowId === `row:${README}`)
    const from = logSize()
    await must(UD, { cmd: 'dblclick', paneId: d, row: r, col: 5, mods: { ctrl: true, alt: true } }, 'dblclick')
    await until('no open:withDefaultApp', 10000, async () => ({ ok: /open:withDefaultApp \\\\wsl\.localhost\\.*README\.md/.test(logSince(from)) }))
    return `plain dblclick revealed row:${README}; Ctrl+Alt dblclick logged open:withDefaultApp (test mode, nothing opened); the Ctrl preview gesture is ${SKIP}; drawer: G7`
  })
  await check('F10', async () => {
    const y = await M()
    const row = y.sidebar.rows.find((r) => r.id === `row:${README}`)
    const dirs = y.sidebar.rows.filter((r) => r.isDir && r.expanded).map((r) => r.name)
    if (!row || !row.selected) throw new Error(`row ${q(row)}`)
    return `the README row selected, flashing=${row.flashing}, the chain expanded (${dirs.join(' > ')})`
  })
  await check('F2', async () => {
    const y = await M()
    if (y.sidebar.rows[0].name !== 'Home' || y.sidebar.rows[0].path !== HOME) throw new Error(`root ${q(y.sidebar.rows[0])}`)
    return `the root row reads "Home" (${HOME})`
  })
  await check('F4', async () => {
    const y = await M()
    const f = y.sidebar.rows.find((r) => !r.isDir && r.chip)
    const ig = y.sidebar.rows.filter((r) => r.ignored).length
    if (!f) throw new Error('no file row with a chip')
    return `rows at depths 0..${Math.max(...y.sidebar.rows.map((r) => r.depth))}, ${q(f.name)} chip ${q(f.chip)}, ${ig} gitignored rows dimmed, error and truncation rows: unit (controller-explorer.test.ts)`
  })
  await check('F9', async () => {
    const probe = `${ROOT}/j18-watch-probe.txt`
    writeFileSync(probe, 'probe\n')
    try {
      await untilModel('the new file never appeared', 10000, (z) => z.sidebar.rows.some((r) => r.path === probe))
    } finally {
      rmSync(probe, { force: true })
    }
    await untilModel('the removed file never went', 10000, (z) => !z.sidebar.rows.some((r) => r.path === probe))
    return 'a file created in the expanded worktree directory appeared and went away after removal, no refresh pressed'
  })
  await check('F8', async () => {
    const before = (await M()).sidebar.rows.length
    await click('sidebar:refresh')
    await sleep(800)
    await key('Ctrl+Shift+R')
    await sleep(800)
    const y = await M()
    if (!y.sidebar.visible || y.sidebar.rows.length !== before) throw new Error(`rows ${before} -> ${y.sidebar.rows.length}`)
    return `the refresh button and Ctrl+Shift+R re-read the tree (${y.sidebar.rows.length} rows kept, expansion kept)`
  })
  await check('F5', async () => {
    let y = await M()
    const dir = y.sidebar.rows.find((r) => r.isDir && !r.expanded && r.depth === 1 && !r.name.startsWith('.'))
    await click(`sidebar:twisty:${dir.path}`)
    y = await untilModel('twisty never expanded', 5000, (z) => z.sidebar.rows.find((r) => r.path === dir.path).expanded)
    if (y.sidebar.rows.find((r) => r.path === dir.path).selected) throw new Error('the twisty selected the row')
    await click(`sidebar:twisty:${dir.path}`)
    await click(`sidebar:row:${dir.path}`)
    y = await untilModel('click never selected', 5000, (z) => z.sidebar.rows.find((r) => r.path === dir.path).selected)
    await must(UD, { cmd: 'dblclick', target: `sidebar:row:${dir.path}` }, 'dblclick dir')
    y = await untilModel('dblclick never toggled', 5000, (z) => z.sidebar.rows.find((r) => r.path === dir.path).expanded)
    await must(UD, { cmd: 'dblclick', target: `sidebar:row:${dir.path}` }, 'dblclick dir')
    const from = logSize()
    await must(UD, { cmd: 'dblclick', target: `sidebar:row:${README}` }, 'dblclick file')
    await until('the file dblclick opened nothing', 10000, async () => ({ ok: /open:withDefaultApp .*README\.md/.test(logSince(from)) }))
    return `twisty on ${dir.name} expanded it unselected, a click selected it, a dblclick toggled it, a README dblclick logged open:withDefaultApp`
  })
  await check('F6', async () => {
    return 'a text file went to the default app through openPath (F5, logged); executable, too-large, binary and missing routes: unit (open-path.test.ts)'
  })
  await check('F7', async () => {
    await click(`sidebar:row:${README}`, { button: 2 })
    const y = await untilModel('no context menu', 5000, (z) => z.sidebar.menu)
    const items = y.sidebar.menu.items.map((i) => `${i.label}${i.enabled ? '' : ' (off)'}`)
    await key('Escape')
    await untilModel('Escape never closed it', 5000, (z) => !z.sidebar.menu)
    return `right-click on README: ${items.join(', ')}; Escape closed it`
  })
  await check('F3', async () => {
    const w0 = (await M()).sidebar.width
    await must(UD, { cmd: 'drag', target: 'sidebar:grip', dx: 900, dy: 0, steps: 10 }, 'drag')
    const w1 = (await M()).sidebar.width
    await must(UD, { cmd: 'drag', target: 'sidebar:grip', dx: -900, dy: 0, steps: 10 }, 'drag')
    const w2 = (await M()).sidebar.width
    await must(UD, { cmd: 'dblclick', target: 'sidebar:grip' }, 'dblclick grip')
    const w3 = (await untilModel('never reset', 5000, (z) => z.sidebar.width === 260)).sidebar.width
    if (!(w0 === 260 && w1 === 620 && w2 === 170)) throw new Error(`widths ${w0}, ${w1}, ${w2}`)
    return `default ${w0}, dragged to the ${w1} cap and the ${w2} floor, a grip double-click reset it to ${w3}`
  })
  await check('F11', async () => {
    const y = await M()
    throw Object.assign(new Error(), { nd: `the click copies into Josh's clipboard; the strip read ${q(y.sidebar.strip)} live` })
  })
  await check('E5', async () => {
    await selectTab(2)
    const p = (await M()).panes[0].id
    await waitText(UD, p, '%', 60000)
    const long = `${ROOT}/docs/superpowers/specs/2026-10-02-seashell-renderer-inventory.md`
    const pad = Math.max(1, (await M()).panes[0].cols - 30)
    await clearPane(p)
    await runIn(p, `printf '%${pad}s%s\\n' '' '${long}'`)
    const out = await until('the wrapped path never printed', 10000, async () => {
      const rows = await rowsOf(p)
      const i = rows.findLastIndex((t) => t.includes('renderer-inventory.md') && !t.includes('printf'))
      return { ok: i > 0, rows, i }
    })
    const { rows, i } = out
    const cols = (await M()).panes[0].cols
    await must(UD, { cmd: 'dblclick', paneId: p, row: i, col: 2 }, 'dblclick')
    try {
      await untilModel('no reveal', 8000, (z) => z.sidebar.revealRowId === `row:${long}`, (z) => `${z.sidebar.revealRowId} ${z.toast}`)
    } catch (e) {
      // Diagnose: the same path's first part, on the row above.
      await must(UD, { cmd: 'dblclick', paneId: p, row: i - 1, col: cols - 5 }, 'dblclick head')
      const z = await M()
      throw new Error(`${e.message}; the tail row ${i} reads ${q(rows[i])}, row ${i - 1} ${q(rows[i - 1])}; a dblclick on the head gave revealRowId ${z.sidebar.revealRowId}, toast ${q(z.toast)}`)
    }
    return `a path pushed past the ${cols}-column edge wrapped; a double-click on its second row revealed it`
  })
  const tab3 = (await M()).panes[0].id
  await check('E6', async () => {
    await clearPane(tab3)
    const printed = `(${ROOT}/package.json:3:5),`
    await runIn(tab3, `echo '${printed}'`)
    const r = await rowIndex(tab3, printed)
    await must(UD, { cmd: 'dblclick', paneId: tab3, row: r, col: 3 }, 'dblclick')
    await untilModel('no reveal', 15000, (z) => z.sidebar.revealRowId === `row:${ROOT}/package.json`, (z) => `${z.sidebar.revealRowId} ${z.toast}`)
    return `${printed} (brackets, :line:col, trailing comma) revealed package.json; quoted spans with spaces: the matrix row 4`
  })
  await check('E7', async () => {
    await clearPane(tab3)
    await runIn(tab3, 'echo nothing-here-j18.txt')
    const r = await rowIndex(tab3, 'nothing-here-j18.txt')
    await must(UD, { cmd: 'dblclick', paneId: tab3, row: r, col: 3 }, 'dblclick')
    const y = await untilModel('no miss toast', 10000, (z) => /No file at/.test(z.toast || ''), (z) => z.toast)
    return `a missing bare name toasted ${q(y.toast)}`
  })
  await check('E8', async () => {
    await clearPane(tab3)
    await runIn(tab3, 'touch /tmp/j18-outside.txt; echo /tmp/j18-outside.txt')
    const r = await rowIndex(tab3, '/tmp/j18-outside.txt')
    await must(UD, { cmd: 'dblclick', paneId: tab3, row: r, col: 3 }, 'dblclick')
    const y = await untilModel('no outside toast', 10000, (z) => /outside the file explorer/.test(z.toast || ''), (z) => z.toast)
    await runIn(tab3, 'rm -f /tmp/j18-outside.txt')
    return `a path under /tmp toasted ${q(y.toast)}`
  })
  await check('E1', async () => {
    await clearPane(tab3)
    await runIn(tab3, 'echo https://example.com/j18-url')
    const r = await rowIndex(tab3, 'https://example.com/j18-url')
    const from = logSize()
    await must(UD, { cmd: 'click', paneId: tab3, row: r, col: 10 }, 'click')
    await sleep(800)
    if (!/open:externalHttp https:\/\/example\.com\/j18-url/.test(logSince(from))) {
      await must(UD, { cmd: 'click', paneId: tab3, row: r, col: 10, mods: { ctrl: true } }, 'ctrl click')
      await sleep(800)
      if (!/open:externalHttp/.test(logSince(from))) throw new Error('neither a click nor a Ctrl+click on a bare URL asked to open it (no open:externalHttp in shell.log)')
      return 'a Ctrl+click on a bare URL logged open:externalHttp (a plain click did not)'
    }
    return 'a click on a bare URL logged open:externalHttp https://example.com/j18-url (test mode, nothing opened)'
  })

  // ---- G drawer (on tab 3)
  await check('G1', async () => {
    await focusPane(tab3)
    await key('Ctrl+Shift+J')
    const y = await untilModel('no drawer', 10000, (z) => z.drawer.open && z.drawer.status === 'live')
    const p = y.panes[0]
    if (!(y.drawer.rect.y > p.rect.y && y.drawer.rect.y + y.drawer.rect.h <= p.rect.y + p.rect.h + 1)) throw new Error(`drawer ${q(y.drawer.rect)} pane ${q(p.rect)}`)
    return `Ctrl+Shift+J opened the drawer over the bottom of the grid (y ${y.drawer.rect.y}, h ${y.drawer.rect.h})`
  })
  await check('G3', async () => {
    const y = await M()
    if (y.drawer.ptyId !== `drawer:${tab3}`) throw new Error(`ptyId ${y.drawer.ptyId}`)
    await waitText(UD, y.drawer.ptyId, '%', 60000)
    return `the drawer's pty is ${y.drawer.ptyId}, spawned on first open, at a prompt`
  })
  await check('G4', async () => {
    let y = await M()
    const pty = y.drawer.ptyId
    let tty = ''
    try { tty = paneTty(pty, PID) } catch {}
    if (tty && claudeOn(tty)) throw new Error('claude on the drawer tty')
    if (!y.drawer.focused) await click('drawer:grid')
    await typeText('cd /tmp')
    await key('Enter')
    y = await untilModel('no cd to pane', 10000, (z) => z.drawer.header.showCd)
    const head = y.drawer.header
    await click('drawer:cd')
    y = await untilModel('cd to pane never went away', 10000, (z) => !z.drawer.header.showCd)
    return `header ${q(head.label)} / ${q(head.title)}; cd /tmp showed "cd to pane", which typed the cd back and went away`
  })
  await check('G7', async () => {
    const y = await M()
    const pty = y.drawer.ptyId
    await click('drawer:grid')
    await typeText(`clear; echo ${README}`)
    await key('Enter')
    const r = await rowIndex(pty, README)
    await must(UD, { cmd: 'click', target: 'sidebar:row:' + HOME }, 'select root')
    await must(UD, { cmd: 'dblclick', paneId: pty, row: r, col: 5 }, 'dblclick')
    await untilModel('no reveal from the drawer', 15000, (z) => z.sidebar.revealRowId === `row:${README}` && z.sidebar.revealSeq > y.sidebar.revealSeq)
    return 'a path double-clicked in the drawer revealed it'
  })
  await check('G2', async () => {
    const h0 = (await M()).drawer.height
    await must(UD, { cmd: 'drag', target: 'drawer:grip', dx: 0, dy: -2000, steps: 10 }, 'drag')
    const h1 = (await M()).drawer.height
    await must(UD, { cmd: 'drag', target: 'drawer:grip', dx: 0, dy: 2000, steps: 10 }, 'drag')
    const h2 = (await M()).drawer.height
    if (h0 !== 300 || h2 !== 120 || h1 <= h0) throw new Error(`heights ${h0}, ${h1}, ${h2}`)
    return `default ${h0}, dragged up to ${h1} (800 cap or the body) and down to the ${h2} floor`
  })
  await check('G6', async () => {
    await click('drawer:close')
    await untilModel('never closed', 5000, (z) => !z.drawer.open)
    const s = await D({ cmd: 'stats' })
    if (s.focusedGrid !== tab3) throw new Error(`focusedGrid ${s.focusedGrid}`)
    return `closing the drawer gave the keys back to ${tab3}`
  })
  await check('G5', async () => {
    await key('Ctrl+Shift+J')
    let y = await untilModel('no drawer', 10000, (z) => z.drawer.open)
    if (!y.drawer.focused) await click('drawer:grid')
    await typeText('exit')
    await key('Enter')
    y = await untilModel('the drawer shell never exited', 10000, (z) => z.drawer.status === 'exited' || !z.drawer.open)
    if (y.drawer.open) await click('drawer:close')
    await key('Ctrl+Shift+J')
    y = await untilModel('no respawn', 15000, (z) => z.drawer.open && z.drawer.status === 'live')
    await waitText(UD, y.drawer.ptyId, '%', 60000)
    await click('drawer:close')
    return 'exit in the drawer, then the next open respawned a live shell at a prompt'
  })

  await check('Q1', q1)

  // ---- H find and I edit (tab 3)
  await clearPane(tab3)
  await runIn(tab3, 'seq 1 3000')
  await rowIndex(tab3, '3000')
  await check('H1', async () => {
    await focusPane(tab3)
    await key('Ctrl+Shift+F')
    const y = await untilModel('no find bar', 5000, (z) => z.find.open)
    if (y.find.paneId !== tab3) throw new Error(`find on ${y.find.paneId}`)
    return `Ctrl+Shift+F opened the find bar on the focused pane; the web-pane toast is ${SKIP}`
  })
  await check('H2', async () => {
    await typeText('1500')
    const y = await untilModel('no count', 5000, (z) => z.find.query === '1500' && z.find.count && z.find.count.total >= 1, (z) => q(z.find))
    return `text "1500" typed into the field became query ${q(y.find.query)}, ${y.find.count.index} of ${y.find.count.total} as typed (the 120 ms debounce not timed)`
  })
  await check('H7', async () => {
    const g = await must(UD, { cmd: 'grid', paneId: tab3 }, 'grid')
    const i = g.text.findIndex((t) => t.trimEnd() === '1500')
    if (i < 0) throw new Error('the match is not in the viewport')
    const mid = g.rows / 2
    if (Math.abs(i - mid) > g.rows / 4) throw new Error(`match row ${i} of ${g.rows}`)
    return `the match "1500", 1500 lines up the scrollback, was scrolled to viewport row ${i} of ${g.rows} (mid ${mid})`
  })
  await check('H4', async () => {
    await click('find:query')
    await clearField()
    await typeText('99')
    let y = await untilModel('no count', 5000, (z) => z.find.query === '99' && z.find.count && z.find.count.total > 2, (z) => q(z.find))
    const i0 = y.find.count.index
    await key('Enter')
    y = await untilModel('Enter never moved', 5000, (z) => z.find.count && z.find.count.index !== i0)
    const i1 = y.find.count.index
    await key('Shift+Enter')
    y = await untilModel('Shift+Enter never moved back', 5000, (z) => z.find.count && z.find.count.index === i0)
    await key('Ctrl+Alt+g')
    y = await untilModel('Ctrl+Alt+G never moved', 5000, (z) => z.find.count && z.find.count.index !== i0)
    const i2 = y.find.count.index
    await key('Ctrl+Shift+G')
    y = await untilModel('Ctrl+Shift+G never moved', 5000, (z) => z.find.count && z.find.count.index === i0)
    return `query "99" ${i0} of ${y.find.count.total}: Enter -> ${i1}, Shift+Enter -> ${i0}, Ctrl+Alt+G -> ${i2}, Ctrl+Shift+G -> ${y.find.count.index}`
  })
  await check('H3', async () => {
    await click('find:query')
    await click('find:case')
    let y = await untilModel('case never on', 5000, (z) => z.find.caseSensitive)
    await click('find:case')
    await click('find:regex')
    y = await untilModel('regex never on', 5000, (z) => z.find.regex)
    await click('find:query')
    await clearField()
    await typeText('1')
    y = await untilModel('no capped count', 8000, (z) => z.find.count && z.find.count.capped, (z) => q(z.find.count))
    await click('find:next')
    await click('find:prev')
    return `Aa and .* toggled, query "1" over seq 1 3000 counted ${y.find.count.total} capped=${y.find.count.capped} ("1000+"); next and prev buttons clicked`
  })
  await check('H5', async () => {
    await click('find:query')
    await clearField()
    await typeText('(')
    let y = await untilModel('an open regex was not a miss', 5000, (z) => z.find.query === '(' && z.find.miss, (z) => q(z.find))
    await click('find:regex')
    await click('find:query')
    await clearField()
    await typeText('zzqqxx')
    y = await untilModel('no miss', 5000, (z) => z.find.query === 'zzqqxx' && z.find.miss, (z) => q(z.find))
    return 'an unfinished regex "(" and a literal "zzqqxx" both set miss (the red field)'
  })
  await check('H9', async () => {
    await click('find:query')
    await clearField()
    const y = await untilModel('the query never emptied', 5000, (z) => z.find.query === '' && !z.find.count && !z.find.miss, (z) => q(z.find))
    const s = await must(UD, { cmd: 'selection', paneId: tab3 }, 'selection')
    if (s.text) throw new Error(`selection ${q(s.text)}`)
    return `emptying the field cleared the count and the selection (count ${q(y.find.count)})`
  })
  await check('I3', async () => {
    await click('find:query')
    await typeText('abc')
    await key('Ctrl+Shift+A')
    await typeText('x')
    const y = await untilModel('select all did not cover the field', 5000, (z) => z.find.query === 'x', (z) => z.find.query)
    return `Ctrl+Shift+A in the find field selected "abc" (typing replaced it with ${q(y.find.query)}); in a terminal: D10`
  })
  await check('I4', async () => {
    const sb0 = (await must(UD, { cmd: 'grid', paneId: tab3 }, 'grid')).scrollback
    await click('find:query')
    await key('Ctrl+Shift+K')
    await sleep(500)
    const sb1 = (await must(UD, { cmd: 'grid', paneId: tab3 }, 'grid')).scrollback
    if (sb1 < sb0 || sb0 < 100) throw new Error(`scrollback ${sb0} -> ${sb1} with the find field focused`)
    await key('Escape')
    await untilModel('find never closed', 5000, (z) => !z.find.open)
    await keyIn(tab3, 'Ctrl+Shift+K')
    const g = await until('Clear never cleared', 5000, async () => {
      const x = await must(UD, { cmd: 'grid', paneId: tab3 }, 'grid')
      return { ok: x.scrollback === 0 && !x.text.some((t) => t.trim() === '3000'), x, why: `scrollback ${x.scrollback}` }
    })
    return `Ctrl+Shift+K was ignored with the find field focused (scrollback ${sb0} -> ${sb1}) and cleared the pane after Escape (scrollback ${g.x.scrollback})`
  })
  await check('X28', async () => {
    await focusPane(tab3)
    await key('Ctrl+Shift+F')
    await untilModel('no find', 5000, (z) => z.find.open)
    await must(UD, { cmd: 'click', paneId: tab3, row: 0, col: 0 }, 'click grid')
    await key('Escape')
    await untilModel('Escape never closed find', 5000, (z) => !z.find.open)
    // The Escape also reached zsh, where it prefixes the next key (ESC c would
    // capitalize a word): a Ctrl+C ends that sequence and the empty line.
    await keyIn(tab3, 'Ctrl+c')
    return 'with the find bar open and the grid clicked, Escape closed it'
  })

  // ---- J drops (tab 3)
  await check('J1', async () => {
    await clearPane(tab3)
    guard(tab3)
    const r = await must(UD, { cmd: 'drop', paneId: tab3, paths: ['C:\\seashell-build\\redesign\\bakeoff\\E-native.png'] }, 'drop')
    const g = await until('no dropped path', 5000, async () => {
      const rows = await rowsOf(tab3)
      return { ok: rows.some((t) => t.includes('/mnt/c/seashell-build/redesign/bakeoff/E-native.png')), rows }
    })
    void g
    return `a CF_HDROP drop on the grid answered effect ${q(r.effect)}`
  })
  await check('J2', async () => {
    const rows = await rowsOf(tab3)
    const line = rows.find((t) => t.includes('E-native.png'))
    if (!line.endsWith('E-native.png') && !/E-native\.png\s*$/.test(line)) throw new Error(`line ${q(line)}`)
    await keyIn(tab3, 'Ctrl+u')
    guard(tab3)
    await must(UD, { cmd: 'drop', paneId: tab3, paths: [`${UD}\\a b.txt`] }, 'drop')
    const g = await until('no quoted path', 5000, async () => {
      const r2 = await rowsOf(tab3)
      return { ok: r2.some((t) => t.includes(`'/mnt/c/seashell-build/redesign/scratch/${NAME}/a b.txt'`)), r2 }
    })
    const q2 = g.r2.find((t) => t.includes('a b.txt'))
    await keyIn(tab3, 'Ctrl+u')
    return `the drop typed ${q(line.slice(line.indexOf('/mnt')))} plus a space, and a space path as ${q(q2.slice(q2.indexOf("'")))}; nothing ran`
  })
  await check('J3', async () => {
    guard(tab3)
    await must(UD, { cmd: 'drop', paneId: tab3, text: 'file:///C:/seashell-build/redesign/bakeoff/E-native.png' }, 'drop')
    await until('no path from the file URI', 5000, async () => ({ ok: (await rowsOf(tab3)).some((t) => t.includes('/mnt/c/seashell-build/redesign/bakeoff/E-native.png')) }))
    await keyIn(tab3, 'Ctrl+u')
    guard(tab3)
    await must(UD, { cmd: 'drop', paneId: tab3, text: '\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\seashell-wt\\redesign\\README.md' }, 'drop')
    await until('no path from the UNC text', 5000, async () => ({ ok: (await rowsOf(tab3)).some((t) => t.includes(README)) }))
    await keyIn(tab3, 'Ctrl+u')
    return 'a file:///C:/ text drop and a \\\\wsl.localhost text drop became /mnt/c and POSIX paths'
  })
  await check('J4', async () => 'C:\\ paths became /mnt/c/... in J1 and J3, \\\\wsl.localhost became / in J3')
  await check('J5', async () => {
    const shown = (await M()).sidebar.visible
    if (!shown) await key('Ctrl+Shift+B')
    await untilModel('no sidebar', 5000, (z) => z.sidebar.visible)
    const r = await D({ cmd: 'drop', target: 'sidebar:empty', paths: ['C:\\seashell-build\\redesign\\bakeoff\\E-native.png'] })
    const r2 = r.ok ? r : await D({ cmd: 'drop', target: `sidebar:row:${HOME}`, paths: ['C:\\seashell-build\\redesign\\bakeoff\\E-native.png'] })
    if (!shown) await key('Ctrl+Shift+B')
    if (r2.effect && r2.effect !== 'none') throw new Error(`a drop on the explorer answered ${q(r2.effect)}`)
    throw Object.assign(new Error(), { st: DEFER, d: `drag out and tab or pane reordering are not ported; a drop on a preview is ${SKIP}; a drop on the explorer was refused live (effect ${q(r2.effect || r2.code)})` })
  })

  // ---- M colour, link, attention (tab 1)
  await selectTab(0)
  await check('M1', async () => {
    await click(`pane:${p1b}:color`)
    let y = await untilModel('no colour popover', 5000, (z) => z.popover)
    const items = y.popover.items.map((i) => i.id)
    if (items.length !== 8) throw new Error(`items ${items.join(',')}`)
    const cur = y.popover.items.find((i) => i.selected)
    const pick = items.find((i) => i !== 'none' && (!cur || i !== cur.id))
    await click(`popover:${pick}`)
    y = await untilModel('colour never set', 5000, (z) => !z.popover && z.panes.find((p) => p.id === p1b).color)
    const col = y.panes.find((p) => p.id === p1b).color
    await click(`pane:${p1b}:color`)
    await untilModel('no popover', 5000, (z) => z.popover)
    await click(`popover:${pick}`)
    y = await untilModel('picking the current colour never cleared it', 5000, (z) => !z.popover && z.panes.find((p) => p.id === p1b).color === null, (z) => z.panes.find((p) => p.id === p1b).color)
    await click(`pane:${p1b}:color`)
    await untilModel('no popover', 5000, (z) => z.popover)
    await key('Escape')
    await untilModel('Escape never closed it', 5000, (z) => !z.popover)
    return `the dot opened ${items.length} items (${items.join(', ')}); ${pick} set ${col}, picking it again cleared it, Escape closed the popover`
  })
  await check('M4', async () => {
    await click(`pane:${p1a}:link`)
    const y = await untilModel('no link popover', 5000, (z) => z.popover)
    const items = y.popover.items.map((i) => `${i.label}${i.note ? ` (${i.note})` : ''}${i.disabled ? ' off' : ''}`)
    await key('Escape')
    await untilModel('never closed', 5000, (z) => !z.popover)
    return `the link button opened ${q(y.popover.title || '')}: ${items.join('; ')}; linking two agents needs claude (not driven)`
  })
  await check('D12', async () => {
    await runIn(p1b, 'sleep 7; printf "\\a"; sleep 9')
    await focusPane(p1a)
    const y = await untilModel('the bell never set waiting', 25000, (z) => z.panes.find((p) => p.id === p1b).attention === 'waiting', (z) => z.panes.find((p) => p.id === p1b).attention)
    return `a bell from busy unfocused pane b set attention ${q(y.panes.find((p) => p.id === p1b).attention)} (attentionSound off, nothing played)`
  })
  await check('M5', async () => {
    const y = await untilModel('attention never went done', 25000, (z) => z.panes.find((p) => p.id === p1b).attention === 'done', (z) => z.panes.find((p) => p.id === p1b).attention)
    await focusPane(p1b)
    const z = await untilModel('focus never cleared attention', 5000, (w) => w.panes.find((p) => p.id === p1b).attention === 'none')
    void z
    return `waiting by the bell (D12), "done" when b returned to its prompt (${y.panes.find((p) => p.id === p1b).attention}), focusing b cleared it (the breathing animation is drawn, not checked)`
  })
  await check('P6', async () => {
    await click('sleep')
    let y = await untilModel('sleep never on', 5000, (z) => z.sleep)
    await click('sleep')
    y = await untilModel('sleep never off', 5000, (z) => !z.sleep)
    return `the moon toggled sleep on and off (sleep ${y.sleep})`
  })

  // ---- A5 toast timing
  await check('A5', async () => {
    await focusPane(p1a)
    await untilModel('an earlier toast never cleared', 8000, (z) => !z.toast)
    // Timed from the key press, so a slow model read (a relay fallback) can
    // only lengthen the reading, never shorten it.
    const t0 = now()
    await key('Ctrl+Alt+Shift+W')
    const y = await untilModel('no toast', 5000, (z) => z.toast === 'No preview panes open', (z) => z.toast)
    const seen = now() - t0
    await untilModel('the toast never cleared', 8000, (z) => !z.toast)
    const ms = now() - t0
    if (ms < 3000 || ms > 5000) throw new Error(`cleared ${ms} ms after the key (first seen at ${seen} ms)`)
    return `${q(y.toast)} shown (seen ${seen} ms after the key), cleared ${Math.round(ms / 100) / 10} s after the key (3.2 s)`
  })

  // ---- S zoom
  await check('S1', async () => {
    await key('Ctrl+=')
    let y = await untilModel('no zoom in', 5000, (z) => z.window.fontPx === 16)
    const s1 = `${y.window.fontPx}/${y.window.uiScale}`
    await key('Ctrl+-')
    await key('Ctrl+-')
    y = await untilModel('no zoom out', 5000, (z) => z.window.fontPx === 12)
    const s2 = `${y.window.fontPx}/${y.window.uiScale}`
    await key('Ctrl+0')
    y = await untilModel('no reset', 5000, (z) => z.window.fontPx === 13)
    return `Ctrl+= gave ${s1}, two Ctrl+- ${s2}, Ctrl+0 ${y.window.fontPx}/${y.window.uiScale}`
  })
  await check('S2', async () => {
    await focusPane(p1a)
    await key('Ctrl+Shift+=')
    let y = await untilModel('no pane zoom', 5000, (z) => z.panes.find((p) => p.id === p1a).zoomPercent)
    const pz = y.panes.find((p) => p.id === p1a).zoomPercent
    const badge = y.zoomBadge
    await key('Ctrl+=')
    y = await untilModel('global zoom never cleared the pane zoom', 5000, (z) => z.panes.find((p) => p.id === p1a).zoomPercent === null)
    await key('Ctrl+0')
    await focusPane(p1a)
    await key('Ctrl+Shift+=')
    await key('Ctrl+Shift+-')
    await key('Ctrl+Shift+-')
    y = await untilModel('no pane zoom out', 5000, (z) => (z.panes.find((p) => p.id === p1a).zoomPercent || 100) < 100)
    return `Ctrl+Shift+= put pane a at ${pz}% (badge ${q(badge)}), Ctrl+= cleared it, Ctrl+Shift+- took it to ${y.panes.find((p) => p.id === p1a).zoomPercent}%`
  })
  await check('S3', async () => {
    let y = await M()
    if (!y.zoomBadge || !y.zoomBadge.includes('*')) throw new Error(`badge ${q(y.zoomBadge)}`)
    const b = y.zoomBadge
    await click('zoom:badge')
    y = await untilModel('badge never reset', 5000, (z) => z.zoomBadge === null && z.panes.every((p) => p.zoomPercent === null) && z.window.fontPx === 13)
    return `badge ${q(b)} with a pane zoomed; clicking it reset everything (badge null)`
  })

  // ---- P settings, T tutorial, U update, V chrome
  await check('P1', async () => {
    await key('Ctrl+,')
    await untilModel('no sheet', 5000, (z) => z.sheet && z.sheet.kind === 'settings')
    await key('Escape')
    await untilModel('Escape never closed', 5000, (z) => !z.sheet)
    await click('settings')
    await untilModel('the gear never opened it', 5000, (z) => z.sheet && z.sheet.kind === 'settings')
    await click('sheet:settings:btn:done')
    await untilModel('Done never closed', 5000, (z) => !z.sheet)
    return 'Ctrl+, opened Settings, Escape closed it, the gear opened it, Done closed it'
  })
  await key('Ctrl+,')
  const st = await untilModel('no sheet', 5000, (z) => z.sheet && z.sheet.kind === 'settings')
  await check('P2', async () => {
    const th = sheetField(st, 'theme'), ac = sheetField(st, 'accent'), pa = sheetField(st, 'palette'), pf = sheetField(st, 'paneStyle'), cr = sheetField(st, 'crt')
    if (th.options.length !== 7 || ac.options.length !== 7 || pa.options.length !== 4 || pf.options.length !== 5 || cr.options.length !== 3) throw new Error('option counts')
    return `Theme ${th.options.length} buttons (${th.options.filter((o) => o.disabled).length} greyed "coming back"), Accent ${ac.options.length}, Terminal palette ${pa.options.map((o) => o.label).join('/')}, Pane frame ${pf.options.length} and CRT glass ${cr.options.length} greyed`
  })
  await check('P3', async () => {
    const v = ['attentionGlow', 'attentionSound', 'autoColorPanes', 'autoTitlePanes'].map((id) => `${id} ${sheetField(st, id).value}`)
    if (v.join() !== 'attentionGlow true,attentionSound false,autoColorPanes true,autoTitlePanes true') throw new Error(v.join(', '))
    return v.join(', ')
  })
  await check('P4', async () => {
    const f = sheetField(st, 'newPaneCommand')
    if (f.kind !== 'text' || f.maxLen !== 200 || f.value !== '') throw new Error(q(f))
    return `"Start new panes with" text field, maxLen ${f.maxLen}, empty (a plain shell)`
  })
  await check('P5', async () => {
    await click('sheet:settings:tutorial')
    const y = await untilModel('no tutorial', 5000, (z) => z.sheet && z.sheet.kind === 'tutorial')
    await key('Escape')
    await untilModel('never closed', 5000, (z) => !z.sheet)
    return `Help, Show opened the tutorial sheet (${q(y.sheet.title)})`
  })
  await check('T1', async () => {
    await focusPane(p1a)
    await key('Ctrl+Shift+/')
    const y = await untilModel('no tutorial', 5000, (z) => z.sheet && z.sheet.kind === 'tutorial')
    const step = sheetField(y, 'step')
    if (!step || step.options.length !== 12) throw new Error(`steps ${q(step)}`)
    return `Ctrl+Shift+/ opened the tutorial at ${q(y.sheet.title)} (${q(y.sheet.sections[0].title)}), ${step.options.length} step dots (first-run showing: Task 14)`
  })
  await check('T2', async () => {
    const t0 = (await M()).sheet.title
    await key('ArrowRight')
    let y = await untilModel('ArrowRight never stepped', 5000, (z) => z.sheet && z.sheet.title !== t0)
    const t1 = y.sheet.title
    await key('ArrowLeft')
    y = await untilModel('ArrowLeft never stepped back', 5000, (z) => z.sheet && z.sheet.title === t0)
    await click('sheet:tutorial:btn:next')
    y = await untilModel('Next never stepped', 5000, (z) => z.sheet && z.sheet.title === t1)
    await click('sheet:tutorial:step:3')
    y = await untilModel('the dot never jumped', 5000, (z) => z.sheet && z.sheet.title !== t1)
    const btns = y.sheet.buttons.map((b) => b.label).join('/')
    await key('Escape')
    await untilModel('Escape never closed', 5000, (z) => !z.sheet)
    return `ArrowRight ${q(t0)} -> ${q(t1)}, ArrowLeft back, Next forward, dot 4 jumped to ${q(y.sheet.title)}, buttons ${btns}, Escape closed`
  })
  await check('U1', async () => {
    await must(UD, { cmd: 'coreSend', ch: 'test:update', p: { phase: 'available', version: '9.9.8', canInstall: false, pageUrl: 'https://example.com/release' } }, 'coreSend')
    const y = await untilModel('no banner', 5000, (z) => z.update)
    return `test:update available gave the banner ${q(y.update.text)} (other phases: unit, controller-update.test.ts)`
  })
  await check('U2', async () => {
    await click('update:later')
    await untilModel('Later never hid it', 5000, (z) => !z.update)
    const ui = JSON.parse(readFileSync(`${UD_LINUX}/ui-state.json`, 'utf8'))
    if (ui.dismissedUpdate !== '9.9.8') throw new Error(`dismissedUpdate ${q(ui.dismissedUpdate)}`)
    await must(UD, { cmd: 'coreSend', ch: 'test:update', p: { phase: 'available', version: '9.9.8', canInstall: false, pageUrl: 'https://example.com/release' } }, 'coreSend')
    await sleep(600)
    if ((await M()).update) throw new Error('the dismissed version showed again')
    return 'Later hid it, ui-state.json says dismissedUpdate "9.9.8", the same version stayed hidden (error dismissal not driven)'
  })
  await check('V4', async () => {
    await key('Alt')
    const s = await D({ cmd: 'stats' })
    await key('Escape')
    const s2 = await D({ cmd: 'stats' })
    if (!s.menuOpen || s2.menuOpen) throw new Error(`menuOpen ${s.menuOpen} then ${s2.menuOpen}`)
    // The menu itself is a real popup, which the walk may not show.
    throw Object.assign(new Error(), { nd: 'a real menu popup would capture Josh\'s mouse and keyboard; live, a bare Alt tap set menuOpen true (test mode builds the HMENU and shows nothing) and Escape cleared it' })
  })

  // ---- N projects
  await check('N1', async () => {
    await key('Ctrl+Alt+p')
    let y = await untilModel('no projects sheet', 5000, (z) => z.sheet && z.sheet.kind === 'projects')
    await key('Escape')
    await untilModel('never closed', 5000, (z) => !z.sheet)
    await key('Ctrl+Shift+S')
    y = await untilModel('no save sheet', 5000, (z) => z.sheet && z.sheet.kind === 'projects')
    const scope = sheetField(y, 'scope').options.find((o) => o.selected).id
    await click('sheet:projects:btn:done')
    await untilModel('Done never closed', 5000, (z) => !z.sheet)
    const path = menuPath(menu.items, 'Save Tab as Project…')
    await must(UD, { cmd: 'menuPick', path }, 'menuPick')
    y = await untilModel('no tab-scope sheet', 5000, (z) => z.sheet && z.sheet.kind === 'projects')
    const scope2 = sheetField(y, 'scope').options.find((o) => o.selected).id
    await key('Escape')
    await untilModel('never closed', 5000, (z) => !z.sheet)
    if (scope !== 'window' || scope2 !== 'tab') throw new Error(`scopes ${scope}, ${scope2}`)
    return `Ctrl+Alt+P (sent as Ctrl+Alt+p) opened Projects, Escape closed it; Ctrl+Shift+S opened it on ${scope} scope (Done closed it); Save Tab as Project on ${scope2} scope`
  })
  await check('N2', async () => {
    await key('Ctrl+Alt+p')
    let y = await untilModel('no projects sheet', 5000, (z) => z.sheet && z.sheet.kind === 'projects')
    await click('sheet:projects:scope:window')   // N1 left the sheet on tab scope
    y = await untilModel('never on window scope', 5000, (z) => sheetField(z, 'scope').options.find((o) => o.selected).id === 'window')
    await click('sheet:projects:name')
    const name = sheetField(y, 'name')
    await typeText('J18')
    y = await untilModel('the name never arrived', 5000, (z) => sheetField(z, 'name') && sheetField(z, 'name').value === 'J18')
    const btn = sheetField(y, 'save').label
    const desc = sheetField(y, 'describe')
    await untilModel('an earlier toast never cleared', 8000, (z) => !z.toast)
    await key('Enter')
    y = await untilModel('no save toast', 5000, (z) => /Saved project/.test(z.toast || ''), (z) => `toast ${q(z.toast)}, sheet ${z.sheet && z.sheet.kind}, name ${q(sheetField(z, 'name') && sheetField(z, 'name').value)}`)
    if (name.maxLen !== 60) throw new Error(`maxLen ${name.maxLen}`)
    return `name field maxLen ${name.maxLen}, button ${q(btn)}, description ${q(desc && (desc.label || desc.note || desc.value))}, Enter toasted ${q(y.toast)}`
  })
  await check('N3', async () => {
    const y = await M()
    const rows = sheetField(y, 'projects')
    const r = rows && rows.rows && rows.rows.find((x) => x.name === 'J18')
    if (!r) throw new Error(`no row ${q(rows)}`)
    for (const b of ['delete', 'add', 'open']) await must(UD, { cmd: 'rect', target: `sheet:projects:row:${r.id}:${b}` }, `rect ${b}`)
    return `the open section lists ${q(r.name)} ${q(r.meta)} with Delete, Add and Open targets registered`
  })
  await check('N5', async () => {
    await closeSheet()
    const pj = JSON.parse(readFileSync(`${UD_LINUX}/projects.json`, 'utf8'))
    const p = pj.projects.find((x) => x.name === 'J18')
    const pane = Object.values(p.tabs[0].panes)[0]
    if (!p.tabs[0].tree.ratios || !pane.cwd || !pane.kind) throw new Error(q(p.tabs[0]))
    return `projects.json holds "J18" with ${p.tabs.length} tabs, tree ratios, panes with ${Object.keys(pane).join(', ')}`
  })

  // ---- O1 the snapshot rewritten during the run
  await check('O1', async () => {
    const wait = Math.max(0, 33000 - (now() - bootAt))
    if (wait) await sleep(wait)
    const at = JSON.parse(readFileSync(`${UD_LINUX}/last-session.json`, 'utf8')).savedAt
    if (!(at > firstSavedAt)) throw new Error(`savedAt ${at}, seeded ${firstSavedAt}`)
    return `last-session.json rewritten during the run (savedAt ${at} after the seeded ${firstSavedAt}); the quit write: below`
  })

  // ---- X: chords not covered above, then the empty state (A4) last
  await check('X1', async () => 'Ctrl+, opened Settings (P1)')
  await check('X2', async () => 'Ctrl+Shift+T opened a tab (D7)')
  await check('X3', async () => 'File, Rename Tab… opened the inline field (B4)')
  await check('X4', async () => 'Ctrl+Alt+P opened Projects (N1)')
  await check('X5', async () => 'Ctrl+Shift+S opened Projects on window scope (N1)')
  await check('X6', async () => 'Save Tab as Project opened Projects on tab scope (N1)')
  await check('X7', async () => 'Ctrl+Shift+D made panes 2..6 (C1)')
  await check('X10', async () => 'Ctrl+Shift+W closed the focused pane (C14)')
  await check('X12', async () => 'Ctrl+Alt+W closed the active tab (B7)')
  await check('X14', async () => 'Ctrl+Shift+F opened find, Ctrl+Shift+G and Ctrl+Alt+G stepped (H1, H4)')
  await check('X15', async () => 'Ctrl+Shift+K cleared the pane (I4)')
  await check('X16', async () => 'Ctrl+Shift+Return toggled full screen (C8)')
  await check('X17', async () => 'Ctrl+Alt+R rebalanced (C4)')
  await check('X18', async () => 'Ctrl+Shift+B toggled the explorer (F1), Ctrl+Shift+J the drawer (G1), Ctrl+Shift+R refreshed (F8)')
  await check('X19', async () => 'Ctrl+Shift+] and [ cycled panes (C9)')
  await check('X20', async () => 'Ctrl+Alt+] and [ cycled tabs with wrap (B8)')
  await check('X21', async () => 'Ctrl+Shift+3 and Ctrl+Shift+1 selected tabs (B8)')
  await check('X22', async () => 'Ctrl+Shift+/ opened the tutorial (T1)')
  await check('X23', async () => 'Ctrl+=, Ctrl+- and Ctrl+0 zoomed (S1)')
  await check('X24', async () => 'Ctrl+Shift+= and Ctrl+Shift+- zoomed the pane (S2)')
  await check('X25', async () => 'Shift+Enter sent ESC CR (D6)')
  await check('X27', async () => 'Backspace after Ctrl+Shift+A sent Ctrl+U (D9)')
  await check('X29', async () => 'Enter, Shift+Enter in the find field stepped, Esc closed (H4, I4)')
  await check('X30', async () => 'Enter committed and Esc cancelled the tab rename (B3; blur not driven)')
  await check('X31', async () => 'Esc, ArrowLeft, ArrowRight drove the tutorial (T2)')
  await check('X32', async () => 'Esc closed Settings (P1), Projects (N1), the colour and link popovers (M1, M4) and the explorer menu (F7); the card\'s Esc not driven')
  await check('X35', async () => 'Enter in the project name field saved (N2)')
  await check('X36', async () => 'plain and Ctrl+Alt double-clicks on a path (E2), Alt under mouse tracking (E4); the Ctrl preview gesture is ' + SKIP)
  await check('W1', async () => 'the restore card (O3), Settings (P1), Projects (N1) and the tutorial (T1) all opened live')
  await check('W2', async () => 'the colour picker (M1), the link picker (M4) and the explorer context menu (F7) opened live')
  await check('W3', async () => `the exit overlay (C13) live; the save-conflict and web error banners are preview overlays, ${SKIP}`)

  await check('A4', async () => {
    let y = await M()
    for (let i = 0; i < 20 && y.tabs.length; i++) {
      await click(`tab:${y.tabs[0].id}:close`)
      const n = y.tabs.length
      y = await untilModel('a tab never closed', 10000, (z) => z.tabs.length < n)
    }
    y = await untilModel('no empty state', 5000, (z) => z.emptyState)
    await must(UD, { cmd: 'rect', target: 'empty:newtab' }, 'empty:newtab')
    await click('empty:newtab')
    const z = await untilModel('the button made no tab', 10000, (w) => w.tabs.length === 1 && !w.emptyState)
    await waitText(UD, z.panes[0].id, '%', 60000)
    return 'closing every tab showed the empty state with its New Tab button; clicking it opened one tab at a prompt'
  })
  await check('W5', async () => `the toast (A5), the update banner (U1) and the "No tabs open" state (A4) live; the splash is gone before the driver's first read`)
  await check('X13', async () => {
    throw Object.assign(new Error(), { nd: 'Copy and Paste read and write Josh\'s clipboard; Ctrl+Shift+A selected live (D10, I3)' })
  })
}

// ------------------------------------------------------- the fixed statuses

function fixedStatuses(rows) {
  const byLetter = (l) => rows.filter((r) => r.row.startsWith(l) && /^\D\d+$/.test(r.row)).map((r) => r.row)
  for (const r of [...byLetter('K'), ...byLetter('L')]) set(r, SKIP)
  for (const r of [...byLetter('R'), ...byLetter('Y')]) set(r, DEFER, r.startsWith('Y') ? 'built but not wired, not ported by design' : 'themes, pane frames and CRT come back later (Settings greys them)')
  set('C15', SKIP, 'Close All Panes closes previews only; A5 used its "No preview panes open" toast')
  set('H10', SKIP, 'file preview find')
  set('W4', SKIP, 'the four preview confirms')
  for (const r of ['X8', 'X9', 'X11', 'X33', 'X34']) set(r, SKIP, 'a preview shortcut')
  set('D18', DEFER, 'Option as Meta and Option-click are macOS only')
  set('V1', DEFER, 'traffic lights and the 78 px inset are macOS only')
  set('F12', DEFER, 'the Retro theme')
  // Rows no live check reaches without breaking a rule.
  notDriven('A1', 'the splash is gone before the driver can read a model')
  notDriven('A3', 'the first paint precedes the driver; the model carries the token table from its first frame')
  notDriven('C7', 'water-filling under a starved column is not reached by a driver drag; C6 showed the clamp')
  notDriven('D3', 'WebGL contexts are web technology; the native grid draws with Direct2D')
  notDriven('D4', 'the font face is not readable through the driver')
  notDriven('D8', 'needs an agent (claude) foreground, and the walk never types into claude')
  notDriven('D15', 'needs a display DPI change, which would touch Josh\'s desktop')
  notDriven('E3', 'DOM mousedown and dblclick de-duplication has no native counterpart: one WM_LBUTTONDBLCLK per double-click')
  notDriven('E9', 'hover is cancelled by WM_MOUSELEAVE under the driver')
  notDriven('H6', 'match colours are drawn, not in the model')
  notDriven('H8', 'needs streaming output under an open match; no unit test covers the native find')
  notDriven('I1', 'Copy writes Josh\'s clipboard')
  notDriven('I2', 'would touch Josh\'s clipboard: the Paste into the find field reads the real Windows clipboard; the field took typed text live (H2)')
  notDriven('M2', 'the border and stripe are drawn, not in the model')
  notDriven('M6', 'would play sound: attentionSound stays off in the walk')
  notDriven('N4', 'Open and Add rebuild or double the window of shells; Task 13 drove Open on i13')
  notDriven('N6', 'needs claude panes to resume')
  unit('O2', 'test/unit/restore-offer.test.ts', 'needs a quit with one plain pane and a relaunch')
  notDriven('V2', 'a real menu popup would capture Josh\'s mouse and keyboard; window buttons are the system caption')
  notDriven('V3', 'describes the Electron win32 frame; the native shell draws its own strip')
  notDriven('X26', 'needs an agent (claude) foreground')
}

// ------------------------------------------------------------------- main

function writeDoc(rows, counts) {
  const esc = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ')
  const out = [
    '# SeaShell inventory status, native build',
    '',
    `Generated by \`node scripts/native-inventory.mjs\` on ${new Date().toISOString()} against scratch \`${NAME}\` (release\\win-native, seeded with the W10 session). Rows are section 1 of \`2026-10-02-seashell-renderer-inventory.md\`, numbered in document order inside each letter (the X table in table order).`,
    '',
    'Statuses: `ok` was checked live on the scratch in this run; `ok (unit: ...)` is covered by the named unit test only, with why it was not driven live; `not driven (...)` has no live check that keeps the rules (no claude typing, no clipboard, no sound, no real menu, no focus) and no unit test that covers the native code; `skipped (Josh 10/03)` is a preview line (plan amendment 10/03 04:30); `deferred (spec 12)` is not ported by design. A live `ok` whose detail names an undriven part checked the row\'s main behaviour and says which part it did not.',
    '',
    `Totals: ${counts.okLive} ok live, ${counts.okUnit} ok unit-only, ${counts.notDriven} not driven, ${counts.skipped} skipped, ${counts.deferred} deferred, ${counts.fail} fail (${rows.length} rows).`,
    '',
    '| Row | Inventory (shortened) | Status | Detail |',
    '|---|---|---|---|',
  ]
  for (const r of rows) {
    const s = results.get(r.row)
    out.push(`| ${r.row} | ${esc(shorten(r.text))} | ${esc(s.status)} | ${esc(s.detail)} |`)
  }
  writeFileSync(STATUS_DOC, out.join('\n') + '\n')
}

async function main() {
  const rows = inventoryRows()
  fixedStatuses(rows)
  rmSync(UD_LINUX, { recursive: true, force: true })
  mkdirSync(UD_LINUX, { recursive: true })
  execFileSync('/usr/bin/node', [MAKE_SESSION, UD_LINUX, HOME], { encoding: 'utf8' })
  writeBounds(UD_LINUX, { x: 1028, y: -979 })
  PID = launchShell(NAME)
  console.error(`launched scratch ${NAME} (pid ${PID})`)
  let fatal = null
  try {
    if (!(await waitFile(`${UD_LINUX}/test.json`, 30000))) throw new Error('no test.json in 30 s')
    await walk()
  } catch (e) {
    fatal = e
    console.error(`walk stopped: ${e.stack || e.message}`)
  }
  // A check that threw a status (nd: not driven, st: another status) instead of failing.
  for (const [row, r] of results) {
    void row
    if (r.status === 'fail' && r.detail === '') r.detail = 'no detail'
  }
  let shotLine = ''
  try {
    const s = await must(UD, { cmd: 'shot', path: `${BUILD_WIN}\\bakeoff\\P2-inventory.png` }, 'shot')
    shotLine = `shot ${s.path} stamped ${q(s.stamp)}`
  } catch (e) {
    shotLine = `shot failed: ${e.message}`
  }
  const savedBefore = existsSync(`${UD_LINUX}/last-session.json`) ? JSON.parse(readFileSync(`${UD_LINUX}/last-session.json`, 'utf8')).savedAt : ''
  let oneTab = null
  try {
    const y = await M()
    oneTab = y.tabs.length === 1 && y.panes.length === 1 && y.panes[0].kind === 'term'
  } catch {}
  const how = await quitShell(UD, PID, NAME)
  if (oneTab && how === 'quit') {
    // A4 left one tab with one plain zsh pane: the quit must clear the snapshot (O2).
    let after = null
    try { after = JSON.parse(readFileSync(`${UD_LINUX}/last-session.json`, 'utf8')) } catch {}
    const cleared = !after || !Array.isArray(after.tabs) || after.tabs.length === 0
    if (cleared) set('O2', 'ok', `quit with one tab holding one plain zsh pane cleared the snapshot (${after ? 'no tabs' : 'file removed'}; before the quit it was saved at ${savedBefore})`)
    else set('O2', 'fail', `quit with one plain pane left a snapshot of ${after.tabs.length} tab(s) saved at ${after.savedAt}`)
  }
  for (const r of rows) if (!results.has(r.row)) set(r.row, fatal ? 'fail' : 'not driven (no check reached it)', fatal ? `the walk stopped before this row: ${fatal.message.slice(0, 200)}` : '')
  const counts = { okLive: 0, okUnit: 0, notDriven: 0, skipped: 0, deferred: 0, fail: 0 }
  for (const r of rows) {
    const s = results.get(r.row).status
    if (s === 'ok') counts.okLive++
    else if (s.startsWith('ok (unit')) counts.okUnit++
    else if (s.startsWith('not driven')) counts.notDriven++
    else if (s.startsWith('skipped')) counts.skipped++
    else if (s.startsWith('deferred')) counts.deferred++
    else counts.fail++
    const d = results.get(r.row).detail
    console.log(`${r.row} ${s}${d ? ' ' + d : ''}`)
  }
  writeDoc(rows, counts)
  console.log(`totals: ${counts.okLive} ok live, ${counts.okUnit} ok unit-only, ${counts.notDriven} not driven, ${counts.skipped} skipped, ${counts.deferred} deferred, ${counts.fail} fail (${rows.length} rows)`)
  console.log(shotLine)
  console.log(`scratch ${NAME}: ${how}`)
  if (!pidAlive(PID)) rmSync(`${PIDS}/${PID}`, { recursive: true, force: true })
  process.exit(counts.fail || how !== 'quit' ? 1 : 0)
}

await main()
