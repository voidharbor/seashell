import { Terminal, type IMarker, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { FALLBACK_FONT_SIZE, FONT_FAMILY, FONT_SIZE, TERMINAL_APP_PALETTE } from './palette.js'
import { KILL_LINE, inputLineSelection, shouldKillLine } from './inputline.js'
import { isLocalHost, parseOsc7 } from './osc7.js'
import { targetScrollLine } from './find-scroll.js'
import { anchorAction } from './find-anchor.js'
import { WheelRamp } from './wheel-ramp.js'

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
  /** The active theme's xterm colours. Defaults to Terminal.app's Homebrew. */
  theme?: ITheme
  /** OSC 0/2 title, as set by the running program. */
  onTitle?: (title: string) => void
  /** OSC 7 working directory, as reported by the shell on every prompt. */
  onCwd?: (cwd: string) => void
  /** This machine's hostname, so a remote shell's OSC 7 can be told apart from
   *  a local one. The app:// origin's hostname is "seashell", not the machine. */
  hostname?: string
}

/** How the find bar wants the next search run. */
export interface FindOptions {
  incremental: boolean
  caseSensitive: boolean
  regex: boolean
}

/**
 * The shipped addon reads a third positional argument, `{ noScroll }`, that its
 * published typings do not declare. It is not an `ISearchOptions` field, so it
 * cannot be passed in the options object. We own the scroll (see find-scroll.ts),
 * so anywhere we re-run a search on the user's behalf we suppress the addon's.
 */
type SearchWithNoScroll = (
  term: string,
  options: ISearchOptions,
  extra: { noScroll: boolean }
) => boolean

/** A search match pinned to the row it sits on. */
interface FindAnchor {
  /** Follows the row through scrollback trimming, and disposes itself when the
   *  row is trimmed away. */
  marker: IMarker
  col: number
  length: number
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

  /** The match the user last landed on. See keepAnchor(). */
  private anchor: FindAnchor | null = null
  /** The query and options behind that anchor, for re-running the search. */
  private lastFind: { query: string; opts: FindOptions } | null = null
  /** viewportY as of the last find, so a user scrolling away can be told apart
   *  from the addon's own scrolling. */
  private findViewportY = 0
  /** True while one of our own searches runs, so its results event is not
   *  mistaken for the addon's background refresh. */
  private searching = false
  private anchorSub: { dispose(): void } | null = null

  private readonly ramp = new WheelRamp()
  private appliedSensitivity = 1

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

      // 20,000 lines, fixed. xterm allocates each line at full width, so a
      // full buffer at 200 columns is ~48 MB per pane; chosen over 50,000 for
      // that reason.
      scrollback: 20_000,
      smoothScrollDuration: 0,

      /**
       * On, and measured rather than reasoned — the name is misleading here.
       *
       * With this off, the WebGL glyph atlas rasterizes each glyph onto an
       * opaque canvas filled with the cell's background colour and then runs
       * `clearColor()` to turn that background back into alpha. That pass does
       * not only clear exact background pixels: it also zeroes every pixel
       * within `(|Δr| + |Δg| + |Δb|) / 12` of it. For this palette — #28FE14 on
       * #000000 — that threshold is 26, which deletes every antialiased edge
       * pixel below roughly 8% coverage. That faint tail is precisely what
       * makes a curve read as a curve rather than as a staircase.
       *
       * Measured in the running app on a 1x display, as the share of a pane's
       * inked pixels that are faint (sub-12%-coverage) edge pixels:
       *
       *   Apple Terminal, the fidelity target      9.6%
       *   allowTransparency: true                 14.6%
       *   allowTransparency: false                 4.9%   <- what shipped
       *
       * This is the second half of the fix; the first is the font-smoothing
       * note in styles.css, which mattered more. Together they take a pane
       * from 8.5% of ink at full strength to 31.8%, against Terminal's 27.5%.
       *
       * On, the atlas skips clearColor entirely and keeps the whole alpha ramp.
       * It costs nothing measurable: writing 1,200 lines of 110 varied
       * characters went 14.6ms -> 15.8ms, and mean frame time did not move.
       *
       * Two things do change, both checked against every zoom rung:
       *  - An underline no longer breaks around a descender. The gap came from
       *    a background-coloured outline stroke that is only drawable on an
       *    opaque atlas. A continuous rule is what Terminal draws anyway.
       *  - xterm's rescue for an underscore that renders below its cell is
       *    skipped. Verified unnecessary for this face: `_` stays inside the
       *    cell at all eight ladder sizes, at both 1x and 2x.
       *
       * Nothing becomes see-through. What changes is *who paints the black*:
       * xterm stops baking the cell background into the atlas and leaves
       * default-background cells to the element underneath, so every element
       * hosting a terminal must paint --term-bg itself. .pane__term and
       * .drawer__term do, and term-surface.test.ts holds them to it — without
       * that, the drawer's terminal composites over --chrome-bg and reads
       * green-tinted instead of black.
       */
      allowTransparency: true,
      allowProposedApi: true,
      theme: opts.theme ?? TERMINAL_APP_PALETTE,

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

