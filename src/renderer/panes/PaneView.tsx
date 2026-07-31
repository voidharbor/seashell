import { useEffect, useRef } from 'react'
import { PaneTerminal } from '../term/terminal.js'
import { pathAtPoint } from './pathclick.js'
import type { PaneState } from '../store.js'

/** Live terminals by pane id, so incoming PTY batches can be routed without
 *  every pane holding its own IPC subscription. */
export const terminals = new Map<string, PaneTerminal>()

/**
 * Pane ids that already own a PTY.
 *
 * A component effect is not a safe place to own a process. StrictMode
 * deliberately mounts, unmounts and remounts every component to surface exactly
 * this class of bug, and React may also remount on reconciliation. Either way a
 * second spawn for the same pane is wrong: the first PTY would be orphaned and
 * the second rejected. The PTY's real lifetime is "until the pane is closed",
 * which is tracked here rather than by the component.
 */
const spawned = new Set<string>()

/** Called by the close path once the PTY is actually dead. */
export function forgetSpawn(paneId: string): void {
  spawned.delete(paneId)
}

export interface PaneViewProps {
  pane: PaneState
  index: number
  rect: { x: number; y: number; width: number; height: number }
  focused: boolean
  hidden: boolean
  onFocus: () => void
  onClose: () => void
  onZoom: () => void
  onReveal: (path: string) => void
  onSpawned: (pid: number) => void
  onRestart: () => void
}

export function PaneView(props: PaneViewProps): React.JSX.Element {
  const { pane, index, rect, focused, hidden } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const revealRef = useRef(props.onReveal)
  revealRef.current = props.onReveal

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const t = new PaneTerminal({
      paneId: pane.id,
      container: host,
      onInput: (data) => window.seashell.pty.write({ paneId: pane.id, data }),
      onResize: (cols, rows) => window.seashell.pty.resize({ paneId: pane.id, cols, rows }),
      onHttpLink: (url) => void window.seashell.open.externalHttp({ url }),
      onDoubleClick: (x, y) => {
        const candidate = pathAtPoint(t.term, x, y)
        if (candidate) revealRef.current(candidate)
      },
    })
    terminals.set(pane.id, t)
    t.enableWebgl()
    t.refit()

    // Spawn only after fit, so the child never sees a wrong initial size and
    // has to redraw. cols/rows come from the real measured geometry.
    if (!spawned.has(pane.id)) {
      spawned.add(pane.id)
      void window.seashell.pty
        .spawn({
          paneId: pane.id,
          file: '/bin/zsh',
          args: ['-l'],
          cwd: pane.cwd,
          cols: t.term.cols,
          rows: t.term.rows,
        })
        .then((res) => {
          if (res.ok) {
            props.onSpawned(res.pid)
            // A pane launched as `claude` or a custom command types it into the
            // shell once the prompt settles, rather than replacing the shell.
            if (pane.command !== 'zsh') {
              const text = pane.command === 'claude' ? 'claude' : (pane.commandText ?? '')
              if (text) {
                setTimeout(() => {
                  window.seashell.pty.write({ paneId: pane.id, data: `${text}\r` })
                }, 300)
              }
            }
          } else {
            spawned.delete(pane.id)
            t.write(`\r\n\x1b[31mFailed to start shell: ${res.code} — ${res.message}\x1b[0m\r\n`)
          }
        })
    }

    return () => {
      terminals.delete(pane.id)
      t.dispose()
    }
    // Intentionally mount-only: a pane's terminal outlives every prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id])

  // Only visible panes are ever refit. Resizing a hidden pane would send
  // SIGWINCH and force a full-screen program to reflow its entire UI for a
  // size the user cannot even see.
  useEffect(() => {
    if (hidden) return
    const t = terminals.get(pane.id)
    if (!t) return
    const raf = requestAnimationFrame(() => t.refit())
    return () => cancelAnimationFrame(raf)
  }, [pane.id, hidden, rect.width, rect.height])

  useEffect(() => {
    if (!focused || hidden) return
    terminals.get(pane.id)?.term.focus()
  }, [focused, hidden, pane.id])

  useEffect(() => {
    if (pane.status === 'exited') terminals.get(pane.id)?.markExited()
  }, [pane.status, pane.id])

  const mem = pane.metrics?.footprintBytes ?? 0
  const showMem = mem >= 200 * 1024 * 1024

  return (
    <div
      className={
        'pane' + (focused ? ' pane--focused' : '') + (hidden ? ' pane--hidden' : '')
      }
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onMouseDown={props.onFocus}
    >
      <div
        className="pane__title"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.pane__close')) return
          props.onZoom()
        }}
      >
        <span className="pane__index">{index}</span>
        <span className="pane__label">{pane.label}</span>
        <span className="pane__badge">
          {pane.metrics?.foregroundProcess || (pane.command === 'zsh' ? 'zsh' : pane.command)}
        </span>
        <span className="pane__spacer" />
        {showMem && (
          <span className={'pane__mem' + (mem > 1e9 ? ' pane__mem--high' : '')}>
            ~{formatBytes(mem)}
          </span>
        )}
        <span className="pane__close" onClick={props.onClose} title="Close pane (⌘W)">
          ×
        </span>
      </div>

      <div className="pane__term" ref={hostRef} />

      {pane.status === 'exited' && pane.exit && (
        <div className={'pane__exit' + (pane.exit.code !== 0 ? ' pane__exit--bad' : '')}>
          <span>
            {pane.exit.signal
              ? `killed · signal ${pane.exit.signal}`
              : `exited · code ${pane.exit.code}`}
          </span>
          <button className="btn" onClick={props.onRestart}>
            Restart
          </button>
        </div>
      )}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}
