import { useEffect, useRef } from 'react'
import { PaneTerminal } from '../term/terminal.js'
import { pathAtPoint } from './pathclick.js'
import { WebPreview } from './WebPreview.js'
import { FilePreview } from '../viewer/FilePreview.js'
import { FindBar } from '../find/FindBar.js'
import type { PaneState } from '../store.js'

/** Live terminals by pane id, so incoming PTY batches can be routed without
 *  every pane holding its own IPC subscription. */
export const terminals = new Map<string, PaneTerminal>()

/**
 * Pane generations that already own a PTY.
 *
 * A component effect is not a safe place to own a process. StrictMode
 * deliberately mounts, unmounts and remounts every component to surface exactly
 * this class of bug, and React may also remount on reconciliation. Either way a
 * second spawn for the same pane is wrong: the first PTY would be orphaned and
 * the second rejected. The PTY's real lifetime is "until the pane is closed or
 * restarted", which is tracked here rather than by the component.
 *
 * Keyed by generation, not by pane id alone. Restart re-uses the pane id on
 * purpose — the pane keeps its position, label and scrollback — so a key of
 * just the id would make the restart look like a duplicate spawn and be
 * silently dropped, which is exactly how the Restart button came to do nothing.
 */
const spawned = new Set<string>()

const genKey = (paneId: string, generation: number): string => `${paneId}#${generation}`

/** Called by the close path once the PTY is actually dead. */
export function forgetSpawn(paneId: string): void {
  for (const key of [...spawned]) {
    if (key.startsWith(`${paneId}#`)) spawned.delete(key)
  }
}

export interface PaneViewProps {
  pane: PaneState
  index: number
  rect: { x: number; y: number; width: number; height: number }
  focused: boolean
  hidden: boolean
  /** Terminal font size for the current zoom level. */
  fontSize: number
  findOpen: boolean
  findNonce: number
  findDirection: 'next' | 'prev'
  onCloseFind: () => void
  onFocus: () => void
  onClose: () => void
  onZoom: () => void
  onReveal: (path: string) => void
  onSpawned: (pid: number) => void
  onRestart: () => void
  onUrlChange: (url: string) => void
  onToggleRaw: (raw: boolean) => void
  onToast: (message: string) => void
}

export function PaneView(props: PaneViewProps): React.JSX.Element {
  const { pane, index, rect, focused, hidden } = props

  const mem = pane.metrics?.footprintBytes ?? 0
  const showMem = pane.kind === 'term' && mem >= 200 * 1024 * 1024

  return (
    <div
      className={
        'pane' +
        (focused ? ' pane--focused' : '') +
        (hidden ? ' pane--hidden' : '') +
        (pane.kind !== 'term' ? ' pane--preview' : '')
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
        <span className="pane__label" title={pane.filePath ?? pane.url ?? pane.cwd}>
          {pane.label}
        </span>
        <span className="pane__badge">{badgeFor(pane)}</span>
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

      {pane.kind === 'term' && <TerminalBody {...props} />}

      {pane.kind === 'file' && pane.filePath && (
        <FilePreview
          path={pane.filePath}
          rawSource={pane.rawSource ?? false}
          onToggleRaw={props.onToggleRaw}
          findOpen={props.findOpen}
          findNonce={props.findNonce}
          findDirection={props.findDirection}
          onCloseFind={props.onCloseFind}
        />
      )}

      {pane.kind === 'web' && (
        <WebPreview
          url={pane.url ?? ''}
          onUrlChange={props.onUrlChange}
          onToast={props.onToast}
        />
      )}
    </div>
  )
}

function badgeFor(pane: PaneState): string {
  if (pane.kind === 'file') return 'file'
  if (pane.kind === 'web') return 'web'
  return pane.metrics?.foregroundProcess || (pane.command === 'zsh' ? 'zsh' : pane.command)
}

/**
 * The PTY-backed body of a terminal pane. Split out from PaneView so that the
 * terminal's effects only exist for terminal panes — hooks cannot be
 * conditional, so a preview pane rendering through the same component would
 * still run (and have to defend against) every terminal effect.
 */
function TerminalBody(props: PaneViewProps): React.JSX.Element {
  const { pane, focused, hidden, rect } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const revealRef = useRef(props.onReveal)
  revealRef.current = props.onReveal
  const spawnedRef = useRef(props.onSpawned)
  spawnedRef.current = props.onSpawned

  const generation = pane.generation ?? 0

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const t = new PaneTerminal({
      paneId: pane.id,
      container: host,
      fontSize: props.fontSize,
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
    const key = genKey(pane.id, generation)
    if (!spawned.has(key)) {
      spawned.add(key)
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
            spawnedRef.current(res.pid)
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
            spawned.delete(key)
            t.write(`\r\n\x1b[31mFailed to start shell: ${res.code} — ${res.message}\x1b[0m\r\n`)
          }
        })
    }

    return () => {
      terminals.delete(pane.id)
      t.dispose()
    }
    // Re-runs on restart (generation), never on an ordinary prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, generation])

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
    if (hidden) return
    terminals.get(pane.id)?.setFontSize(props.fontSize)
  }, [pane.id, hidden, props.fontSize])

  useEffect(() => {
    // Focusing the terminal while the find bar is open would steal every
    // keystroke the user is trying to type into the query field.
    if (!focused || hidden || props.findOpen) return
    terminals.get(pane.id)?.term.focus()
  }, [focused, hidden, pane.id, props.findOpen])

  useEffect(() => {
    if (pane.status === 'exited') terminals.get(pane.id)?.markExited()
  }, [pane.status, pane.id])

  return (
    <>
      {props.findOpen && (
        <FindBar
          targetKey={pane.id}
          nonce={props.findNonce}
          nonceDirection={props.findDirection}
          onSearch={(q, dir) => {
            const t = terminals.get(pane.id)
            if (!t) return false
            return dir === 'next' ? t.findNext(q) : t.findPrevious(q)
          }}
          onClose={() => {
            terminals.get(pane.id)?.clearSearch()
            props.onCloseFind()
          }}
        />
      )}

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
    </>
  )
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}
