/**
 * Pipe backpressure for pty reads (design spec 4.2, Review Focus 2).
 *
 * In the native core every pane's output leaves through one stdout pipe to the
 * shell. When that pipe stops taking bytes, `process.stdout.write` returns
 * false and node buffers whatever comes next in memory, so a pane printing
 * 50 MB would grow the core by about that much. The core holds this gate while
 * stdout is over its high-water mark and releases it on 'drain'; PtyManager
 * pauses every pty's reads while it is held, so the kernel's pty buffer fills
 * and the writing program blocks instead.
 *
 * Under Electron nothing holds the gate, so nothing pauses.
 */

export type GateListener = (held: boolean) => void

export class ReadGate {
  private isHeld = false
  private readonly listeners = new Set<GateListener>()

  get held(): boolean {
    return this.isHeld
  }

  /** Subscribes to hold and release; returns the unsubscribe. */
  onChange(fn: GateListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  hold(): void {
    this.set(true)
  }

  release(): void {
    this.set(false)
  }

  private set(held: boolean): void {
    if (this.isHeld === held) return
    this.isHeld = held
    for (const fn of [...this.listeners]) fn(held)
  }
}

/** The one gate the core's stdout writer and PtyManager share. */
export const ptyReadGate = new ReadGate()

/** The part of a Writable the pipe writer needs (process.stdout in the core). */
export interface PipeLike {
  write(chunk: string): boolean
  once(event: 'drain', fn: () => void): unknown
}

/**
 * A line writer for `out` that holds `gate` when a write returns false and
 * releases it on the next 'drain'. Lines are never dropped: what is written
 * while held still queues, but only the batches already flushed by then, since
 * the ptys stop reading.
 */
export function gatedWriter(out: PipeLike, gate: ReadGate = ptyReadGate): (line: string) => void {
  let waiting = false
  return (line: string): void => {
    if (out.write(line)) return
    gate.hold()
    if (waiting) return
    waiting = true
    out.once('drain', () => {
      waiting = false
      gate.release()
    })
  }
}
