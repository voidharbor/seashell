import { afterEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { startControlServer, type ControlServerDeps } from '../../src/main/control/server.js'

/** Real unix socket in a tmpdir; every collaborator is a recording fake. */

let cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

function sockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seashell-ctl-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'control.sock')
}

interface Fakes {
  deps: ControlServerDeps
  writes: Array<[string, string]>
  foregroundCalls: string[]
  postCardCalls: Array<{ paneId: string; question: string; draft: string | null }>
}

function makeFakes(over: Partial<ControlServerDeps> = {}): Fakes {
  const writes: Array<[string, string]> = []
  const foregroundCalls: string[] = []
  const postCardCalls: Array<{ paneId: string; question: string; draft: string | null }> = []
  const deps: ControlServerDeps = {
    socketPath: sockPath(),
    writeToPane: (paneId, text) => {
      writes.push([paneId, text])
      return true
    },
    paneTty: (paneId) => (paneId === 'pane-1' ? 'ttys004' : null),
    checkForeground: (tty) => {
      foregroundCalls.push(tty)
      return Promise.resolve(true)
    },
    screenKind: () => 'input',
    postCard: (req) => {
      postCardCalls.push(req)
      return null
    },
    ...over,
  }
  return { deps, writes, foregroundCalls, postCardCalls }
}

async function start(deps: ControlServerDeps): Promise<void> {
  const server = await startControlServer(deps)
  cleanups.push(() => server.close())
}

function request(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath)
    let got = ''
    const finish = (): void => {
      conn.destroy() // never leave a half-open client keeping server.close() waiting
      resolve(got.trim())
    }
    conn.setEncoding('utf8')
    conn.on('data', (d: string) => {
      got += d
    })
    conn.on('end', finish)
    conn.on('close', finish)
    conn.on('error', reject)
    conn.write(payload)
  })
}

const typeReq = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ cmd: 'type', paneId: 'pane-1', text: 'yes go ahead', ...over }) + '\n'

const cardReq = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ cmd: 'card', paneId: 'pane-1', question: 'ship it?', ...over }) + '\n'

/**
 * The whole suite binds real Unix domain sockets, which Node cannot reliably
 * listen on under Windows (net.listen on an AF_UNIX path fails EACCES — first
 * observed on the very first CI run on a windows runner). The app already
 * treats that failure as "no control socket, degrade to copy-paste", so on
 * win32 these tests describe behaviour that cannot exist rather than behaviour
 * that is broken. Skipped, not deleted: they still run on macOS and Linux,
 * which are the only places the socket does.
 */