    // Registered here, before any find bar subscribes, so the match is put back
    // before anything downstream reads the result. See keepAnchor().
    this.anchorSub = this.search.onDidChangeResults(() => this.keepAnchor())

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

    /**
     * OSC 7 — the shell reporting where it is.
     *
     * Registered here rather than inferred elsewhere because this is the only
     * authoritative source: `ps` gives a pane's process cwd but not the shell's
     * own notion of it, and nothing else survives a `cd` inside a subshell.
     * Returning true marks the sequence handled so it is not also written to
     * the screen as garbage.
     *
     * A remote host is ignored on purpose. An SSH session inside a pane reports
     * paths that exist on the far side, and resolving a local click against
     * those points the explorer somewhere meaningless — or somewhere real and
     * unrelated, which is worse.
     */
    this.term.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7(data)
      if (cwd && isLocalHost(data, this.opts.hostname ?? '')) {
        this.opts.onCwd?.(cwd)
      }
      return true
    })

    this.term.onData((d) => this.opts.onInput(d))
    this.term.onTitleChange((t) => this.opts.onTitle?.(t))
    this.term.onResize(({ cols, rows }) => {
      // A resize moves the viewport without the user having scrolled, and it is
      // one of the two things that makes the search addon re-run itself. Without
      // this, a pinned match pushed off screen by a resize reads as one the user
      // deliberately scrolled away from and never comes back.
      this.findViewportY = this.term.buffer.active.viewportY
      this.scheduleResize(cols, rows)
    })

    // Both on the host in capture phase: the host is a strict ancestor of
    // term.element, so these are guaranteed to run before xterm's own handlers.
    this.opts.container.addEventListener('mousedown', this.handleMouseDown, true)
    this.opts.container.addEventListener('dblclick', this.handleDoubleClick, true)
    this.opts.container.addEventListener('wheel', this.handleWheel, { capture: true, passive: true })

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
        /**
         * `preventDefault` is load-bearing, and its absence is why this
         * binding did not work.
         *
         * Returning false makes xterm return early from its own keydown
         * handler, but xterm does NOT call preventDefault for you — see
         * CoreBrowserTerminal `_keyDown`, which simply `return false`s. The
         * browser then goes on to deliver the same Enter to xterm's hidden
         * textarea, and a second CR reaches the pty behind the escape
         * sequence.
         *
         * Captured off a real pane, `cat` receiving the raw bytes (the tty
         * turns CR into LF on input):
         *
         *   Shift+Enter   1b 0a 0a      <- ESC CR, then a stray CR
         *   Alt+Enter     1b 0a
         *   Enter         0a
         *
         * A coding agent reads that pair as "insert a newline, then submit",
         * so Shift+Enter sent the message instead of adding a line — while
         * Alt+Enter, which xterm encodes itself and which therefore has no
         * duplicate, worked. That is exactly the difference a user would
         * report as "shift-return does not work here but alt-return does".
         *
         * Deliberately not added to the other two `return false` branches
         * below: both WANT the default. The Cmd chord branch needs the
         * browser's own copy/paste on the textarea, and the kill-line branch
         * sends Ctrl+U in place of an erase the program may not honour.
         */
        ev.preventDefault()
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
   * This used to bail out whenever the foreground program had mouse tracking
   * on, to avoid "stealing" the click from a TUI. That reasoning was wrong, and
   * it disabled the feature exactly where it matters most.
   *
   * By the time a `dblclick` fires, xterm has already forwarded both mousedown
   * events to the PTY. The program has its clicks either way — there is nothing
   * left to steal. All the guard did was suppress the reveal, in agent panes,
   * which is precisely where paths get printed. Requiring Option there was a
   * workaround for a problem that did not exist.
   *
   * So the double-click is always offered to the host. The host resolves it
   * against the buffer and reveals only if a real path is under the cursor;
   * a double-click on ordinary text resolves to nothing and changes nothing.
   *
   * Revealing never opens anything, so even a wrong guess is inert.
   */
  private handleDoubleClick = (ev: MouseEvent): void => {
    this.claimDoubleClick(ev)
  }

  /**
   * Single entry point for "the user double-clicked at this point".
   *
   * Called from two different events on purpose. A `dblclick` listener alone is
   * not reliable here: when a program has claimed the mouse, xterm calls
   * `preventDefault()` on mousedown to forward the click to the PTY, and a
   * defaulted-prevented mousedown can stop the browser synthesising `dblclick`
   * at all. The handler then never runs — which looks exactly like "double
   * clicking a path does nothing", regardless of what the handler would have
   * done.
   *
   * `mousedown` with `detail === 2` is the event that definitely arrives; it is
   * already how the Option-click path works. Listening to both and de-duplicating
   * means the feature does not depend on which of them the browser decides to
   * deliver.
   */
  private lastClaim = { x: -1, y: -1, at: -1 }

  private claimDoubleClick(ev: MouseEvent): void {
    if (this.disposed) return

    // The two events describe the same physical gesture, microseconds and a
    // pixel or two apart. Collapse them so a path is not revealed twice.
    const now = Date.now()
    const near =
      Math.abs(ev.clientX - this.lastClaim.x) < 4 && Math.abs(ev.clientY - this.lastClaim.y) < 4
    if (near && now - this.lastClaim.at < 500) return
    this.lastClaim = { x: ev.clientX, y: ev.clientY, at: now }

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
  private handleMouseDown = (ev: MouseEvent): void => {
    if (ev.button !== 0 || ev.detail !== 2) return

    // The reliable half of double-click detection. Runs in capture phase on an
    // ancestor of term.element, so it happens before xterm can preventDefault
    // this event and suppress the dblclick that would otherwise follow.
    this.claimDoubleClick(ev)

    // Option is still the way to keep the second press away from the program:
    // without this the PTY also receives a click at that position, so an agent
    // would act on a click the user meant for SeaShell. A plain double-click is
    // deliberately left to pass through — the program is entitled to it, and
    // revealing a path alongside costs it nothing.
    if (ev.altKey && this.mouseReportingActive()) {
      ev.preventDefault()
      ev.stopPropagation()
    }
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

  find(query: string, direction: 'next' | 'prev', opts: FindOptions): boolean {
    if (this.disposed) return false
    if (!query) {
      // The query went empty, so the pin has to go and so does the addon's own
      // background refresh. That refresh keeps firing on every write for as long
      // as the addon holds a cached term, and would go on re-selecting the stale
      // match through keepAnchor(). clearSearch() drops the cached term along
      // with the decorations and the selection.
      this.clearSearch()
      return false
    }
    const o = this.searchOptions(opts)
    let ok: boolean
    this.searching = true
    try {
      ok = direction === 'next' ? this.search.findNext(query, o) : this.search.findPrevious(query, o)
    } catch (err) {
      // An unfinished regex ("[" while typing) throws inside the addon. Any
      // other throw is a wiring bug here and must stay visible.
      if (!opts.regex) throw err
      this.clearAnchor()
      return false
    } finally {
      this.searching = false
    }
    if (!ok) {
      this.clearAnchor()
      return false
    }
    this.lastFind = { query, opts }
    this.scrollSelectionIntoView()
    this.setAnchor()
    return true
  }

  private searchOptions(opts: FindOptions): ISearchOptions {
    return {
      decorations: PaneTerminal.SEARCH_DECORATIONS,
      caseSensitive: opts.caseSensitive,
      regex: opts.regex,
      incremental: opts.incremental,
    }
  }

  private scrollSelectionIntoView(): void {
    const pos = this.term.getSelectionPosition()
    if (!pos) return
    const target = targetScrollLine(pos.start.y, this.term.buffer.active.viewportY, this.term.rows)
    if (target !== null) this.term.scrollToLine(target)
  }

  /**
   * Pin the match the user just landed on.
   *
   * A marker is the only handle that survives the buffer moving underneath it:
   * its `line` follows the row as scrollback is trimmed, and it disposes itself
   * once the row falls off the top.
   */
  private setAnchor(): void {
    this.clearAnchor()
    const pos = this.term.getSelectionPosition()
    if (!pos) return
    const buf = this.term.buffer.active
    const marker = this.term.registerMarker(pos.start.y - (buf.baseY + buf.cursorY))
    if (!marker) return
    this.anchor = {
      marker,
      col: pos.start.x,
      length: (pos.end.y - pos.start.y) * this.term.cols + (pos.end.x - pos.start.x),
    }
    this.findViewportY = buf.viewportY
  }

  private clearAnchor(): void {
    this.anchor?.marker.dispose()
    this.anchor = null
  }

  /**
   * Put the user's match back after the addon's background refresh moved it.
   *
   * The addon re-runs its own search 200ms after any pty write. That refresh
   * drops its cached term first, so it normally re-finds the match sitting under
   * the current selection. But if anything cleared the selection in between, a
   * keystroke into the pane or a program repainting, it has nothing to work from
   * and searches backwards from the bottom of the buffer instead, landing on the
   * last match in the scrollback with scrolling suppressed. The user's match is
   * then gone with nothing to bring it back.
   */
  private keepAnchor(): void {
    if (this.disposed || this.searching) return
    const a = this.anchor
    const pos = this.term.getSelectionPosition()
    const buf = this.term.buffer.active
    const action = anchorAction({
      anchor: a ? { line: a.marker.line, col: a.col, disposed: a.marker.isDisposed } : null,
      selection: pos ? { line: pos.start.y, col: pos.start.x } : null,
      viewportY: buf.viewportY,
      findViewportY: this.findViewportY,
      rows: this.term.rows,
    })
    if (!action.restore || !a) return
    this.restoreAnchor(a, action.scroll)
  }

  private restoreAnchor(a: FindAnchor, scroll: boolean): void {
    const row = a.marker.line
    const last = this.lastFind
    this.searching = true
    try {
      this.term.select(a.col, row, a.length)
      // Re-running the search now re-attaches the active-match decoration and
      // the result index to this row. It lands back here rather than stepping
      // on: the addon fires its results event from inside the refresh, before it
      // restores its cached term, so a search issued from this handler starts at
      // the selection we just made instead of at its end. find-anchor.test.ts
      // pins both halves of that against the shipped addon.
      if (last) {
        const findNext = this.search.findNext.bind(this.search) as unknown as SearchWithNoScroll
        try {
          findNext(last.query, this.searchOptions({ ...last.opts, incremental: true }), {
            noScroll: true,
          })
        } catch (err) {
          // Same rule as find(): only an unfinished regex is swallowed.
          if (!last.opts.regex) throw err
        }
      }
    } finally {
      this.searching = false
    }

    const now = this.term.getSelectionPosition()
    if (!now || now.start.y !== row || now.start.x !== a.col) {
      // The row no longer holds the match, so the program has repainted over it.
      // Stop pinning rather than dragging the selection back forever.
      this.clearAnchor()
      return
    }
    if (scroll) {
      this.scrollSelectionIntoView()
      this.findViewportY = this.term.buffer.active.viewportY
    }
  }

  /**
   * The addon's result counts, as the find bar's counter.
   *
   * A restore fires a second event from inside the first, and the emitter
   * behind this drains the event already in flight before delivering the new
   * one, so a subscriber sees the wandering match's index and then the corrected
   * one. Last write wins, which is the right way round. Measured live on a pane
   * printing continuously: `165 of 165` immediately followed by `1 of 165`.
   */
  onSearchResults(cb: (r: { resultIndex: number; resultCount: number }) => void): () => void {
    const d = this.search.onDidChangeResults(cb)
    return () => d.dispose()
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
    this.clearAnchor()
    this.lastFind = null
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
  /**
   * Repaint in a new palette. Existing scrollback re-renders in the new
   * colours and nothing reflows, because only the colour table changed.
   */
  setTheme(theme: ITheme): void {
    if (this.disposed) return
    this.term.options.theme = theme
  }

  setFontSize(px: number): void {
    if (this.disposed) return
    const next = effectiveFontSize(px)
    if (this.term.options.fontSize === next) return
    this.term.options.fontSize = next
    this.refit()
  }

  /**
   * Measures only; never preventDefault. xterm keeps handling the wheel event
   * and reads scrollSensitivity live, so raising it here is all the ramp needs.
   * Forced back to 1x in the alternate buffer (less, vim: wheel becomes arrow
   * keys) and when a program has mouse tracking on (xterm hands it the event).
   */
  private handleWheel = (ev: WheelEvent): void => {
    if (this.disposed) return
    let mult = this.ramp.feed(ev.deltaY, ev.deltaMode, performance.now())
    if (this.term.buffer.active.type === 'alternate' || this.term.modes.mouseTrackingMode !== 'none') {
      mult = 1
    }
    this.applySensitivity(mult)
  }

  private applySensitivity(mult: number): void {
    const changed = mult === 1 ? this.appliedSensitivity !== 1 : Math.abs(mult - this.appliedSensitivity) >= 0.25
    if (!changed) return
    this.appliedSensitivity = mult
    this.term.options.scrollSensitivity = mult
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
    this.anchorSub?.dispose()
    this.anchorSub = null
    this.clearAnchor()
    this.search.dispose()
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.opts.container.removeEventListener('mousedown', this.handleMouseDown, true)
    this.opts.container.removeEventListener('dblclick', this.handleDoubleClick, true)
    this.opts.container.removeEventListener('wheel', this.handleWheel, true)
    this.applySensitivity(1)
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
 * The declared weight range. Without it, bold text was not bold.
 *
 * `SFMono-Terminal.ttf` is a two-axis variable font: `wght` runs 294.673–900
 * (default 294.673, the `Light` position — `name` ID 2 is literally "Light"),
 * and the named instances put `Regular` at 400 and `Bold` at 683.29.
 *
 * `new FontFace(family, buf)` with no descriptor object declares a weight
 * capability of `normal`, i.e. 400 alone. A request for 700 is then clamped
 * back into that range and never reaches the Bold cut.
 *
 * What that actually cost, measured in the app by rasterizing a stem-heavy
 * sample into a 2D canvas and summing coverage:
 *
 *                        no descriptor    weight: '295 900'
 *   font-weight normal        102,746          102,746
 *   font-weight bold          103,661          138,190
 *
 * So normal text was never the problem — Chromium maps the CSS font-weight
 * onto the registered `wght` axis whatever the descriptor says, and 400 was
 * already 400. Bold was the problem: it landed within 1% of normal weight.
 * Claude Code uses bold constantly, so most of what it emphasised was not
 * visibly emphasised at all.
 *
 * Note that `document.fonts.check('bold 13px "SF Mono Terminal"')` returns
 * true in *both* columns above. It reports family availability, not whether
 * the weight was honoured, so it is useless as a guard here — which is why
 * the test asserts on the descriptor instead.
 *
 * Declaring the range cannot move any cell: the advance is invariant across
 * the axis, 1266/2048 = 0.618164 em at Light, at 400 and at Bold alike. That
 * is the same advance the residual ladder in zoom.ts and palette.ts is built
 * on.
 *
 * `YAXS`, the second axis, is deliberately left alone. It is not
 * CSS-registered, so reaching it means a blanket `font-variation-settings`,
 * which would override the property-derived value for bold cells too and pin
 * them away from the real Bold instance's 335.84 — a new fidelity error at
 * exactly the weight this fix exists to correct, in exchange for 0.058px on a
 * horizontal hairline.
 *
 * This is what §4.2 and hazard row 11 of the design spec asked for.
 */
const TERMINAL_FONT_WEIGHTS = '295 900'

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
    const face = new FontFace('SF Mono Terminal', buf, {
      weight: TERMINAL_FONT_WEIGHTS,
      style: 'normal',
    })
    await face.load()
    document.fonts.add(face)
    fontLoaded = true
    return true
  } catch {
    return false
  }
}
