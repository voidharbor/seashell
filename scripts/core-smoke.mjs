// Starts the core the way the shell will, drives it over stdio, and checks the first model and the first prompt.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
const ud = process.argv[2] ?? '/tmp/seashell-core-smoke'
mkdirSync(ud, { recursive: true })
// wsl.exe sets SHELL to the login shell; the caller's own $SHELL may be something else.
const shell = userInfo().shell || process.env.SHELL
const core = spawn('/usr/bin/node', ['out/core/index.cjs'], { env: { ...process.env, SHELL: shell, SEASHELL_HOST: 'native-win', SEASHELL_HOST_PID: String(process.pid), SEASHELL_USER_DATA: ud }, stdio: ['pipe', 'pipe', 'inherit'] })
const send = (e) => core.stdin.write(JSON.stringify(e) + '\n')
let buf = '', model = null, prompt = false
core.stdout.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    const e = JSON.parse(line)
    if (e.ch === 'ui:model') model = e.p
    if (e.ch === 'pty:data') for (const b of e.p.batches) if (Buffer.from(b.data, 'base64').toString().includes('%')) prompt = true
  }
})
send({ k: 'send', ch: 'shell:geometry', p: { clientW: 1440, clientH: 900, dpi: 96, cellW: 7.8, cellH: 15 } })
const t0 = Date.now()
while (Date.now() - t0 < 15000 && !(model && prompt)) await new Promise((r) => setTimeout(r, 100))
console.log(JSON.stringify({ model: model ? { tabs: model.tabs.length, panes: model.panes.length, cols: model.panes[0]?.cols } : null, prompt }))
send({ k: 'send', ch: 'app:beforeQuit', p: {} })
setTimeout(() => core.kill(), 3000)
