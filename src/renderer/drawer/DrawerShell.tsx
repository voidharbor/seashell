import { useEffect, useRef, useState } from 'react'
import { PaneTerminal } from '../term/terminal.js'
import { pathAtPoint } from '../panes/pathclick.js'
import { currentHostname, terminals } from '../panes/PaneView.js'
import { cdCommandFor } from './cd.js'

/**
 * The drawer's pty id. It lives in the same PtyManager map as the panes, so
 * the quit drain kills it like any other shell and no process it started can
 * outlive the window — the promise the app is named for. It is NOT a pane:
 * never in a tab's state, never saved into a project, never scanned by the
 * Lookout detector, and opening a project (which reaps every live pane) leaves
 * it running. One drawer per window, its session persisting across toggles.
 */
export const DRAWER_PANE_ID = 'drawer-shell'

export interface DrawerShellProps {
  open: boolean
  /** Base height in CSS px at zoom 1 (layout/drawer.ts owns the clamp). */
  height: number
  fontSize: number
  /** The focused pane's live cwd — where a fresh drawer shell starts, and
   *  where the "cd to pane" button goes. */
  focusCwd: string
  /** Grid width in px; only watched so the terminal refits when it changes. */
  gridWidth: number
  onReveal(path: string, isDir: boolean): void
  onClose(): void
  onDragStart(e: React.MouseEvent): void
}

/**
 * A real shell in a drawer over the pane grid — the answer to "I just need to
 * run one command" that doesn't cost a pane. Feature ask from Josh's dad
 * (SEASHELL-2): the agent owns each pane's pty, so a quick `git status` used
 * to mean making (and then closing) a whole new pane.
 *
 * The component stays mounted whatever `open` is, hidden with display:none —
 * the same technique pane zoom uses — so the shell session, its history and
 * its scrollback survive toggles. It is never refit while hidden (SIGWINCH
 * discipline, same as background panes) and WebGL is only held while visible.
 *
 * The shell is spawned lazily on first open, at the focused pane's cwd. After
 * the user exits it (`exit`, ctrl-d), the next open builds a fresh terminal
 * and spawns a fresh shell — which starts at the *now*-focused pane's cwd, so
 * an exited drawer follows focus again.
 *
 * Isolation rule (the constraint the feature ask came with): nothing here can
 * reach an agent's pty. Input is wired straight to DRAWER_PANE_ID and the one
 * composed command (`cd`, quoted and control-char-refused in cd.ts) is typed
 * visibly into the drawer itself, never into a pane.
 */
