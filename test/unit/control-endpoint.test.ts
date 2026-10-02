import { afterEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import {
  CONTROL_HOST,
  UNAUTHORIZED,
  controlJsonPath,
  endpointInfo,
  gateRequest,
  generateToken,
  serializeEndpointInfo,
  tokensMatch,
} from '../../src/main/control/endpoint.js'
import { startTcpControlServer, type TcpControlServerDeps } from '../../src/main/control/server.js'

const TOKEN = 'a'.repeat(64)

const typeLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ token: TOKEN, cmd: 'type', paneId: 'pane-1', text: 'yes go ahead', ...over })

describe('control endpoint: token', () => {
  it('generates 32 random bytes as 64 hex chars', () => {
    const seen: number[] = []
    const t = generateToken((n) => {
      seen.push(n)
      return Buffer.alloc(n, 0xab)
    })
    expect(seen).toEqual([32])
    expect(t).toBe('ab'.repeat(32))
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(generateToken()).not.toBe(generateToken())
  })

  it('refuses a short random read instead of minting a weak token', () => {
    expect(() => generateToken(() => Buffer.alloc(8))).toThrow()
  })

  it('matches only the exact token', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
    expect(tokensMatch(TOKEN, 'b'.repeat(64))).toBe(false)
    expect(tokensMatch(TOKEN, TOKEN.slice(1))).toBe(false)
    expect(tokensMatch(TOKEN, TOKEN + 'a')).toBe(false)
    expect(tokensMatch(TOKEN, undefined)).toBe(false)
    expect(tokensMatch(TOKEN, 42)).toBe(false)
    expect(tokensMatch('', '')).toBe(false)
  })
})

describe('control endpoint: control.json', () => {
  it('lives in userData and carries host, port, token, pid, corePid', () => {
    expect(controlJsonPath('/u/seashell')).toBe(path.join('/u/seashell', 'control.json'))
    const info = endpointInfo(51234, TOKEN, 999)
    expect(info).toEqual({ host: '127.0.0.1', port: 51234, token: TOKEN, pid: 999, corePid: process.pid })
    expect(JSON.parse(serializeEndpointInfo(info))).toEqual(info)
    expect(CONTROL_HOST).toBe('127.0.0.1')
  })
})

describe('control endpoint: corePid', () => {
  it('names the serving process apart from the host pid under the native shell', () => {
    const info = endpointInfo(51234, TOKEN, 4512, 3101)
    expect(info.pid).toBe(4512)
    expect(info.corePid).toBe(3101)
    expect(JSON.parse(serializeEndpointInfo(info))).toEqual(info)
  })
})

describe('control endpoint: request gating', () => {
  it('passes an authenticated request through to the ordinary validation', () => {
    const r = gateRequest(typeLine(), TOKEN)
    expect(r).toEqual({
      ok: true,
      req: { cmd: 'type', paneId: 'pane-1', text: 'yes go ahead', tty: null },
    })
  })

  it('refuses a missing or wrong token before looking at anything else', () => {
    expect(gateRequest(typeLine({ token: undefined }), TOKEN)).toEqual({
      ok: false,
      error: UNAUTHORIZED,
    })
    expect(gateRequest(typeLine({ token: 'nope' }), TOKEN)).toEqual({
      ok: false,
      error: UNAUTHORIZED,
    })
    // An invalid command with no token still gets only the token refusal.
    expect(gateRequest(JSON.stringify({ cmd: 'rm' }), TOKEN).ok).toBe(false)
    expect(gateRequest(JSON.stringify({ cmd: 'rm' }), TOKEN)).toEqual({
      ok: false,
      error: UNAUTHORIZED,
    })
    expect(gateRequest('not json', TOKEN)).toEqual({ ok: false, error: UNAUTHORIZED })
    expect(gateRequest('[1]', TOKEN)).toEqual({ ok: false, error: UNAUTHORIZED })
  })

  it('still applies the protocol rules once authenticated', () => {
    const r = gateRequest(typeLine({ text: 'a\nb' }), TOKEN)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/control/i)
    const u = gateRequest(typeLine({ cmd: 'rm' }), TOKEN)
    expect(u).toEqual({ ok: false, error: 'unknown cmd' })
  })
})

/** Plain TCP on loopback, so this runs on every platform. */
describe('control endpoint: TCP transport', () => {
  let cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const fn of cleanups.reverse()) await fn()
    cleanups = []
  })

  function deps(over: Partial<TcpControlServerDeps> = {}): {
    deps: TcpControlServerDeps
    writes: Array<[string, string]>
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seashell-ctl-tcp-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const writes: Array<[string, string]> = []
    return {
      writes,
      deps: {
        infoPath: path.join(dir, 'control.json'),
        writeToPane: (paneId, text) => {
          writes.push([paneId, text])
          return true
        },
        paneTty: (paneId) => (paneId === 'pane-1' ? 'pts/3' : null),
        checkForeground: () => Promise.resolve(true),
        screenKind: () => 'input',
        ...over,
      },
    }
  }

  function request(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection({ host: '127.0.0.1', port })
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
      conn.write(payload)
    })
  }

  it('publishes control.json, round-trips one authenticated request, and cleans up', async () => {
    const { deps: d, writes } = deps()
    const server = await startTcpControlServer(d)
    let closed = false
    cleanups.push(() => (closed ? undefined : server.close()))

    const info = JSON.parse(fs.readFileSync(d.infoPath, 'utf8'))
    expect(info).toEqual({
      host: '127.0.0.1',
      port: server.port,
      token: server.token,
      pid: process.pid,
      corePid: process.pid,
    })
    expect(server.port).toBeGreaterThan(0)
    expect(server.token).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') {
      expect(fs.statSync(d.infoPath).mode & 0o777).toBe(0o600)
    }

    const line = JSON.stringify({ token: info.token, cmd: 'type', paneId: 'pane-1', text: 'hi' })
    expect(JSON.parse(await request(info.port, line + '\n'))).toEqual({ ok: true })
    expect(writes).toEqual([['pane-1', 'hi']])

    await server.close()
    closed = true
    expect(fs.existsSync(d.infoPath)).toBe(false)
  })

  it('refuses a request with the wrong token and types nothing', async () => {
    const { deps: d, writes } = deps()
    const server = await startTcpControlServer(d)
    cleanups.push(() => server.close())
    const line = JSON.stringify({
      token: 'f'.repeat(64),
      cmd: 'type',
      paneId: 'pane-1',
      text: 'hi',
    })
    expect(JSON.parse(await request(server.port, line + '\n'))).toEqual({
      ok: false,
      error: UNAUTHORIZED,
    })
    expect(writes).toEqual([])
  })

  it('keeps the foreground refusal', async () => {
    const { deps: d, writes } = deps({ checkForeground: () => Promise.resolve(false) })
    const server = await startTcpControlServer(d)
    cleanups.push(() => server.close())
    const line = JSON.stringify({ token: server.token, cmd: 'type', paneId: 'pane-1', text: 'hi' })
    const res = JSON.parse(await request(server.port, line + '\n'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/claude/i)
    expect(writes).toEqual([])
  })

  it('leaves a control.json it no longer owns in place on close', async () => {
    const { deps: d } = deps()
    const server = await startTcpControlServer(d)
    fs.writeFileSync(d.infoPath, '{"newer":true}\n')
    await server.close()
    expect(fs.readFileSync(d.infoPath, 'utf8')).toBe('{"newer":true}\n')
  })
})
