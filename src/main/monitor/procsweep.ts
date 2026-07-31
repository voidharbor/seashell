import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * All process sampling goes through execFile with an argv array.
 *
 * NEVER `exec('ps ... | grep ' + something)`. Anything derived from terminal
 * output or a filename is attacker-influenced, and a shell string turns that
 * into command execution.
 */

/** Narrow sweep whose stdout feeds `parsePsOutput` in sweep-parse.ts. */
export async function psSweepMemory(): Promise<string> {
  try {
    const { stdout } = await run('/bin/ps', ['-axo', 'pid,ppid,rss,pcpu,stat,comm'], {
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
  } catch {
    return ''
  }
}

/** One row of the wider sweep used by the kill ladder. */
export interface KillRow {
  pid: number
  ppid: number
  pgid: number
  /** e.g. `ttys004`, or `??` when the process has no controlling terminal. */
  tty: string
}

/**
 * Wider sweep including process group and controlling tty.
 *
 * Only run when a pane is closing, so the extra columns cost nothing at idle.
 * `pgid` is what actually gets signalled — zsh job control puts each foreground
 * job in its own group, so signalling the shell's group alone misses the job.
 * `tty` catches double-forked descendants that the ppid walk cannot reach.
 */
export async function psSweep(): Promise<KillRow[]> {
  let stdout: string
  try {
    const res = await run('/bin/ps', ['-axo', 'pid,ppid,pgid,tty'], {
      maxBuffer: 8 * 1024 * 1024,
    })
    stdout = res.stdout
  } catch {
    return []
  }

  const rows: KillRow[] = []
  const lines = stdout.split('\n')
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const pgid = Number(parts[2])
    const tty = parts[3] ?? '??'
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(pgid)) continue
    rows.push({ pid, ppid, pgid, tty })
  }
  return rows
}
