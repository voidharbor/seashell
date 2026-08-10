import { useEffect, useRef, useState } from 'react'
import { PaneTerminal } from '../term/terminal.js'
import { currentXtermTheme } from '../theme/live.js'
import { pathAtPoint } from '../panes/pathclick.js'
import { currentHostname, terminals } from '../panes/PaneView.js'
import { cdCommandFor } from './cd.js'
import { drawerPtyId } from './id.js'

/**
 * These ptys live in the same PtyManager map as the panes, so the quit drain
 * kills them like any other shell and nothing they started can outlive the
 * window — the promise the app is named for. They are NOT panes: never in a
 * tab's state, never saved into a project, never scanned by the Lookout
 * detector. Main has no idea the drawer exists, which is what made re-keying
 * these ids from one shared shell to one per pane safe.
 */

export interface DrawerShellProps {
  /** The pane this drawer belongs to. One shell per pane, so switching panes
   *  switches shells rather than sharing one across all of them. */
  paneId: string
  /** Shown in the header so it is obvious whose shell this is. */
  paneLabel: string
  open: boolean
  /** Base height in CSS px at zoom 1 (layout/drawer.ts owns the clamp). */
  height: number
  fontSize: number
  /** This pane's live cwd — where its drawer shell starts, and where the
   *  "cd to pane" button goes. */
  focusCwd: string
  /** Grid width in px; only watched so the terminal refits when it changes. */
  gridWidth: number
  onReveal(path: string, isDir: boolean): void
  onClose(): void
  onDragStart(e: React.MouseEvent): void
}

/**
 * A real shell in a drawer over the pane grid — the answer to "I just need to
 * run one command" that doesn't cost a pane (SEASHELL-2): the agent owns each
 * pane's pty, so a quick `git status` used to mean making (and then closing) a
 * whole new pane.
 *
 * **One shell per pane.** The first version shared a single shell across every
 * pane, which was the follow-up report: "it seems to be independent of the
 * selected pane, just one shell for all of them". Each pane now gets its own,
 * spawned lazily the first time you open the drawer while that pane is
 * focused, starting in that pane's working directory. Switching panes switches
 * shells, each keeping its own history, cwd and scrollback.
 *
 * One instance of this component is mounted per pane that has ever opened a
 * drawer, and all but the focused one are hidden with display:none — the same
 * technique pane zoom uses — so a shell survives both toggling the drawer and
 * switching away and back. Hidden instances are never refit (SIGWINCH
 * discipline, same as background panes) and hold no WebGL context.
 *
 * After the user exits a shell (`exit`, ctrl-d), the next open of that pane's
 * drawer builds a fresh terminal and spawns a fresh shell at the pane's
 * current cwd.
 *
 * Isolation rule (the constraint the feature ask came with): nothing here can
 * reach an agent's pty. Input is wired straight to this drawer's own pty id,
 * which is namespaced away from every pane id, and the one composed command
 * (`cd`, quoted and control-char-refused in cd.ts) is typed visibly into the
 * drawer itself, never into a pane.
 */
export function DrawerShell(props: DrawerShellProps): React.JSX.Element {
  /** Stable for this instance: app.tsx keys one DrawerShell per pane. */
  const ptyId = drawerPtyId(props.paneId)
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
      paneId: ptyId,
      theme: currentXtermTheme(),
      container: host,
      onInput: (data) => window.seashell.pty.write({ paneId: ptyId, data }),
      onResize: (cols, rows) => window.seashell.pty.resize({ paneId: ptyId, cols, rows }),
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
    terminals.set(ptyId, t)
    return () => {
      terminals.delete(ptyId)
      t.dispose()
    }
    // Recreated only after an exit (gen); font size is applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen, ptyId])

  // The drawer's own exit watch. The global onExit handler dispatches
  // pane.exited, which no-ops for an id no tab owns — this is the handler
  // that actually reacts for the drawer.
  useEffect(
    () =>
      window.seashell.pty.onExit((e) => {
        if (e.paneId !== ptyId) return
        spawnedRef.current = false
        exitedRef.current = true
        terminals.get(ptyId)?.markExited()
      }),
    [ptyId]
  )

  // Open/close: spawn if needed, refit + WebGL only while visible, focus.
  useEffect(() => {
    const t = terminals.get(ptyId)
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
          paneId: ptyId,
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
  }, [props.open, gen, ptyId])

  // Geometry and font follow the app; never refit while hidden.
  useEffect(() => {
    if (props.open) terminals.get(ptyId)?.refit()
  }, [props.open, props.height, props.gridWidth, ptyId])
  useEffect(() => {
    terminals.get(ptyId)?.setFontSize(props.fontSize)
  }, [props.fontSize, gen, ptyId])

  const cdToPane = (): void => {
    const cmd = cdCommandFor(props.focusCwd)
    if (!cmd) return
    // ctrl-U first: the prompt line may not be empty — half-typed input, or a
    // stray byte from a terminal-response race (observed once live: a lone "2"
    // turned the command into `2cd …`). Killing the line makes the write mean
    // "run this", not "append this to whatever was there".
    window.seashell.pty.write({ paneId: ptyId, data: `\x15${cmd}\r` })
    terminals.get(ptyId)?.term.focus()
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
        {/* Names the pane, because "which shell am I looking at" was the whole
            complaint that turned one shared shell into one per pane. */}
        <span className="drawer__label">Shell · {props.paneLabel}</span>
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