describe.skipIf(process.platform === 'win32')('control server', () => {
  it('types text into a live pane whose foreground is claude', async () => {
    const { deps, writes, foregroundCalls } = makeFakes()
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, typeReq()))
    expect(res).toEqual({ ok: true })
    expect(writes).toEqual([['pane-1', 'yes go ahead']])
    expect(foregroundCalls).toEqual(['ttys004'])
  })

  it('refuses when the foreground is not claude, and writes nothing', async () => {
    const { deps, writes } = makeFakes({ checkForeground: () => Promise.resolve(false) })
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, typeReq()))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/claude/i)
    expect(writes).toEqual([])
  })

  it('type is refused while the pane shows a selector, and writes nothing', async () => {
    // A digit typed into a claude picker can select an option on its own — no
    // Enter needed — so "typed, never submitted" is not a safe property on a
    // selector screen. The guard must live here, not only in the card UI.
    const { deps, writes } = makeFakes({ screenKind: () => 'selector' })
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, typeReq({ text: '1' })))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/selector|picker/i)
    expect(writes).toEqual([])
  })

  it('refuses both commands when the request names a tty the pane no longer has', async () => {
    // A session-registry entry can outlive the SeaShell run that minted its
    // pane id; a reused pane id must not receive a card meant for the old
    // one. The registered tty is the cross-run identity check.
    const { deps, writes, postCardCalls } = makeFakes()
    await start(deps)
    const t = JSON.parse(await request(deps.socketPath, typeReq({ tty: 'ttys099' })))
    expect(t.ok).toBe(false)
    expect(t.error).toMatch(/tty/i)
    const c = JSON.parse(await request(deps.socketPath, cardReq({ tty: 'ttys099' })))
    expect(c.ok).toBe(false)
    expect(c.error).toMatch(/tty/i)
    expect(writes).toEqual([])
    expect(postCardCalls).toEqual([])
  })

  it('accepts both commands when the request tty matches the pane', async () => {
    const { deps, writes, postCardCalls } = makeFakes()
    await start(deps)
    const t = JSON.parse(await request(deps.socketPath, typeReq({ tty: 'ttys004' })))
    expect(t.ok).toBe(true)
    const c = JSON.parse(await request(deps.socketPath, cardReq({ tty: 'ttys004' })))
    expect(c.ok).toBe(true)
    expect(writes.length).toBe(1)
    expect(postCardCalls.length).toBe(1)
  })

  it('refuses an unknown pane without ever checking the foreground', async () => {
    const { deps, writes, foregroundCalls } = makeFakes()
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, typeReq({ paneId: 'pane-404' })))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/pane/i)
    expect(foregroundCalls).toEqual([])
    expect(writes).toEqual([])
  })

  it('routes a card to postCard after the foreground check', async () => {
    const { deps, foregroundCalls, postCardCalls } = makeFakes()
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, cardReq({ draft: 'yes go' })))
    expect(res).toEqual({ ok: true })
    expect(foregroundCalls).toEqual(['ttys004'])
    expect(postCardCalls).toEqual([{ paneId: 'pane-1', question: 'ship it?', draft: 'yes go' }])
  })

  it('validateOnly runs every check but creates nothing', async () => {
    const { deps, foregroundCalls, postCardCalls } = makeFakes()
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, cardReq({ validateOnly: true })))
    expect(res).toEqual({ ok: true })
    expect(foregroundCalls).toEqual(['ttys004'])
    expect(postCardCalls).toEqual([])
  })

  it('card for an unknown pane is refused before postCard', async () => {
    const { deps, foregroundCalls, postCardCalls } = makeFakes()
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, cardReq({ paneId: 'pane-404' })))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown or exited pane/i)
    expect(foregroundCalls).toEqual([])
    expect(postCardCalls).toEqual([])
  })

  it('card is refused when foreground is not claude', async () => {
    const { deps, postCardCalls } = makeFakes({ checkForeground: () => Promise.resolve(false) })
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, cardReq()))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/foreground/i)
    expect(postCardCalls).toEqual([])
  })

  it('postCard refusal surfaces as the error', async () => {
    const { deps } = makeFakes({ postCard: () => 'lookout disabled' })
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, cardReq()))
    expect(res).toEqual({ ok: false, error: 'lookout disabled' })
  })

  it('rejects malformed JSON at the boundary', async () => {
    const { deps } = makeFakes()
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, 'not json\n'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/JSON/i)
  })

  it('rejects text carrying a real newline (escaped in JSON), so nothing can submit', async () => {
    const { deps, writes } = makeFakes()
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, typeReq({ text: 'line1\nline2' })))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/control/i)
    expect(writes).toEqual([])
  })

  it('replaces a stale socket file from a previous run', async () => {
    const { deps, writes } = makeFakes()
    fs.writeFileSync(deps.socketPath, 'stale')
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, typeReq()))
    expect(res).toEqual({ ok: true })
    expect(writes.length).toBe(1)
  })

  it('close() removes the socket file', async () => {
    const { deps } = makeFakes()
    const server = await startControlServer(deps)
    expect(fs.existsSync(deps.socketPath)).toBe(true)
    await server.close()
    expect(fs.existsSync(deps.socketPath)).toBe(false)
  })

  it('cuts off an oversized request instead of buffering forever', async () => {
    const { deps, writes } = makeFakes()
    await start(deps)
    const res = await request(deps.socketPath, 'x'.repeat(70 * 1024))
    expect(res).toMatch(/large/i)
    expect(writes).toEqual([])
  })

  /**
   * One request must produce one write, whatever the client's writes are cut
   * into on the way over.
   *
   * `handle` is async — it awaits a `ps` — and the guard that stopped a second
   * dispatch was the same flag that guards the REPLY, which is only set once
   * that await resolves. The buffer is never consumed either, so a second data
   * event arriving in that window found the very same complete line still
   * sitting at position 0 and dispatched it again: the pane got the text
   * twice. A socket is a byte stream with no promise about chunk boundaries,
   * and the client here sends a JSON line whose length is whatever the drafted
   * reply happens to be, so "it arrives in one chunk" was never guaranteed.
   */
  it('types once when a request is split across two writes', async () => {
    // The window is exactly as wide as the foreground check, which in
    // production shells out to `ps` — tens of milliseconds, not a microtask.
    // A fake that resolves instantly closes the window by accident and the
    // bug goes unseen.
    const { deps, writes } = makeFakes({
      checkForeground: () => new Promise((r) => setTimeout(() => r(true), 40)),
    })
    await start(deps)
    const res = await new Promise<string>((resolve, reject) => {
      const conn = net.createConnection(deps.socketPath)
      let got = ''
      const finish = (): void => {
        conn.destroy()
        resolve(got.trim())
      }
      conn.setEncoding('utf8')
      conn.on('data', (d: string) => {
        got += d
      })
      conn.on('end', finish)
      conn.on('close', finish)
      conn.on('error', reject)
      // Written from 'connect', NOT straight after createConnection: writes
      // issued before the socket is up are buffered and flushed together, so
      // they reach the server as one chunk and the split never happens.
      conn.on('connect', () => {
        // A COMPLETE request first...
        conn.write(typeReq())
        // ...then a trailing byte, arriving while the foreground check for the
        // first one is still in flight. The buffer still holds that whole
        // first line, so this used to dispatch it a second time.
        setTimeout(() => conn.write('\n'), 10)
      })
    })
    expect(JSON.parse(res)).toEqual({ ok: true })
    // The duplicate lands AFTER the reply: the second dispatch is still inside
    // its own foreground check when the first one answers and closes the
    // socket, so asserting the moment the client sees `{ok:true}` misses it.
    // The client is gone by then and the write goes into the pane regardless —
    // which is exactly what makes this one hard to notice in the wild.
    await new Promise((r) => setTimeout(r, 150))
    expect(writes).toEqual([['pane-1', 'yes go ahead']])
  })
})
