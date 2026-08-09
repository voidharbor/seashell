/**
 * The control socket: one Unix domain socket, two commands (`type`, `card`),
 * one request per connection — see
 * docs/superpowers/specs/2026-07-31-pane-delivery-design.md and its amendment
 * docs/superpowers/specs/2026-08-01-lookout-approval-cards-design.md.
 *
 * Everything with a decision in it is injected (`ControlServerDeps`), so tests
 * drive a real socket against recording fakes. The guard ORDER matters: parse
 * (control characters die here), then pane existence, then the foreground
 * check — the expensive `ps` call runs only for requests that could succeed.
 * Both commands share that same paneTty -> checkForeground gate before
 * branching, since `card` validation is defined to mirror `type`'s.
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
  /** Main's own read of the pane's current screen (lookout/screen-kind.ts). */
  screenKind(paneId: string): 'input' | 'selector' | null
  /** Create a pushed card. Returns null on success, else a refusal message. */
  postCard(req: { paneId: string; question: string; draft: string | null }): string | null
  /** Idle timeout override. Production leaves this unset; tests shorten it so
   *  the reaping behaviour can be asserted without a five-second test. */
  idleTimeoutMs?: number
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
      const parsed = parseControlRequest(line)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const req = parsed.req

      // Both commands share paneTty -> checkForeground: identical eligibility,
      // one code path, no chance of the two guards drifting apart.
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
        // A card push writes nothing at this point, so the "into a shell" detail
        // that explains the type refusal would be wrong here — only the fact
        // in common (claude must own this pane right now) applies to both.
        return req.cmd === 'type'
          ? { ok: false, error: 'pane foreground is not claude — refusing to type into a shell' }
          : { ok: false, error: 'pane foreground is not claude' }
      }

      if (req.cmd === 'type') {
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

      // cmd === 'card'. validateOnly has now run every guard above and creates
      // nothing — that is what makes an honest --dry-run possible on the pusher
      // side (see docs/superpowers/specs/2026-08-01-lookout-approval-cards-design.md).
      if (req.validateOnly) return { ok: true }

      const refusal = deps.postCard({ paneId: req.paneId, question: req.question, draft: req.draft })
      return refusal === null ? { ok: true } : { ok: false, error: refusal }
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
