/**
 * The Windows control endpoint: the decisions, with no I/O of their own.
 *
 * On macOS and Linux the control channel is a Unix domain socket whose file
 * mode (0600) is the authentication. libuv cannot listen on AF_UNIX on
 * Windows, so there the server listens on 127.0.0.1 on a random port instead.
 * A loopback port is reachable by every local user and every process, so it
 * needs a credential of its own: a 32-byte random token, written with the
 * port into `<userData>/control.json`, which only the user's own profile can
 * read. A client reads that file and presents the token in every request.
 *
 * Clients inside WSL reach the same listener at 127.0.0.1:<port> only when
 * WSL runs with networkingMode=mirrored (in the default NAT mode the Windows
 * loopback is not theirs); they read the file through /mnt/c.
 *
 * Everything here is injectable or pure so the unit tests need no socket.
 */
import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { validateControlRequest, type ParseResult } from './protocol.js'

export const CONTROL_HOST = '127.0.0.1'
export const CONTROL_JSON = 'control.json'
export const TOKEN_BYTES = 32

/**
 * What `control.json` holds. `pid` lets a reader tell a stale file from a live
 * one. `corePid` is the process actually serving: the same as `pid` except
 * under the native Windows shell, where `pid` is the shell's Windows pid and
 * `corePid` the Linux pid of main running in WSL.
 */
export interface ControlEndpointInfo {
  host: typeof CONTROL_HOST
  port: number
  token: string
  pid: number
  corePid: number
}

/** 32 random bytes as 64 lowercase hex characters. */
export function generateToken(randomBytes: (n: number) => Buffer = nodeRandomBytes): string {
  const buf = randomBytes(TOKEN_BYTES)
  if (buf.length !== TOKEN_BYTES) throw new Error('short random read')
  return buf.toString('hex')
}

export function controlJsonPath(userData: string): string {
  return path.join(userData, CONTROL_JSON)
}

export function endpointInfo(port: number, token: string, pid: number, corePid: number = process.pid): ControlEndpointInfo {
  return { host: CONTROL_HOST, port, token, pid, corePid }
}

export function serializeEndpointInfo(info: ControlEndpointInfo): string {
  return JSON.stringify(info) + '\n'
}

/**
 * Constant-time token comparison. A wrong-length or non-string token is a
 * mismatch; the comparison still runs (against the expected value itself) so
 * the length check does not change the timing of the common path.
 */
export function tokensMatch(expected: string, presented: unknown): boolean {
  const want = Buffer.from(expected, 'utf8')
  if (typeof presented !== 'string') {
    timingSafeEqual(want, want)
    return false
  }
  const got = Buffer.from(presented, 'utf8')
  if (got.length !== want.length) {
    timingSafeEqual(want, want)
    return false
  }
  return timingSafeEqual(want, got) && expected.length > 0
}

export const UNAUTHORIZED = 'missing or wrong token'

/**
 * Gate one request line on the token, then validate it.
 *
 * The token is checked before any other field is looked at: a request that
 * is not JSON, is not an object, or carries no matching token gets the same
 * single refusal, so an unauthenticated client learns nothing about the
 * protocol. Only an authenticated request reaches the ordinary validation in
 * protocol.ts, which is the same validation the Unix socket applies.
 */
export function gateRequest(line: string, token: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, error: UNAUTHORIZED }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: UNAUTHORIZED }
  }
  if (!tokensMatch(token, (parsed as Record<string, unknown>)['token'])) {
    return { ok: false, error: UNAUTHORIZED }
  }
  return validateControlRequest(parsed)
}
