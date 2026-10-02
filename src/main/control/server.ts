/**
 * The control socket: one Unix domain socket, one command (`type`), one
 * request per connection. See
 * docs/superpowers/specs/2026-07-31-pane-delivery-design.md.
 *
 * Everything with a decision in it is injected (`ControlServerDeps`), so tests
 * drive a real socket against recording fakes. The guard ORDER matters: parse
 * (control characters die here), then pane existence, then the foreground
 * check — the expensive `ps` call runs only for requests that could succeed.
 *
 * A Unix socket rather than a port: no network surface, filesystem mode 0600
 * is the authentication. Windows cannot listen on AF_UNIX, so there
 * `startTcpControlServer` serves the same protocol on 127.0.0.1 with a random
 * port and a token (control/endpoint.ts). Both share one connection handler;
 * the only difference is how a request line is parsed (the TCP one checks the
 * token first).
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { parseControlRequest, type ParseResult } from './protocol.js'
import {
  CONTROL_HOST,
  endpointInfo,
  gateRequest,
  generateToken,
  serializeEndpointInfo,
} from './endpoint.js'

/** The collaborators every transport shares. */
export interface ControlHandlerDeps {
  /** Returns false when the pane is unknown or its pty has exited. */
  writeToPane(paneId: string, text: string): boolean
  /** The pane's controlling tty (e.g. `ttys004`), or null if unknown/exited. */
  paneTty(paneId: string): string | null
  /** Whether the foreground process group on that tty is a main claude process. */
  checkForeground(ttyName: string): Promise<boolean>
  /** Main's own read of the pane's current screen (control/screen-kind.ts). */
  screenKind(paneId: string): 'input' | 'selector' | null
  /** Idle timeout override. Production leaves this unset; tests shorten it so
   *  the reaping behaviour can be asserted without a five-second test. */
  idleTimeoutMs?: number
}

export interface ControlServerDeps extends ControlHandlerDeps {
  socketPath: string
}

export interface TcpControlServerDeps extends ControlHandlerDeps {
  /** Where the endpoint file goes: `<userData>/control.json`. */
  infoPath: string
  /** Tests may pin these; production leaves them unset (port 0, fresh token). */
  port?: number
  token?: string
  pid?: number
}

export interface ControlServer {
  close(): Promise<void>
}

export interface TcpControlServer extends ControlServer {
  port: number
  token: string
}

const MAX_REQUEST_BYTES = 64 * 1024
/** A client that connects and then says nothing must not hold a socket forever. */
const IDLE_TIMEOUT_MS = 5000

interface ControlResponse {
  ok: boolean
  error?: string
}

export async function startControlServer(deps: ControlServerDeps): Promise<ControlServer> {
  // A stale socket file from a crashed run would make listen() fail EADDRINUSE.
  fs.rmSync(deps.socketPath, { force: true })
  fs.mkdirSync(path.dirname(deps.socketPath), { recursive: true })

  const connections = new Set<net.Socket>()
  const server = net.createServer(connectionHandler(deps, parseControlRequest, connections))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(deps.socketPath, () => resolve())
  })
  // Owner-only: filesystem permissions are the authentication.
  fs.chmodSync(deps.socketPath, 0o600)

  return {
    close: async () => {
      await closeServer(server, connections)
      fs.rmSync(deps.socketPath, { force: true })
    },
  }
}

/**
 * The Windows transport: 127.0.0.1 on a random port, every request gated on
 * a 32-byte token, the endpoint published in `control.json` for clients to
 * find. The file is written only after listen() succeeds (it names the real
 * port) and removed on close, but only while it is still ours.
 */
