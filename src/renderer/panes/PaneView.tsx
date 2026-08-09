import { useEffect, useRef, useState } from 'react'
import { PaneTerminal } from '../term/terminal.js'
import { pathAtPoint } from './pathclick.js'
import { WebPreview } from './WebPreview.js'
import { ColorDot, ColorPicker } from './ColorPicker.js'
import { paneColorHex, type PaneColorKey } from './colors.js'
import { FilePreview } from '../viewer/FilePreview.js'
import { launchCommandText } from '../projects/serialize.js'
import { FindBar } from '../find/FindBar.js'
import type { PaneState } from '../store.js'
import { zoomPercent } from '../term/zoom.js'

/** Live terminals by pane id, so incoming PTY batches can be routed without
 *  every pane holding its own IPC subscription. */
export const terminals = new Map<string, PaneTerminal>()

/** This machine's hostname, set once at boot. Used to tell a local shell's OSC 7
 *  working directory from one reported by an SSH session inside a pane. */
let hostname = ''
export function setHostname(value: string): void {
  hostname = value
}
/** For terminals living outside a pane (the shell drawer), which mount after
 *  boot has already called setHostname — same value the panes read. */
export function currentHostname(): string {
  return hostname
}

/**
 * Re-fit every terminal that is actually on screen.
 *
 * Used by the device-pixel-ratio watcher, which has no React surface to hang a
 * per-pane effect on. A zero-size host is the test for "not visible" and it
 * covers both cases that matter: a pane hidden with `display: none` by zoom or
 * a background tab, and the collapsed shell drawer. Refitting either would
 * SIGWINCH a full-screen program into reflowing its whole UI for a size nobody
 * can see, which is the same reason the per-pane refit effect bails on
 * `hidden`.
 */
export function refitVisibleTerminals(): void {
  for (const t of terminals.values()) {
    const el = t.term.element
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) continue
    t.refit()
  }
}

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
  /** Set only when this pane overrides the global zoom; drives the badge. */
  zoomIndex?: number
  findOpen: boolean
  findNonce: number
  findDirection: 'next' | 'prev'
  onCloseFind: () => void
  onFocus: () => void
  onClose: () => void
  onZoom: () => void
  /** `isDir` decides whether the explorer opens the folder or merely selects it. */
  onReveal: (path: string, isDir: boolean) => void
  onSpawned: (pid: number) => void
  onRestart: () => void
  onUrlChange: (url: string) => void
  onToggleRaw: (raw: boolean) => void
  onSetColor: (color: PaneColorKey | null) => void
  onTitle: (title: string) => void
  onCwd: (cwd: string) => void
  /** Whether the attention pulse is enabled in settings. */
  glow: boolean
  onToast: (message: string) => void
}

