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
}

function makeFakes(over: Partial<ControlServerDeps> = {}): Fakes {
  const writes: Array<[string, string]> = []
  const foregroundCalls: string[] = []
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
    ...over,
  }
  return { deps, writes, foregroundCalls }
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

describe('control server', () => {
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

  it('refuses an unknown pane without ever checking the foreground', async () => {
    const { deps, writes, foregroundCalls } = makeFakes()
    await start(deps)
    const res = JSON.parse(await request(deps.socketPath, typeReq({ paneId: 'pane-404' })))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/pane/i)
    expect(foregroundCalls).toEqual([])
    expect(writes).toEqual([])
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
})