export async function startTcpControlServer(deps: TcpControlServerDeps): Promise<TcpControlServer> {
  const token = deps.token ?? generateToken()
  const connections = new Set<net.Socket>()
  const server = net.createServer(
    connectionHandler(deps, (line) => gateRequest(line, token), connections)
  )

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(deps.port ?? 0, CONTROL_HOST, () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0

  const info = serializeEndpointInfo(endpointInfo(port, token, deps.pid ?? process.pid))
  const tmp = `${deps.infoPath}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(deps.infoPath), { recursive: true })
    // Written whole then renamed, so a client never reads half a file. The
    // mode is honoured on posix; on Windows the user profile's ACL is the
    // protection, since userData lives under %APPDATA%.
    //
    // Known limit: from inside WSL, /mnt/c is mounted without the `metadata`
    // option, so this file reads as mode 0777 to every Linux uid, and all of
    // them act with the Windows user's token. Any process in the distro, under
    // any uid, can read the token and type into a pane. The Unix socket's 0600
    // limited that to one uid; this transport does not. Restoring it needs a
    // peer check (a nonce in a 0600 file inside the WSL home) or a /mnt/c
    // mount with metadata,umask=077.
    fs.writeFileSync(tmp, info, { mode: 0o600 })
    await renameWithRetry(tmp, deps.infoPath)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    await closeServer(server, connections)
    throw err
  }

  return {
    port,
    token,
    close: async () => {
      await closeServer(server, connections)
      try {
        // A newer instance may have replaced the file; leave its copy alone.
        if (fs.readFileSync(deps.infoPath, 'utf8') === info)
          fs.rmSync(deps.infoPath, { force: true })
      } catch {
        /* already gone */
      }
    },
  }
}

/** Windows refuses a rename while any reader (Defender, a client reading the
 *  old file over 9P) holds the target without delete sharing. Those holds are
 *  brief, so a few short retries ride them out; one failure must not turn
 *  pane delivery off for the whole run. */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800]

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as { code?: unknown }).code
      const delay = RENAME_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

async function closeServer(server: net.Server, connections: Set<net.Socket>): Promise<void> {
  for (const conn of connections) conn.destroy()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

function connectionHandler(
  deps: ControlHandlerDeps,
  parse: (line: string) => ParseResult,
  connections: Set<net.Socket>
): (conn: net.Socket) => void {
  return (conn) => {
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
    conn.on('error', () => conn.destroy())
    conn.setEncoding('utf8')

    let buf = ''
    let done = false
    /**
     * Set the moment a request is HANDED TO `handle`, which is not the same
     * moment as `done`.
     *
     * `done` is set by `respond`, and `respond` only runs once `handle` has
     * resolved — and `handle` awaits a `ps`, tens of milliseconds. A second
     * data event inside that window found `done` still false, and because the
     * buffer is never consumed it found the same complete request line still
     * sitting at position 0 and dispatched it AGAIN. Measured on a socket
     * whose client wrote its line and then two more bytes: three dispatches,
     * three copies of the text typed into the pane, from one request.
     *
     * A stream gives no promise about chunk boundaries, so this needed no
     * misbehaving client — a drafted reply long enough to be split, or any
     * trailing byte, was enough. One connection carries one request here (the
     * reply ends it), so the guard is simply: dispatch at most once.
     */
    let dispatched = false

    /**
     * The idle timer reaps a silent client, and must stop there.
     *
     * Node fires this on *inactivity*, and once a request has been handed to
     * `handle` there is deliberately no traffic at all: `handle` is awaiting a
     * `ps`. So a slow foreground check used to trip the timer and destroy the
     * socket mid-flight — after which `handle` carried on, typed the text into
     * the live pane, and `respond` called `conn.end` on a dead socket whose
     * error the handler above swallows. The pusher saw EOF with no JSON, which
     * is indistinguishable from a refusal, so a retry typed the same text into
     * the agent a second time: the exact duplicate delivery `dispatched`
     * exists to prevent, reached through a different door.
     *
     * Every pre-dispatch reason for the timeout survives. A client that
     * connects and says nothing, or sends half a line and stops, still leaves
     * `dispatched` false and is still reaped. Once dispatched, `handle` always
     * resolves — its only await is wrapped in try/catch and every branch
     * returns a response — and the reply closes the socket itself.
     */
    conn.setTimeout(deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => {
      if (!dispatched) conn.destroy()
    })

    const respond = (res: ControlResponse): void => {
      if (done) return
      done = true
      conn.end(JSON.stringify(res) + '\n')
    }

    conn.on('data', (chunk: string) => {
      if (done || dispatched) return
      buf += chunk
      if (buf.length > MAX_REQUEST_BYTES) {
        respond({ ok: false, error: 'request too large' })
        conn.destroy()
        return
      }
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      dispatched = true
      void handle(buf.slice(0, nl)).then(respond)
    })

    async function handle(line: string): Promise<ControlResponse> {
      const parsed = parse(line)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const req = parsed.req

      const tty = deps.paneTty(req.paneId)
      if (tty === null) return { ok: false, error: 'unknown or exited pane' }

      // A pane id is only unique within one SeaShell run; the registry entry
      // that named it can be older than this run. The registered tty is the
      // identity that survives across runs — a mismatch means the caller is
      // holding a stale entry and this pane is somebody else's session.
      if (req.tty !== null && req.tty !== tty) {
        return { ok: false, error: 'pane tty mismatch — the session registry entry is stale' }
      }

      let foreground = false
      try {
        foreground = await deps.checkForeground(tty)
      } catch {
        foreground = false
      }
      if (!foreground) {
        return { ok: false, error: 'pane foreground is not claude — refusing to type into a shell' }
      }

      // "Typed, never submitted" is not a safe property on a selector
      // screen: a lone digit can pick an option with no Enter involved.
      if (deps.screenKind(req.paneId) === 'selector') {
        return { ok: false, error: 'pane is showing a picker — refusing to type into a selector' }
      }
      // The pane can exit between the checks above and here; write() re-checks.
      if (!deps.writeToPane(req.paneId, req.text)) {
        return { ok: false, error: 'unknown or exited pane' }
      }
      return { ok: true }
    }
  }
}