export function PaneView(props: PaneViewProps): React.JSX.Element {
  const { pane, index, rect, focused, hidden } = props
  const [pickerOpen, setPickerOpen] = useState(false)

  const mem = pane.metrics?.footprintBytes ?? 0
  const showMem = pane.kind === 'term' && mem >= 200 * 1024 * 1024

  /**
   * A tagged pane keeps its colour on the border at all times, but only at full
   * strength when focused. Six panes all outlined in full-strength colour at
   * once would drown out the focus ring, which is the one border that has to
   * stay readable at a glance.
   */
  const accent = paneColorHex(pane.color)
  const paneStyle: React.CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  }
  if (accent) {
    paneStyle.borderColor = accent
    paneStyle.opacity = undefined
    // Consumed by the title bar's accent stripe in CSS.
    ;(paneStyle as Record<string, string>)['--pane-accent'] = accent
  }

  return (
    <div
      className={
        'pane' +
        (focused ? ' pane--focused' : '') +
        (hidden ? ' pane--hidden' : '') +
        (pane.kind !== 'term' ? ' pane--preview' : '') +
        (accent ? ' pane--tagged' : '') +
        (props.glow && !focused && pane.attention ? ` pane--attn-${pane.attention}` : '')
      }
      style={paneStyle}
      onMouseDown={props.onFocus}
    >
      <div
        className="pane__title"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.pane__close, .pane__dot')) return
          props.onZoom()
        }}
      >
        <span className="pane__index">{index}</span>
        <ColorDot color={pane.color} onClick={() => setPickerOpen((o) => !o)} />
        <span className="pane__label" title={pane.filePath ?? pane.url ?? pane.cwd}>
          {pane.label}
        </span>
        <span className="pane__badge">{badgeFor(pane)}</span>
        <span className="pane__spacer" />
        {/* Only when this pane differs from the global level — six panes all
            reading 100% would be noise, and the number is only interesting as a
            reminder that this one is deliberately out of step. */}
        {props.zoomIndex !== undefined && (
          <span className="pane__zoom" title="Pane text zoom (⌘+ / ⌘_). ⌘0 resets every pane.">
            {zoomPercent(props.zoomIndex)}%
          </span>
        )}
        {showMem && (
          <span className={'pane__mem' + (mem > 1e9 ? ' pane__mem--high' : '')}>
            ~{formatBytes(mem)}
          </span>
        )}
        <span className="pane__close" onClick={props.onClose} title="Close pane (⌘W)">
          ×
        </span>
      </div>

      {pickerOpen && (
        <ColorPicker
          current={pane.color}
          onPick={props.onSetColor}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {pane.kind === 'term' && <TerminalBody {...props} />}

      {pane.kind === 'file' && pane.filePath && (
        <FilePreview
          path={pane.filePath}
          paneId={pane.id}
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
  const titleRef = useRef(props.onTitle)
  titleRef.current = props.onTitle
  const cwdCbRef = useRef(props.onCwd)
  cwdCbRef.current = props.onCwd

  /**
   * The pane's live working directory, for resolving relative paths on
   * double-click. Read through a ref because the terminal is constructed once
   * and must not be rebuilt every time the user cd's. The monitor's cwd is
   * preferred over the spawn-time one — it is what the shell is actually in
   * now, which is the only directory a relative path in its output means
   * anything against.
   */
  const cwdRef = useRef(pane.cwd)
  cwdRef.current = pane.metrics?.cwd || pane.cwd

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
      onTitle: (title) => titleRef.current(title),
      hostname: hostname,
      onCwd: (cwd) => {
        // Keep the ref hot for the very next double-click, and push it into
        // pane state so the label and any project save see it too.
        cwdRef.current = cwd
        cwdCbRef.current(cwd)
      },
      /**
       * Resolve the candidate before revealing it.
       *
       * The tokenizer returns text exactly as it appeared on screen, and almost
       * everything a program prints is *relative* — `src/renderer/app.tsx:645`,
       * not an absolute path. Handing that straight to the explorer could never
       * work: the reveal walks parent directories while they still start with
       * the explorer root, and a relative string never does. It expanded
       * nothing, selected nothing, and looked exactly like a dead double-click.
       *
       * `statBatch` is the round trip built for this. It resolves the candidate
       * against the pane's current directory, follows symlinks to a canonical
       * path, and — the part that matters — omits anything that does not exist.
       * So a double-click on prose that merely looks like a path resolves to
       * nothing and stays silent, while a real file reveals.
       */
      onDoubleClick: (x, y) => {
        const candidate = pathAtPoint(t.term, x, y)
        if (!candidate) return
        void window.seashell.fs
          .statBatch({ cwd: cwdRef.current, candidates: [candidate] })
          .then((res) => {
            const hit = res.results[0]
            // `kind` is forwarded, not dropped. Without it the explorer cannot
            // tell a folder from a file, so a revealed directory was selected
            // and scrolled to but never actually opened.
            if (hit) revealRef.current(hit.resolved, hit.kind === 'dir')
          })
      },
    })
    terminals.set(pane.id, t)
    // WebGL is left to the visibility effect below, which owns it. Enabling
    // here as well would build a GPU context for every background tab's panes
    // at mount and tear it down again a moment later.
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
            // A restored claude pane types `claude -r <session-id>` — visible
            // on purpose, and fail-soft: a dead id leaves this same shell at
            // the saved cwd with the failed command on screen.
            {
              const text = launchCommandText(pane)
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

  /**
   * A hidden pane gives up its WebGL context and takes it back when shown.
   *
   * Every tab's panes stay mounted so their scrollback survives a tab switch,
   * which means the number of live terminals is now bounded by tabs × panes
   * rather than by one screenful. Chromium force-loses WebGL contexts past
   * roughly sixteen per page, and a forced loss is not free — it fires the
   * addon's context-loss path, which counts toward the two-strikes rule that
   * drops a pane to the DOM renderer permanently.
   *
   * Releasing deliberately while hidden keeps live contexts to what is actually
   * on screen. Nothing is lost by it: the buffer lives in xterm, not in the GPU
   * context, and a pane nobody can see does not need a renderer at all.
   */
  useEffect(() => {
    const t = terminals.get(pane.id)
    if (!t) return
    if (hidden) t.disableWebgl()
    else t.enableWebgl()
    // `generation` is not read in the body, and that is deliberate: a restart
    // disposes the old terminal and builds a new one without touching pane.id
    // or hidden, so without it here the replacement is never handed a WebGL
    // context. It runs on the DOM renderer instead — where customGlyphs does
    // nothing, so every TUI border grows 1px gaps — until the pane happens to
    // be hidden and shown again. That reads as an intermittent rendering
    // glitch, not as a restart bug, which is why it survived this long.
    // exhaustive-deps would class this as unnecessary and its autofix would
    // delete it, so it is spelled out rather than left to look like a slip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, generation, hidden])

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
