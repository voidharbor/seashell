import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { FALLBACK_FONT_SIZE, FONT_FAMILY, FONT_SIZE, TERMINAL_APP_PALETTE } from './palette.js'
import { KILL_LINE, inputLineSelection, shouldKillLine } from './inputline.js'

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
  /** Terminal font size in px, from the current zoom level. */
  fontSize?: number
  /** OSC 0/2 title, as set by the running program. */
  onTitle?: (title: string) => void
}

const RESIZE_DEBOUNCE_MS = 80

export class PaneTerminal {
  readonly term: Terminal
  readonly fit: FitAddon
  readonly search: SearchAddon
  private webgl: WebglAddon | null = null
  private webglLossCount = 0
  /** True only between a ⌘A input-line select and the next keystroke. */
  private inputLineSelected = false
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private lastSent: { cols: number; rows: number } | null = null
  private disposed = false

  constructor(private readonly opts: PaneTerminalOptions) {
    this.term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: effectiveFontSize(opts.fontSize ?? FONT_SIZE),
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

    this.search = new SearchAddon()
    this.term.loadAddon(this.search)

    /**
     * Makes bare URLs in output clickable.
     *
     * `linkHandler` above only covers OSC 8 hyperlinks — escape sequences a
     * program emits to explicitly mark text as a link. The overwhelming majority
     * of URLs in a terminal are not that: they are plain text printed by a dev
     * server, a test runner or an error message, and without this addon they are
     * inert characters. This scans the rendered text for URLs and gives them a
     * real hover target.
     *
     * The activation handler re-checks the scheme rather than trusting the
     * addon's match, and hands off to the same guarded external-open path as
     * OSC 8 links, which refuses anything that is not http/https.
     */
    const webLinks = new WebLinksAddon((event, uri) => {
      // Ignore a click that is part of a text selection drag.
      if (event.type === 'click' && (event as MouseEvent).detail === 0) return
      if (/^https?:\/\//i.test(uri)) this.opts.onHttpLink(uri)
    })
    this.term.loadAddon(webLinks)

    this.term.open(this.opts.container)
    this.attachKeyHandler()

    this.term.onData((d) => this.opts.onInput(d))
    this.term.onTitleChange((t) => this.opts.onTitle?.(t))
    this.term.onResize(({ cols, rows }) => this.scheduleResize(cols, rows))

    // Both on the host in capture phase: the host is a strict ancestor of
    // term.element, so these are guaranteed to run before xterm's own handlers.
    this.opts.container.addEventListener('mousedown', this.handleOptionMouseDown, true)
    this.opts.container.addEventListener('dblclick', this.handleDoubleClick, true)

    this.warnOnBadFontResidual()
  }

  /**
   * Shift+Enter must send ESC CR. That is the binding a coding agent's own
   * terminal-setup would install for multi-line input; installing it here means
   * such tools work with zero setup and without SeaShell ever rewriting the
   * user's real Terminal.app preferences.
   *
   * Cmd chords are swallowed so they reach the application menu instead of the
   * PTY — including Cmd+A. xterm handles Cmd+A natively as "select the entire
   * buffer", and letting it through as well as the menu means both run: the
   * input line gets selected, then the whole scrollback is selected over the top
   * of it. The menu owns select-all, and it scopes to the line being typed.
   */
  private attachKeyHandler(): void {
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
        this.opts.onInput('\x1b\r')
        return false
      }
      // Cmd chords belong to the menu. Note this runs before the flag is
      // cleared below, so Cmd+A can set it without immediately clearing it.
      if (ev.metaKey) return false

      if (ev.type === 'keydown') {
        const kill = shouldKillLine({
          key: ev.key,
          inputLineSelected: this.inputLineSelected,
          mouseReporting: this.mouseReportingActive(),
          modified: ev.ctrlKey || ev.altKey,
        })

        // Any keystroke ends the "⌘A just selected your input" state — the
        // selection is only meaningful until the line changes.
        this.inputLineSelected = false

        if (kill) {
          this.term.clearSelection()
          this.opts.onInput(KILL_LINE)
          return false
        }
      }
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
    // With mouse tracking on, a plain double-click belongs to the program —
    // stealing it would break a TUI's own click handling. Option is the
    // documented escape hatch (§8.4), and it is the only way this feature works
    // at all inside an agent pane, which is precisely where paths get printed.
    if (this.mouseReportingActive() && !ev.altKey) return
    this.opts.onDoubleClick(ev.clientX, ev.clientY)
  }

