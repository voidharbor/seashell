import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { FALLBACK_FONT_SIZE, FONT_FAMILY, FONT_SIZE, TERMINAL_APP_PALETTE } from './palette.js'

/**
 * One xterm.js terminal bound to one PTY.
 *
 * Every option here is a fidelity requirement, not a preference. The goal is
 * that a full-screen TUI running in a SeaShell pane is pixel-identical to the
 * same program in Apple Terminal.
 */
export interface PaneTerminalOptions {
  paneId: string
  container: HTMLElement
  /** Called with user keystrokes destined for the PTY. */
  onInput: (data: string) => void
  /** Debounced, deduplicated PTY resize. */
  onResize: (cols: number, rows: number) => void
  /**
   * A double-click that this pane did NOT forward to the PTY. The host resolves
   * it against the buffer to decide whether a path was clicked.
   */
  onDoubleClick: (clientX: number, clientY: number) => void
  /** OSC 8 hyperlink activation. Only ever http/https. */
  onHttpLink: (url: string) => void
}

const RESIZE_DEBOUNCE_MS = 80

export class PaneTerminal {
  readonly term: Terminal
  readonly fit: FitAddon
  private webgl: WebglAddon | null = null
  private webglLossCount = 0
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private lastSent: { cols: number; rows: number } | null = null
  private disposed = false

  constructor(private readonly opts: PaneTerminalOptions) {
    this.term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: fontLoaded ? FONT_SIZE : FALLBACK_FONT_SIZE,
      lineHeight: 1,
      letterSpacing: 0,

      // The single most important flag. Vector-draws all 128 box-drawing
      // codepoints, block elements and Powerline glyphs at exact cell bounds —
      // including the rounded corners TUIs draw their panels with. Without it
      // you get 1px gaps in every border. WebGL renderer only.
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,

      cursorStyle: 'block',
      cursorBlink: true,
      cursorInactiveStyle: 'outline',

      // Matches this machine's default Terminal profile (UseBrightBold=false).
      drawBoldTextInBrightColors: false,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,

      // MANDATORY. The default is true, and an Option-click with an empty
      // selection injects a burst of arrow-key bytes into the PTY — which lands
      // in whatever input box the foreground program is showing.
      altClickMovesCursor: false,

      // 1 means "do nothing". Any other value silently alters the program's
      // chosen colors, which is a fidelity violation.
      minimumContrastRatio: 1,

      scrollback: 5000,
      smoothScrollDuration: 0,
      allowTransparency: false,
      allowProposedApi: true,
      theme: TERMINAL_APP_PALETTE,

      linkHandler: {
        activate: (_e, uri) => {
          if (/^https?:\/\//i.test(uri)) this.opts.onHttpLink(uri)
        },
      },
    })

    const unicode11 = new Unicode11Addon()
    this.term.loadAddon(unicode11)
    this.term.unicode.activeVersion = '11'

    this.fit = new FitAddon()
    this.term.loadAddon(this.fit)

    this.term.open(this.opts.container)
    this.attachKeyHandler()

    this.term.onData((d) => this.opts.onInput(d))
    this.term.onResize(({ cols, rows }) => this.scheduleResize(cols, rows))

    this.term.element?.addEventListener('dblclick', this.handleDoubleClick)

