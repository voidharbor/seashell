/** Reads envelope lines from the shell (stdin) and hands each one to the shim (or index.ts's early routes in front of it). */
import type { Shim } from './electron-shim.js'
import { decodeEnvelope, type Envelope } from './protocol.js'

export function startStdio(shim: Pick<Shim, 'dispatch'>, input: NodeJS.ReadableStream = process.stdin): void {
  let buf = ''
  input.setEncoding?.('utf8')
  input.on('data', (chunk: string | Buffer) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line) continue
      let env: Envelope
      try {
        env = decodeEnvelope(line)
      } catch (err) {
        process.stderr.write(`[core] bad envelope: ${String(err)}\n`)
        continue
      }
      shim.dispatch(env).catch((err: unknown) => process.stderr.write(`[core] dispatch ${env.ch} failed: ${String(err)}\n`))
    }
  })
}
