/**
 * The control socket: one Unix domain socket, one command, one request per
 * connection — see docs/superpowers/specs/2026-07-31-pane-delivery-design.md.
 *
 * Everything with a decision in it is injected (`ControlServerDeps`), so tests
 * drive a real socket against recording fakes. The guard ORDER matters: parse
 * (control characters die here), then pane existence, then the foreground
 * check — the expensive `ps` call runs only for requests that could succeed.
 *
 * A Unix socket rather than a port: no network surface, filesystem mode 0600
 * is the authentication.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { parseControlRequest } from './protocol.js'

export interface ControlServerDeps {
  socketPath: string
  /** Returns false when the pane is unknown or its pty has exited. */
  writeToPane(paneId: string, text: string): boolean
  /** The pane's controlling tty (e.g. `ttys004`), or null if unknown/exited. */
  paneTty(paneId: string): string | null
  /** Whether the foreground process group on that tty is a main claude process. */
  checkForeground(ttyName: string): Promise<boolean>
}

export interface ControlServer {
  close(): Promise<void>
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

  const server = net.createServer((conn) => {
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
    conn.on('error', () => conn.destroy())
    conn.setTimeout(IDLE_TIMEOUT_MS, () => conn.destroy())
    conn.setEncoding('utf8')

    let buf = ''
    let done = false
    const respond = (res: ControlResponse): void => {
      if (done) return
      done = true
      conn.end(JSON.stringify(res) + '\n')
    }

    conn.on('data', (chunk: string) => {
      if (done) return
      buf += chunk
      if (buf.length > MAX_REQUEST_BYTES) {
        respond({ ok: false, error: 'request too large' })
        conn.destroy()
        return
      }
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      void handle(buf.slice(0, nl)).then(respond)
    })

    async function handle(line: string): Promise<ControlResponse> {
      const parsed = parseControlRequest(line)
      if (!parsed.ok) return { ok: false, error: parsed.error }

      // Only type requests are handled here; card command handling is in a later task.
      if (parsed.req.cmd !== 'type') {
        return { ok: false, error: 'card command not yet implemented' }
      }

      const tty = deps.paneTty(parsed.req.paneId)
      if (tty === null) return { ok: false, error: 'unknown or exited pane' }

      let foreground = false
      try {
        foreground = await deps.checkForeground(tty)
      } catch {
        foreground = false
      }
      if (!foreground) {
        return { ok: false, error: 'pane foreground is not claude — refusing to type into a shell' }
      }

      // The pane can exit between the checks above and here; write() re-checks.
      if (!deps.writeToPane(parsed.req.paneId, parsed.req.text)) {
        return { ok: false, error: 'unknown or exited pane' }
      }
      return { ok: true }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(deps.socketPath, () => resolve())
  })
  // Owner-only: filesystem permissions are the authentication.
  fs.chmodSync(deps.socketPath, 0o600)

  return {
    close: async () => {
      for (const conn of connections) conn.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      fs.rmSync(deps.socketPath, { force: true })
    },
  }
}
