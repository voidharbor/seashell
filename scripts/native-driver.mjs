// Drives a scratch native shell through its loopback test driver (native/shell/src/driver.cpp).
// Usage: node scripts/native-driver.mjs <userDataWin> <cmd> [jsonArgs]
//   node scripts/native-driver.mjs C:\seashell-build\redesign\scratch\s3 model
//   node scripts/native-driver.mjs C:\seashell-build\redesign\scratch\s3 shot '{"path":"C:\\seashell-build\\redesign\\bakeoff\\N9-driver.png"}'
// Reads <userData>\test.json ({port, token}), sends one JSON line, prints the reply line.
// From WSL the Windows loopback is reachable directly under mirrored networking; when that
// connect fails the request is relayed through powershell.exe and System.Net.Sockets.TcpClient.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'

const [udArg, cmd, argsJson] = process.argv.slice(2)
if (!udArg || !cmd) {
  console.error('usage: node scripts/native-driver.mjs <userDataWin> <cmd> [jsonArgs]')
  process.exit(2)
}

// C:\a\b to /mnt/c/a/b on Linux; a Linux path is taken as is.
const toLocal = (p) => {
  if (process.platform !== 'linux') return p
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p
}

const { port, token } = JSON.parse(readFileSync(`${toLocal(udArg).replace(/\/$/, '')}/test.json`, 'utf8'))
const args = argsJson ? JSON.parse(argsJson) : {}
const line = JSON.stringify({ ...args, token, cmd })
// wait and waitText run up to their own timeoutMs on the shell's side.
const timeoutMs = (typeof args.timeoutMs === 'number' ? args.timeoutMs : 0) + 20000

const direct = () =>
  new Promise((resolve, reject) => {
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

// The request goes in as base64 so no quoting survives into PowerShell.
const relay = () => {
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

let reply
try {
  reply = await direct()
} catch (e) {
  // A request that reached the shell is not sent twice (quit, coreKill, key).
  if (e.connected || process.platform !== 'linux') {
    console.error(`native-driver: ${e.message}`)
    process.exit(1)
  }
  reply = relay()
}
console.log(reply)
const parsed = JSON.parse(reply)
process.exit(parsed && parsed.ok === false ? 1 : 0)
