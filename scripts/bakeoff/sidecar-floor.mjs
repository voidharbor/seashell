// Candidate C: node.exe + node-pty with ten wsl.exe zsh panes and nothing else.
// The cost of keeping src/main alive as a sidecar (spec section 3).
// Prints one JSON line with the pane pids at start, and one status line after
// about 30 s with how many panes printed visible text (a zsh prompt).
import pty from 'node-pty'

const n = Number(process.argv[2] ?? 10)
const statusAfterMs = Number(process.argv[3] ?? 30000)
const panes = []
const seen = new Array(n).fill(false)
const exited = new Array(n).fill(false)
let sample = ''

// What is left once escape sequences are gone: ConPTY prints mode and cursor
// sequences before the shell is up, so only visible text counts as a prompt.
function visible(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
}

for (let i = 0; i < n; i++) {
  const p = pty.spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--cd', '/Users/joshwald', '-e', 'zsh', '-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
  })
  p.onData((d) => {
    if (seen[i]) return
    const text = visible(d)
    if (text) {
      seen[i] = true
      if (!sample) sample = text.slice(-60)
    }
  })
  p.onExit(() => {
    exited[i] = true
  })
  panes.push(p)
}
console.log(JSON.stringify({ pid: process.pid, panes: panes.map((p) => p.pid) }))

setTimeout(() => {
  const live = seen.filter((s, i) => s && !exited[i]).length
  console.log(JSON.stringify({ status: 'panes', live, of: n, exited: exited.filter(Boolean).length, sample }))
}, statusAfterMs)

setInterval(() => {}, 1 << 30)