    this.warnOnBadFontResidual()
  }

  /**
   * Shift+Enter must send ESC CR. That is the binding a coding agent's own
   * terminal-setup would install for multi-line input; installing it here means
   * such tools work with zero setup and without SeaShell ever rewriting the
   * user's real Terminal.app preferences.
   *
   * Cmd chords are swallowed so they reach the application menu instead of the
   * PTY. Cmd+A is the exception xterm handles natively (select all).
   */
  private attachKeyHandler(): void {
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
        this.opts.onInput('\x1b\r')
        return false
      }
      if (ev.metaKey && ev.key !== 'a') return false
      return true
    })
  }

  /**
   * Double-click resolution.
   *
   * When the foreground program has mouse tracking on, xterm forwards clicks to
   * the PTY and we must not steal them — otherwise a TUI's own click handling
   * breaks. We only claim the double-click when mouse reporting is OFF.
   *
   * The caller decides what a path activation means; per the design it reveals
   * the file in the explorer rather than opening it, so a stray double-click can
   * never launch an application.
   */
  private handleDoubleClick = (ev: MouseEvent): void => {
    if (this.mouseReportingActive()) return
    this.opts.onDoubleClick(ev.clientX, ev.clientY)
  }

  /**
   * xterm exposes no public "is mouse tracking on" flag. The modes live on the
   * private core. Reading it defensively is still far better than the
   * alternative of unconditionally stealing double-clicks from every TUI.
   */
  private mouseReportingActive(): boolean {
    const core = (this.term as unknown as { _core?: { coreMouseService?: { activeProtocol?: string } } })
      ._core
    const proto = core?.coreMouseService?.activeProtocol
    return typeof proto === 'string' && proto !== 'NONE'
  }

  /** WebGL is loaded only for visible panes — Chromium force-loses contexts past ~16. */
  enableWebgl(): void {
    if (this.disposed || this.webgl || this.webglLossCount >= 2) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        this.webglLossCount += 1
        this.disableWebgl()
        // One retry. A second loss means this pane stays on the DOM renderer.
        if (this.webglLossCount < 2) setTimeout(() => this.enableWebgl(), 1000)
      })
      this.term.loadAddon(addon)
      this.webgl = addon
    } catch {
      // DOM renderer takes over transparently. Borders will show hairline gaps
      // because customGlyphs is WebGL-only, but the pane stays usable.
      this.webgl = null
    }
  }

  disableWebgl(): void {
    this.webgl?.dispose()
    this.webgl = null
  }

  /**
   * Resize order is fixed: xterm first, PTY second. Identical dimensions are
   * skipped — BSD's ttioctl compares winsize before signalling, so a redundant
   * call delivers no SIGWINCH, but skipping keeps the intent explicit.
   */
  private scheduleResize(cols: number, rows: number): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      if (this.disposed) return
      if (this.lastSent && this.lastSent.cols === cols && this.lastSent.rows === rows) return
      this.lastSent = { cols, rows }
      this.opts.onResize(cols, rows)
    }, RESIZE_DEBOUNCE_MS)
  }

  /** Only ever called for visible panes — see the note on zoom in the design. */
  refit(): void {
    if (this.disposed) return
    try {
      this.fit.fit()
    } catch {
      /* container not laid out yet */
    }
  }

  /**
   * Raw bytes, never a decoded string. Decoding in main would corrupt
   * multi-byte UTF-8 sequences split across reads, which is the single most
   * likely source of TUI rendering artifacts.
   */
  write(data: string | Uint8Array): void {
    if (!this.disposed) this.term.write(data)
  }

  markExited(): void {
    this.term.options.disableStdin = true
    this.term.options.cursorBlink = false
  }

  private warnOnBadFontResidual(): void {
    const cw = (
      this.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } } }
    )._core?._renderService?.dimensions?.css?.cell?.width
    if (typeof cw !== 'number') return
    const scaled = cw * window.devicePixelRatio
    const residual = scaled - Math.floor(scaled)
    if (residual > 0.15) {
      console.warn(
        `[seashell] cell width residual ${residual.toFixed(3)} at ${this.opts.paneId} — ` +
          `glyph alignment may drift; see the font-size note in palette.ts`
      )
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.term.element?.removeEventListener('dblclick', this.handleDoubleClick)
    this.disableWebgl()
    this.term.dispose()
  }
}

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

let fontLoaded = false

/**
 * Loads Terminal.app's own private monospace face at runtime.
 *
 * It is not registered system-wide, so CSS cannot reach it by name without
 * this. It is also the only monospace face shipped with macOS that carries
 * Powerline glyphs. Nothing is copied into the app bundle, so nothing is
 * redistributed.
 */
export async function loadTerminalFont(): Promise<boolean> {
  if (fontLoaded) return true
  try {
    const buf = await window.seashell.app.getTerminalFont?.()
    if (!buf) return false
    const face = new FontFace('SF Mono Terminal', buf)
    await face.load()
    document.fonts.add(face)
    fontLoaded = true
    return true
  } catch {
    return false
  }
}
