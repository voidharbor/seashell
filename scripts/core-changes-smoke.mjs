// Drives the native core over stdio exactly as the shell does, with a pane
// running a stand-in agent (a `sleep` whose argv[0] is `opencode`), and checks
// the changes column end to end: the agent is found when the pane is zoomed,
// the files shell commands created, edited and deleted are listed in the
// model, a row's content goes out on view:cmd (never in ui:model), the page's
// ready and close messages work, and un-zooming drops the column.
//
//   npm run build:core && node scripts/core-changes-smoke.mjs
//
// Linux (or WSL) only: the agent registry reads /proc. Uses a throwaway HOME.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-core-home-'))
const ud = path.join(home, 'ud'); fs.mkdirSync(ud)
fs.writeFileSync(path.join(ud, 'ui-state.json'), JSON.stringify({ tutorialSeen: true }))
const proj = path.join(home, 'proj'); fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
fs.writeFileSync(path.join(proj, 'README.md'), '# Demo\n\nFirst line.\n')
fs.writeFileSync(path.join(proj, 'src/old.ts'), 'gone\n')
const core = spawn(process.execPath, ['out/core/index.cjs'], { env: { ...process.env, HOME: home, SHELL: '/bin/bash', SEASHELL_HOST: 'native-win', SEASHELL_HOST_PID: '1', SEASHELL_USER_DATA: ud }, stdio: ['pipe', 'pipe', 'pipe'] })
let err = ''
core.stderr.on('data', (d) => { err += d })
let failed = false
const send = (e) => core.stdin.write(JSON.stringify(e) + '\n')
let buf = '', model = null; const views = []
core.stdout.on('data', (d) => {
  buf += d; let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    const e = JSON.parse(line)
    if (e.ch === 'ui:model') model = e.p
    if (e.ch === 'view:cmd') views.push(e.p)
    if (e.k === 'invoke') send({ k: 'reply', ch: e.ch, id: e.id, p: { ok: true } })
  }
})
const until = async (f, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return; await new Promise((r) => setTimeout(r, 100)) } throw new Error('timeout: ' + what) }
const ev = (type, target) => send({ k: 'send', ch: 'ui:event', p: { type, target, x: 0, y: 0, button: 0, mods: { ctrl: false, alt: false, shift: false } } })
try {
  send({ k: 'send', ch: 'shell:geometry', p: { clientW: 1440, clientH: 900, dpi: 96, cellW: 7.8, cellH: 15 } })
  await until(() => model?.panes?.length === 1, 20000, 'first pane')
  const pane = model.panes[0].id
  await new Promise((r) => setTimeout(r, 1500))
  const type = (s) => send({ k: 'send', ch: 'pty:write', p: { paneId: pane, data: s + '\r' } })
  type(`cd ${proj}`); type('(exec -a opencode sleep 600) &')
  await new Promise((r) => setTimeout(r, 800))
  ev('dblclick', `pane:${pane}:title`)
  await until(() => model.panes[0].changes === 'off', 15000, 'agent detected')
  console.log('ok   agent detected, button', model.panes[0].changes)
  await new Promise((r) => setTimeout(r, 2500))
  type('printf "More.\\n" >> README.md && printf "n\\n" > notes.md && rm src/old.ts')
  await until(() => model.changes?.groups?.length === 3, 15000, 'changes listed')
  const c = model.changes
  console.log('ok   column', JSON.stringify({ x: c.rect.x, w: c.rect.w, pane: model.panes[0].rect.w, subtitle: c.subtitle, totals: c.totals, groups: c.groups.map((g) => [g.id, g.rows.map((r) => r.name)]) }))
  ev('click', `changes:row:${proj}/README.md`)
  await until(() => views.some((v) => v.message?.type === 'show'), 5000, 'view:cmd show')
  const show = views.find((v) => v.message.type === 'show').message
  console.log('ok   view:cmd show', JSON.stringify({ change: show.file.change, before: show.file.before, after: show.file.after, theme: Object.keys(show.theme).length }))
  console.log('ok   no file content in the model:', !JSON.stringify(model).includes('First line'))
  console.log('ok   preview rect', JSON.stringify(model.changes.preview))
  const n = views.length
  send({ k: 'send', ch: 'view:event', p: { type: 'message', message: { type: 'ready' } } })
  await until(() => views.length > n, 3000, 'show again on ready')
  console.log('ok   the page asking again gets the file again')
  send({ k: 'send', ch: 'view:event', p: { type: 'message', message: { type: 'action', action: 'close' } } })
  await until(() => model.changes?.preview === null, 3000, 'preview closed')
  console.log('ok   close from the page drops the preview')
  ev('dblclick', `pane:${pane}:title`)
  await until(() => model.changes === null, 3000, 'column gone with the zoom')
  console.log('ok   un-zoom drops the column')
} catch (e) {
  failed = true
  console.log('FAIL', e.message)
  console.log(err.slice(-2000))
}
send({ k: 'send', ch: 'app:beforeQuit', p: {} })
setTimeout(() => {
  core.kill()
  fs.rmSync(home, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}, 2000)
