#!/usr/bin/env node
// Drive a SeaShell instance started with --remote-debugging-port=<port>.
//   node scripts/cdp.mjs 9333 "window.__seashellTerminals.size"
//   node scripts/cdp.mjs 9333 --dblclick 400 300 [modifiers]   (Alt=1 Ctrl=2 Meta=4 Shift=8)
//   node scripts/cdp.mjs 9333 --key Escape
//   node scripts/cdp.mjs 9333 --wheel 400 300 120 40 8
// Uses Node's built-in WebSocket (Node 22+). Prints the JSON value of the expression.
const [port, ...rest] = process.argv.slice(2)
if (!port) {
  console.error('usage: cdp.mjs <port> <expression> | --dblclick x y [modifiers] | --key Key | --wheel x y deltaY count gapMs')
  process.exit(2)
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && /index\.html|localhost/.test(t.url))
if (!page) {
  console.error('no page target; targets were', targets.map((t) => t.url))
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0
const pending = new Map()
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

if (rest[0] === '--dblclick') {
  const x = Number(rest[1]), y = Number(rest[2])
  // CDP modifier bitmask, held down for both presses: Alt=1, Ctrl=2, Meta=4, Shift=8.
  const modifiers = Number(rest[3] ?? 0)
  for (const clickCount of [1, 2]) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, modifiers })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, modifiers })
  }
  console.log('dblclick dispatched at', x, y, 'modifiers', modifiers)
} else if (rest[0] === '--key') {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: rest[1] })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: rest[1] })
  console.log('key', rest[1])
} else if (rest[0] === '--wheel') {
  const x = Number(rest[1]), y = Number(rest[2]), deltaY = Number(rest[3])
  const count = Number(rest[4]), gapMs = Number(rest[5])
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < count; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
    if (i < count - 1) await sleep(gapMs)
  }
  console.log('wheel dispatched', { x, y, deltaY, count, gapMs })
} else {
  const res = await send('Runtime.evaluate', {
    expression: rest.join(' '),
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.result?.exceptionDetails) console.error(JSON.stringify(res.result.exceptionDetails, null, 2))
  console.log(JSON.stringify(res.result?.result?.value ?? null))
}
ws.close()