export function DrawerShell(props: DrawerShellProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const spawnedRef = useRef(false)
  const exitedRef = useRef(false)
  /** Bumped after an exited shell is reopened, to rebuild the terminal clean. */
  const [gen, setGen] = useState(0)
  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState('')
  const cwdRef = useRef('')
  const revealRef = useRef(props.onReveal)
  revealRef.current = props.onReveal

  // Terminal lifecycle. Registered in the shared `terminals` map, which is
  // what routes the global pty.onData dispatch (app.tsx) here for free.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const t = new PaneTerminal({
      paneId: DRAWER_PANE_ID,
      container: host,
      onInput: (data) => window.seashell.pty.write({ paneId: DRAWER_PANE_ID, data }),
      onResize: (cols, rows) => window.seashell.pty.resize({ paneId: DRAWER_PANE_ID, cols, rows }),
      onHttpLink: (url) => void window.seashell.open.externalHttp({ url }),
      onTitle: setTitle,
      hostname: currentHostname(),
      onCwd: (c) => {
        cwdRef.current = c
        setCwd(c)
      },
      // Same clickable-paths behaviour as a pane: resolve against the shell's
      // live cwd, reveal only what actually exists.
      onDoubleClick: (x, y) => {
        const candidate = pathAtPoint(t.term, x, y)
        if (!candidate) return
        void window.seashell.fs
          .statBatch({ cwd: cwdRef.current || props.focusCwd, candidates: [candidate] })
          .then((res) => {
            const hit = res.results[0]
            if (hit) revealRef.current(hit.resolved, hit.kind === 'dir')
          })
      },
    })
    terminals.set(DRAWER_PANE_ID, t)
    return () => {
      terminals.delete(DRAWER_PANE_ID)
      t.dispose()
    }
    // Recreated only after an exit (gen); font size is applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen])

  // The drawer's own exit watch. The global onExit handler dispatches
  // pane.exited, which no-ops for an id no tab owns — this is the handler
  // that actually reacts for the drawer.
  useEffect(
    () =>
      window.seashell.pty.onExit((e) => {
        if (e.paneId !== DRAWER_PANE_ID) return
        spawnedRef.current = false
        exitedRef.current = true
        terminals.get(DRAWER_PANE_ID)?.markExited()
      }),
    []
  )

  // Open/close: spawn if needed, refit + WebGL only while visible, focus.
  useEffect(() => {
    const t = terminals.get(DRAWER_PANE_ID)
    if (!props.open) {
      t?.disableWebgl()
      return
    }
    if (exitedRef.current) {
      // Reopened after the shell died: rebuild clean; this effect re-runs on
      // the new generation and spawns below.
      exitedRef.current = false
      setGen((g) => g + 1)
      return
    }
    if (!t) return
    t.refit()
    t.enableWebgl()
    if (!spawnedRef.current) {
      spawnedRef.current = true
      void window.seashell.pty
        .spawn({
          paneId: DRAWER_PANE_ID,
          file: '/bin/zsh',
          args: ['-l'],
          cwd: props.focusCwd,
          cols: t.term.cols,
          rows: t.term.rows,
        })
        .then((res) => {
          if (!res.ok) {
            spawnedRef.current = false
            t.write(`\r\n\x1b[31mFailed to start shell: ${res.code} — ${res.message}\x1b[0m\r\n`)
          }
        })
    }
    t.term.focus()
    // focusCwd is read at spawn time only — the drawer starting where focus
    // WAS when it first opened is the feature, not a stale dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, gen])

  // Geometry and font follow the app; never refit while hidden.
  useEffect(() => {
    if (props.open) terminals.get(DRAWER_PANE_ID)?.refit()
  }, [props.open, props.height, props.gridWidth])
  useEffect(() => {
    terminals.get(DRAWER_PANE_ID)?.setFontSize(props.fontSize)
  }, [props.fontSize, gen])

  const cdToPane = (): void => {
    const cmd = cdCommandFor(props.focusCwd)
    if (!cmd) return
    // ctrl-U first: the prompt line may not be empty — half-typed input, or a
    // stray byte from a terminal-response race (observed once live: a lone "2"
    // turned the command into `2cd …`). Killing the line makes the write mean
    // "run this", not "append this to whatever was there".
    window.seashell.pty.write({ paneId: DRAWER_PANE_ID, data: `\x15${cmd}\r` })
    terminals.get(DRAWER_PANE_ID)?.term.focus()
  }

  return (
    <div
      className="drawer"
      style={{
        display: props.open ? undefined : 'none',
        height: `calc(${props.height}px * var(--ui-scale))`,
      }}
    >
      <div
        className="drawer__grip"
        title="Drag to resize"
        onMouseDown={props.onDragStart}
      />
      <div className="drawer__head">
        <span className="drawer__label">Shell</span>
        <span className="drawer__cwd" title={cwd || props.focusCwd}>
          {title || cwd || props.focusCwd}
        </span>
        <span className="drawer__spacer" />
        {cwd !== '' && cwd !== props.focusCwd && (
          <button className="btn drawer__cd" title={props.focusCwd} onClick={cdToPane}>
            cd to pane
          </button>
        )}
        <button className="btn drawer__close" title="Hide shell (⌘J)" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <div ref={hostRef} className="drawer__term" />
    </div>
  )
}
