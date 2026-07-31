# SeaShell

A terminal window manager for macOS. Run many shells side by side in one window — plain
`zsh`, a dev server, or several AI coding agents — and keep a file explorer next to them.

> **Status: pre-alpha.** Under active development. Not yet packaged for general use.

## Why

Terminal multiplexers make you choose. `tmux` and `zellij` are excellent but live inside a
single terminal window and bring their own keybinding grammar. Tabbed terminal emulators give
you tabs but only ever show you one thing at a time.

SeaShell is built around a narrower goal: **watch several long-running sessions at once**, and
work with the files they mention without leaving the window.

## What it does

- **Tiled panes.** Each tab holds an auto-arranged grid of terminals — 1, then 2 side by side,
  then quadrants. Drag the borders to resize. Double-click a pane's title bar to zoom it to
  full tab, again to restore.
- **Any command per pane.** A pane is just a PTY. Run `zsh`, a build watcher, an SSH session,
  or a coding agent. Full-screen TUI programs render exactly as they do in a native terminal —
  alternate screen buffer, 24-bit color, correct glyph widths.
- **Built-in file explorer.** A lazy-loaded tree beside the panes. Drag a file into a terminal
  to paste its quoted path.
- **Paths become clickable.** Any filesystem path printed in a pane is detected and verified
  against disk. Double-click it and the explorer expands to that file and highlights it —
  nothing is opened behind your back. Opening is a separate, deliberate act from the tree.
- **Resource visibility.** Each pane reports the memory of its whole process subtree, and panes
  sitting idle say so. Long-lived agent sessions are easy to forget; this makes them visible.

## Design

The full design specification lives in
[`docs/superpowers/specs/`](docs/superpowers/specs/). It covers the layout engine, PTY
lifecycle, path detection, IPC contract, security posture, and build pipeline in enough detail
to implement from.

## Building

Requires macOS, Node 20+, and Xcode command line tools.

```bash
npm install
npm run dev      # run from source
npm run build    # produce SeaShell.app
```

Universal (Intel + Apple Silicon) builds are produced by CI. Building the arm64 slice locally
from an Intel host requires cross-compiling the `node-pty` native module; see the build section
of the design spec.

## Non-goals

SeaShell deliberately does not do these things:

- **Edit files.** The built-in viewer is read-only. Use your editor.
- **Manage remote sessions.** No SSH profile management, no session persistence across reboots.
- **Support Windows or Linux.** macOS only.
- **Plugins or theming.** No extension API, no theme editor.

## License

[Apache-2.0](LICENSE).