  /**
   * Swallows the second press of an Option double-click before xterm forwards
   * it to the PTY. Without this the program still receives a click at that
   * position — so an agent would act on a click the user meant for SeaShell.
   *
   * Capture phase on the host, which is a strict ancestor of `term.element`, so
   * this runs before xterm's own bubble-phase mousedown handler.
   */
  private handleOptionMouseDown = (ev: MouseEvent): void => {
    if (ev.button !== 0 || !ev.altKey || ev.detail !== 2) return
    if (!this.mouseReportingActive()) return
    ev.preventDefault()
    ev.stopPropagation()
  }

  /**
   * xterm exposes no public "is mouse tracking on" flag. The modes live on the
   * private core. Reading it defensively is still far better than the
   * alternative of unconditionally stealing double-clicks from every TUI.
   */
  private mouseReportingActive(): boolean {
    // `term.modes.mouseTrackingMode` is public API and the right source. The
    // private core is kept only as a fallback, since reading it defensively is
    // still far better than the alternative of unconditionally stealing
    // double-clicks from every TUI.
    const mode = this.term.modes?.mouseTrackingMode
    if (typeof mode === 'string') return mode !== 'none'

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

  /**
   * Find-in-pane.
   *
   * The decoration colours are constrained by something the palette cannot
   * express: xterm lets a search decoration set the match *background* but not
   * its foreground, so every match keeps the program's own text colour — here,
   * Homebrew's bright green. That rules out the conventional bright-yellow
   * active-match highlight, which would leave green text on amber. Instead the
   * inactive matches reuse the theme's own selection green (already proven
   * readable against this foreground) and the active match uses a desaturated
   * slate that stays clearly distinguishable from it without fighting the text.
   */
  private static readonly SEARCH_DECORATIONS = {
    matchBackground: '#255A1E',
    activeMatchBackground: '#3C5A8A',
    matchOverviewRuler: '#28FE14',
    activeMatchColorOverviewRuler: '#8AB4F8',
  }

  findNext(query: string): boolean {
    if (this.disposed || !query) return false
    return this.search.findNext(query, {
      decorations: PaneTerminal.SEARCH_DECORATIONS,
      caseSensitive: false,
    })
  }

  findPrevious(query: string): boolean {
    if (this.disposed || !query) return false
    return this.search.findPrevious(query, {
      decorations: PaneTerminal.SEARCH_DECORATIONS,
      caseSensitive: false,
    })
  }

  /**
   * ⌘A. Selects the line being typed rather than the whole scrollback.
   *
   * Falls back to selecting everything when there is no input to speak of, so
   * the shortcut always does something recognisable.
   */
  selectInputLine(): void {
    if (this.disposed) return
    const buf = this.term.buffer.active
    const sel = inputLineSelection({
      cursorRow: buf.baseY + buf.cursorY,
      cursorCol: buf.cursorX,
      cols: this.term.cols,
      isWrapped: (row) => buf.getLine(row)?.isWrapped ?? false,
    })

    if (!sel) {
      // Whole-buffer fallback: there is no input line, so Backspace must not
      // be reinterpreted as "kill the line".
      this.inputLineSelected = false
      this.term.selectAll()
      return
    }
    this.term.select(sel.col, sel.row, sel.length)
    this.inputLineSelected = true
  }

  clearSearch(): void {
    if (this.disposed) return
    this.search.clearDecorations()
    this.term.clearSelection()
  }

  /**
   * Live font-size change, used by the zoom commands.
   *
   * The refit is not optional. Changing the size changes the cell size, so the
   * same pixel box now holds a different number of columns and rows; without
   * refitting, xterm keeps the old grid and the child program keeps drawing to
   * a width that no longer matches the pane. refit() ultimately drives the PTY
   * resize through the normal debounced path, so the child gets one SIGWINCH.
   */
  setFontSize(px: number): void {
    if (this.disposed) return
    const next = effectiveFontSize(px)
    if (this.term.options.fontSize === next) return
    this.term.options.fontSize = next
    this.refit()
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
    this.search.dispose()
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.opts.container.removeEventListener('mousedown', this.handleOptionMouseDown, true)
    this.opts.container.removeEventListener('dblclick', this.handleDoubleClick, true)
    this.disableWebgl()
    this.term.dispose()
  }
}

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

let fontLoaded = false

/**
 * The zoom ladder's sizes are chosen for SF Mono Terminal's advance width. If
 * that face could not be loaded we are rendering in Menlo, whose clean sizes
 * are different and whose glyphs read smaller at the same nominal size — so the
 * requested size is scaled by the same ratio the two defaults differ by, rather
 * than pinning the fallback to one fixed size and silently dropping zoom.
 */
export function effectiveFontSize(px: number): number {
  if (fontLoaded) return px
  return Math.max(8, Math.round((px * FALLBACK_FONT_SIZE) / FONT_SIZE))
}

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
