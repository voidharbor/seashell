// Drives the Electron build end to end for the changes column: a pane runs a
// stand-in agent (a `sleep` whose argv[0] is `opencode`, which the agent
// registry takes for opencode), the pane is zoomed, files change through shell
// commands, and the column has to list them; a row's preview has to show the
// diff and the Markdown rendered. Everything happens in a throwaway HOME.
//
//   npm run build && node scripts/electron-changes-check.mjs [--shots <dir>]
//
// Needs Playwright (`playwright` or `playwright-core`, from here or NODE_PATH),
// node-pty built for this platform, and a display (on Linux, run it under
// xvfb-run). Exits non-zero when a step fails.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const repo = path.resolve('.')
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null
if (shots) fs.mkdirSync(shots, { recursive: true })

function playwright() {
  for (const base of ['', ...(process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)]) {
    for (const name of ['playwright', 'playwright-core']) {
      try {
        return require(base ? path.join(base, name) : name)
      } catch {
        /* next */
      }
    }
  }
  console.error('electron-changes-check: Playwright is not installed (npm i -D playwright-core, or set NODE_PATH)')
  process.exit(2)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-changes-home-'))
const proj = path.join(home, 'proj')
fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
fs.writeFileSync(path.join(proj, 'README.md'), '# Demo\n\nFirst line.\n')
fs.writeFileSync(path.join(proj, 'src/a.ts'), 'export const a = 1\nexport const b = 2\n')
fs.writeFileSync(path.join(proj, 'src/old.ts'), 'export const gone = true\n')

const { _electron } = playwright()
const electron = require('electron')
const app = await _electron.launch({
  executablePath: typeof electron === 'string' ? electron : path.join(repo, 'node_modules/electron/dist/electron'),
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), repo],
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
  cwd: proj,
})
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
let failed = false
try {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => log('page error:', String(e).slice(0, 300)))
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForTimeout(3000)
  await win.keyboard.press('Escape').catch(() => {})   // the first-run tutorial
  await win.waitForSelector('.xterm', { timeout: 30000 })
  const type = async (s) => {
    await win.click('.xterm')
    await win.keyboard.type(s, { delay: 5 })
    await win.keyboard.press('Enter')
    await win.waitForTimeout(400)
  }
  await type(`cd ${proj}`)
  await type('(exec -a opencode sleep 600) &')
  await win.waitForTimeout(800)
  await win.dblclick('.pane__title')
  await win.waitForSelector('.pane__changes', { timeout: 15000 })
  log('ok   the zoomed pane found its agent and shows the changes button')
  await win.waitForTimeout(2500)   // the baseline snapshot is taken now
  await type('printf "More text.\\n" >> README.md && printf "notes\\n" > notes.md && rm src/old.ts && sed -i.bak s/2/3/ src/a.ts && rm src/a.ts.bak')
  await win.waitForSelector('.changes__row', { timeout: 15000 })
  await win.waitForTimeout(2500)
  const rows = await win.$$eval('.changes__row .changes__name', (els) => els.map((e) => e.textContent))
  const want = ['notes.md', 'a.ts', 'README.md', 'old.ts']
  const listed = want.every((n) => rows.includes(n))
  log(listed ? 'ok  ' : 'FAIL', 'the column lists what the shell commands did:', rows.join(', '))
  failed ||= !listed
  if (shots) await win.screenshot({ path: path.join(shots, 'electron-column.png') })
  await win.click('.changes__row:has-text("README.md")')
  const frame = await (await win.waitForSelector('iframe.changes__preview', { timeout: 10000 })).contentFrame()
  await frame.waitForSelector('table.diff tr.add', { timeout: 15000 })
  log('ok   the preview shows the diff')
  if (shots) await win.screenshot({ path: path.join(shots, 'electron-preview.png') })
  await frame.click('button[data-mode="preview"]')
  const inner = await (await frame.waitForSelector('iframe.render')).contentFrame()
  await inner.waitForSelector('h1', { timeout: 10000 })
  log('ok   Preview renders the Markdown:', await inner.textContent('h1'))
  await frame.click('button[data-action="close"]')
  await win.waitForTimeout(500)
  const closed = (await win.$$('iframe.changes__preview')).length === 0
  log(closed ? 'ok  ' : 'FAIL', 'closing the preview drops its frame')
  failed ||= !closed
} catch (err) {
  console.error(err)
  failed = true
} finally {
  await app.close().catch(() => {})
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(failed ? 'electron-changes-check: failed' : 'electron-changes-check: all ok')
process.exit(failed ? 1 : 0)
