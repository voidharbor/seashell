# SeaShell renderer inventory, 2026-10-02

Produced on 10/02 by reading every file under `src/renderer` (67 files, 14,517 lines) plus `src/shared/ipc.ts` and `src/preload/index.ts`, with channel names confirmed against `src/main`. This is the scope document for the native shell (`2026-10-02-seashell-native-design.md`, section 3): every row below maps to a phase, and a row with no phase is a dropped feature. "Mac chord" means the macOS spelling; off the Mac, `src/shared/keys.ts:33` respells every chord: Cmd+X becomes Ctrl+Shift+X, Cmd+Shift+X becomes Ctrl+Alt+X, Cmd+Alt+X becomes Ctrl+Alt+Shift+X, and Cmd+, becomes Ctrl+,.

## 1. Feature inventory

### A. Boot and app shell

- While starting, the window shows "Starting SeaShell..." (app.tsx:1352).
- Boot order (app.tsx:328-365): load the terminal font, then getPaths, then set the hostname, then start the DPR watcher, then set the explorer root to home, then session.load. If a session is found the restore card is shown; otherwise one new tab is opened in home.
- The theme is applied before React renders, so the first paint is already themed (main.tsx:18-38).
- With no tabs open, the window shows "No tabs open" and a "New Tab (Cmd+T)" button (app.tsx:1700-1712).
- One toast at a time, bottom centre, cleared after 3.2 s (app.tsx:1255-1259, 1739). Main can also push a toast over app:toast (app.tsx:177).
- Window layout top to bottom: tab bar, then a body made of the sidebar column, its grip and the grid, then the update banner, then the status bar (app.tsx:1423-1805).

### B. Tabs (app.tsx:1436-1555, store.ts:337-412)

- Tab strip scrolls horizontally with the scrollbar hidden. Each tab is 100 to 220 px times the UI scale, name ellipsised (styles.css:217-259).
- Mousedown on a tab selects it (app.tsx:1443).
- Double-clicking a tab name opens an inline rename field (TabNameInput, app.tsx:1818-1859): max 40 characters (store.ts:161), opens with the text selected, Enter commits, Escape cancels, blur commits, a blank name reverts to the cwd-derived name (store.ts:393-400), tooltip "Double-click to rename".
- File, Rename Tab... opens the same inline field (app.tsx:948).
- The tab close "x" kills every term pane's pty, then removes the tab. If a preview pane in the tab has unsaved edits it asks first with window.confirm (app.tsx:434-457).
- The "+" button opens a new tab in home, not the active pane's cwd (app.tsx:1476-1484). Default tab name: "~" for home, "/" for root, otherwise the last path segment (store.ts:169).
- Closing the active tab activates the first remaining tab (store.ts:344-352).
- Cycling tabs wraps around. Tab N selection works for tabs 1 to 9 (store.ts:402-412).
- Every pane of every tab stays mounted. Inactive tabs are display:none, so their scrollback survives (app.tsx:1588-1680).

### C. Panes and layout (src/renderer/layout/*, store.ts:414-489, app.tsx:1209-1253)

- Max 6 panes per tab (layout/types.ts:107). The new-pane and web buttons dim to 0.4 opacity when the tab is full, tooltip "Tab is full (6 panes)" (app.tsx:1485-1502). Trying anyway toasts "Tab is full (6 panes) - open a new tab (Cmd+T)" (store.ts:418).
- The layout is a depth-3 tree: a row holds columns, a column holds panes, each level stores ratios (layout/types.ts).
- Auto-insert: target column count C* = ceil(sqrt(N)). Fewer columns than C*: a new column on the right. Otherwise the pane goes to the column with the fewest panes, rightmost on ties. In a pristine tab the column is split evenly; otherwise the existing panes are scaled down (layout/auto-arrange.ts:35-85).
- Rebalance (Cmd+Shift+R) rebuilds a canonical grid in DFS order and sets pristine back to true (auto-arrange.ts:95-122, store.ts:698).
- Closing a pane: ratios redistributed proportionally (tree.ts:108-127); a pristine tab also re-runs rebalance (store.ts:540-544); closing the last pane closes the tab; focus moves to the next pane in DFS order, or the previous one (store.ts:327-333).
- Dividers: 9 px hit strip with a 1 px visible line. Vertical dividers span the full height; horizontal ones sit inside a single column (layout/dividers.ts:51-98). The drag only changes the two neighbouring panes, clamped to minimums of 20 cols x 6 rows plus a 24 px title bar plus 12 px (dividers.ts:108-170, minimums.ts:15). Cursor col-resize or row-resize; body.dragging disables pointer events in webviews during the drag. Any drag marks the tab non-pristine (app.tsx:1223-1253).
- Layout uses water-filling: a pane below its minimum takes the deficit from siblings that have slack (layout/resize.ts:31-73, 105-146). Cell size is read from xterm's private render dimensions, falling back to 7.8 x 15 (app.tsx:1197-1207).
- Full-screen pane (Cmd+Return, or double-click a pane title bar) toggles zoomedPaneId. Other panes and dividers are hidden (store.ts:583-592, PaneView.tsx:178-181).
- Pane focus: mousedown anywhere in a pane focuses it (PaneView.tsx:174); focusing clears attention (store.ts:554-571); Cmd+] and Cmd+[ cycle focus in DFS order (store.ts:573-581).
- Pane title bar (PaneView.tsx:176-222): DFS index number; colour dot; label with the filePath, url or cwd as tooltip; link button (term panes only); badge with the foreground process, or zsh, cmd, claude, file or web (PaneView.tsx:275-279); per-pane zoom % only when the pane overrides the global zoom; memory badge "~N MB/GB" for term panes at 200 MB or more, "high" style above 1 GB (PaneView.tsx:141, 214-218); close "x".
- Pane labels: default is the cwd basename. OSC 7 cwd changes update the label unless it is custom (store.ts:666-671). The OSC 0/2 title becomes the label when "Name panes from the running program" is on (app.tsx:1670-1673). cleanPaneTitle strips escapes and control characters, strips a "user@host:" prefix, turns a path into its basename, caps at 80 characters, and ignores a title that cleans to empty (panes/paneTitle.ts:23-50).
- The reducer has a pane.label action, but no UI dispatches it, so there is no manual pane rename (store.ts:645).
- Pane exit overlay: "exited · code N" or "killed · signal N", red style when the code is non-zero, and a Restart button (PaneView.tsx:555-566). Restart bumps the pane's generation, keeps id and position, builds a fresh terminal (old scrollback lost) and respawns (store.ts:632-643, PaneView.tsx:324-438). On exit the terminal sets disableStdin and stops the cursor blink (terminal.ts:572-575).
- Closing a term pane calls pty.kill. If processes survive it toasts "N process(es) could not be reaped". If a preview pane has unsaved edits it confirms "Discard unsaved changes in this file?" first (app.tsx:415-432).
- Close All Panes (Cmd+Alt+W) closes only the preview (non-term) panes in the active tab. With none open it toasts "No preview panes open" (app.tsx:832-840).

### D. Terminal pane (renderer/panes/PaneView.tsx:287-569, renderer/term/terminal.ts)

- Every pane spawns /bin/zsh -l at the pane's cwd, after the first fit, with the real cols and rows (PaneView.tsx:397-430). After a successful spawn, a launch command is typed 300 ms later followed by CR: `claude [flag] [-r <uuid>]`, or the custom newPaneCommand (PaneView.tsx:417-424, serialize.ts:291-308). A spawn failure prints a red line "Failed to start shell: CODE - msg" into the terminal (PaneView.tsx:427).
- Resize goes to xterm first, then to the pty, debounced 80 ms, skipped when unchanged (terminal.ts:543-551). Only visible panes are refit (PaneView.tsx:443-449).
- WebGL is enabled only while a pane is visible (Chromium allows about 16 contexts). After two context losses the pane stays on the DOM renderer (terminal.ts:514-536, PaneView.tsx:465-480).
- Font is "SF Mono Terminal", loaded from main as a variable font with weight 295-900, falling back to Menlo. With the fallback, sizes are scaled by 15/13 (terminal.ts:893-967, palette.ts:111-125).
- Default palette is Terminal.app Homebrew (palette.ts:37-61). A theme overrides 11 slots (palette.ts:79-95).
- Shift+Enter sends ESC CR with preventDefault (terminal.ts:320-353).
- App chords (Cmd chords on the Mac; Ctrl+Shift, Ctrl+Alt, Ctrl+, and the Ctrl zoom keys elsewhere) are swallowed by xterm so they reach the menu or the zoom listener (terminal.ts:360, shared/keys.ts:90-98).
- Off the Mac, bare Ctrl+A selects the input line when the foreground process matches claude, codex, opencode or gemini (terminal.ts:368-382, inputline.ts:214-227).
- Backspace or Delete immediately after an input-line select sends Ctrl+U (\x15) and clears the selection (terminal.ts:384-399, inputline.ts:185-189).
- Select All selects from the start of the logical line (walking wrapped rows) to the cursor. With no input it falls back to the whole buffer (terminal.ts:761-780, inputline.ts:112-130).
- OSC 7: handled for file:// URLs only. Percent-escapes decoded, a NUL or newline rejected, trailing slash stripped (osc7.ts:25-52). Only a local host counts: empty, localhost, or this machine's hostname with or without .local (osc7.ts:63-76). The cwd feeds the pane label, project save and path resolution (PaneView.tsx:342-347).
- The bell (onBell) dispatches pane.bell. It sets attention to "waiting" only if the pane is unfocused and its metrics state is not PROMPT (store.ts:673-686).
- Velocity-ramped wheel scrolling (term/wheel-ramp.ts): ceiling 8x, onset 1.5 px/ms, gain 1.2, decay 200 ms, EMA weight 0.3. Forced to 1x in the alternate buffer or when mouse tracking is on. Reset on focusout (terminal.ts:822-845).
- App scrollbar, used when the alternate buffer is active and mouse tracking is on, for example Claude Code fullscreen (term/app-scrollbar.ts, app-scroll.ts): replaces xterm's scrollbar with a 14 px overlay; thumb 4 px wide, 10 px on hover; thumb position estimates wheel notches, minimum range 24; dragging the thumb or clicking the track to page 5 notches (repeat delay 350 ms, then every 90 ms) dispatches synthetic WheelEvents at .xterm-screen; submitting a line (CR) resets it to the bottom.
- When the device pixel ratio changes, every visible terminal is refit (term/dpr.ts:43-77, app.tsx:339).
- Theme changes repaint existing terminals through options.theme with no rebuild (app.tsx:150-169, theme/live.ts).
- Behaviour from xterm defaults, not app code: mouse selection and double/triple-click word/line select; mouse reporting to the pty; bracketed paste and the alternate screen; OSC 8 links (only http/https activated, terminal.ts:205-209); xterm 6's overlay scrollbar.
- Option is Meta and Option-click forces selection on macOS; altClickMovesCursor is off (terminal.ts:140-146).

### E. URLs and path click (renderer/links/*, renderer/panes/pathclick.ts)

- Bare URLs are clickable through WebLinksAddon (hover underline plus click), opening http and https in the browser. Clicks that are part of a selection (detail==0) are ignored (terminal.ts:238-243).
- Double-clicking a path resolves it and reveals it in the explorer. Cmd+double-click also opens a preview pane. Cmd+Alt+double-click opens the file in the OS default app. Directories are only revealed and expanded (PaneView.tsx:364-387). The drawer has the same behaviour (DrawerShell.tsx:117-140).
- Double-click detection listens to both a capture-phase mousedown with detail==2 and a dblclick event, de-duplicated within 4 px and 500 ms (terminal.ts:424-465).
- Alt+double-click while the program has mouse reporting on keeps the second click from reaching the pty (terminal.ts:475-492).
- Path geometry: the client point is mapped to a cell using the .xterm-screen rect, and wrapped rows are joined into one logical line with an index-to-cell map (pathclick.ts:28-112, cellmap.ts:53-155).
- Tokenizer (tokenizer.ts:97-334): single- or double-quoted spans, backslash-escaped spaces; strips wrapping brackets, the Name(path) form, unmatched trailing brackets and trailing punctuation; splits off :line:col and (line,col) suffixes (parsed but unused); rejects scheme URLs and version-like tokens; accepts absolute, ~, relative and bare names (name.ext with a 1-8 character extension, plus Makefile, Dockerfile, LICENSE and the like); limits 64 runs per line, 1024 characters per run.
- Resolution (resolve.ts:66-150): "…/x" or ".../x" is a suffix; findBySuffix runs in the pane cwd first, then the explorer root, limit 10. One hit reveals it. Otherwise it toasts "Nothing under X ends in Y", "Gave up searching...", or "N files end in Y: a, b, c". Any other token: statBatch on the token plus hard-wrap joins with the previous and next row (wrap-join.ts:31-43). The lowest-index non-directory wins. A miss toasts "No file at P from CWD".
- A reveal outside the explorer root toasts "P is outside the file explorer" (app.tsx:820-830).
- No hover highlighting for file paths: registerLinkProvider is not used.

### F. Explorer, labelled "File Browser" (renderer/explorer/Explorer.tsx)

- Hidden at launch. Toggle with Cmd+B (store.ts:704). Any reveal opens it (store.ts:710-716).
- Rooted at home; the root row shows "Home" (Explorer.tsx:27, 384-401).
- Width is set by dragging the grip, 170 to 620 px, default 260, stored as a base width divided by the UI scale. Double-clicking the grip resets it (app.tsx:295-320, 1576-1586; layout/sidebar.ts).
- Rows (Explorer.tsx:295-355): indented with a rotating twisty; SVG folder icon (open or closed tint) or file icon with a colour chip per extension (icons.tsx:33-63); gitignored entries dimmed to 45%; an error row shows "(CODE)"; a truncated listing ends with "… too many entries to list".
- Clicking selects a row. Clicking the twisty toggles without selecting. Double-clicking a folder toggles it; double-clicking a file opens it through openPath (Explorer.tsx:284-293).
- openPath routes by fs:probe (explorer/open.ts:16-46): viewer (preview pane); os (default app; an executable is refused with "That file is executable, revealed in Finder instead"); too-large (toast, then the default app); binary or reveal (revealInFinder); a missing file toasts "File no longer exists".
- Right-click context menu (Explorer.tsx:411-442): "Open Outside SeaShell" (files only), "Reveal in Finder"; closes on outside pointerdown or Escape.
- Refresh with the "⟳" button or Cmd+R re-reads every expanded directory (Explorer.tsx:111-124, 371).
- Live watch: expanded, non-ignored directories are subscribed, touched on each diff, unsubscribed on collapse or unmount. A change event re-lists that directory. A "lost" event does nothing (Explorer.tsx:151-202, ignored.ts).
- Reveal (Explorer.tsx:227-266): re-reads every directory along the path, expands it, selects the row, scrolls it to the centre. The row flashes green: a 1.4 s animation within a 2.5 s highlight (styles.css:517-530). A directory target is itself expanded (chain.ts:47-53).
- Bottom path strip shows the selected path, or the root. It truncates from the left (RTL plus an LRM mark). Clicking copies it with the toast "Copied path" (Explorer.tsx:456-475).
- In the Retro theme the explorer has a "drawer pull" strip (Explorer.tsx:379-381).

### G. Shell drawer (renderer/drawer/DrawerShell.tsx, layout/drawer.ts)

- Cmd+J toggles it. It overlays the bottom of the grid only.
- Height: drag the top grip, 120 to 800 px, default 300, divided by the UI scale before storing (app.tsx:269-293).
- One shell per pane, spawned lazily the first time the drawer is opened while that pane is focused, starting in the pane's live cwd. Pty ids are "drawer:<paneId>" (app.tsx:1296-1304, drawer/id.ts). All drawer instances stay mounted; only the focused pane's is shown. When a pane dies, its drawer pty is killed (app.tsx:1318-1329).
- Header: "Shell · <pane label>"; the OSC title, or cwd; a "cd to pane" button, shown only when the drawer cwd differs from the pane's, which types Ctrl+U, then `cd '<quoted>'`, then CR, refusing a path with control characters (DrawerShell.tsx:214-254, cd.ts); "✕" hides the drawer (DrawerShell.tsx:251).
- After the shell exits, the next open rebuilds the terminal and respawns (DrawerShell.tsx:154-178).
- Closing the drawer returns focus to the focused pane (app.tsx:1267-1276).
- Path double-click works as in panes.

### H. Find (renderer/find/FindBar.tsx; terminal.ts:589-788; app.tsx:842-856, 1147-1158)

- Cmd+F opens the find bar in the focused pane. In a web pane it toasts "Find is not available in a web preview".
- Search-as-you-type debounced 120 ms and incremental.
- Toggles "Aa" (match case) and ".*" (regex, terminal only). Counter "N of M", capped at "1000+" (terminal only). Buttons ↑ previous, ↓ next, ✕ close.
- Keys: Enter next, Shift+Enter previous, Esc closes. Escape anywhere also closes and clears. Cmd+G and Cmd+Shift+G re-run the query and open the bar if closed.
- A miss turns the field red. An unfinished regex is swallowed as a miss.
- Match colours: matches #255A1E, active match #3C5A8A. Overview ruler colours are passed but no ruler width is set (terminal.ts:589-594).
- The found match scrolls to mid-viewport (find-scroll.ts).
- Anchor pinning: a marker keeps the user's match selected while output streams, re-selecting it after the search addon's background refresh moves it (terminal.ts:654-739, find-anchor.ts).
- Emptying the field clears the decorations and the selection.
- File preview find uses Chromium window.find: no regex, no count (FilePreview.tsx:169-184, 265-274). No find for PDFs.

### I. Edit commands (menu, as ui:command, app.tsx:877-1082)

Target order: a terminal that holds focus (panes plus drawers), then a focused text field, then the focused pane (term/edit-target.ts).

- Copy: the text field's selection, or the terminal's selection. No-op when empty. No copy-on-select.
- Paste: both targets are resolved before the async clipboard read. Into a text field: execCommand insertText. Into a terminal: text that looks like Windows paths is converted to quoted /mnt paths; an empty clipboard tries Windows Explorer files (WSL) first, then a clipboard image saved as a PNG whose path is pasted; plain text uses term.paste.
- Select All: in a text field selects the field; in a terminal does the input-line select.
- Clear (Cmd+K): term.clear() on the target terminal. Ignored when a text field has focus.

### J. Drag and drop (PaneView.tsx:525-545, panes/drop.ts)

- Drag over a term pane accepts Files, text/uri-list or text/plain, dropEffect copy.
- Drop writes shell-quoted, space-joined paths plus a trailing space into the pty, then focuses the terminal.
- Sources: File objects via webUtils.getPathForFile, file:// URIs, or plain text that is a path (POSIX, C:\, \\wsl.localhost, file://).
- On Linux and win32, Windows paths are mapped to /mnt/c and /.
- No drop onto previews or the explorer. No drag out. No tab or pane drag reordering.

### K. File preview pane (renderer/viewer/FilePreview.tsx, highlight.ts, hast.tsx)

- One file pane per tab: opening another file retargets it, resets raw mode and relabels it (store.ts:440-473).
- Text files are read up to 8 MB. Above that the flag "truncated at 8 MB" is shown and editing is disabled.
- Highlighting uses Shiki with the JS regex engine and github-dark-default, 27 grammars, extension and basename maps, skipped above 512 KB (highlight.ts:487-556). Markdown is shown as highlighted source, not rendered.
- Toolbar (FilePreview.tsx:275-328): "Plain/Highlight" toggle (stored in pane.rawSource), Edit, Reveal, Open.
- Edit mode: a textarea editor with Cmd/Ctrl+S to save inside it (on macOS Cmd+S is also the Save Project accelerator; which wins needs verifying); Save disabled unless the text changed; "Discard" (confirms "Discard unsaved changes?") or "Done"; "● unsaved changes" flag (FilePreview.tsx:125-149, 201-215, 280-297).
- The save sends expectedMtimeMs. ECONFLICT shows a banner with "Reload from disk" that confirms first. Any other failure shows "Could not save this file - it may be read-only or outside your home folder" (FilePreview.tsx:329-355).
- Dirty panes are tracked in dirtyPreviewPanes for the pane-close and tab-close confirms (FilePreview.tsx:50, 81-89).
- Images (png, jpg, jpeg, gif, webp, bmp, ico) arrive as a base64 data URL and are shown centred (FilePreview.tsx:14, 100-108, 193-199).
- PDF is a webview guest with plugins enabled (PDFium) plus Reveal and Open, no find bar (FilePreview.tsx:229-261).
- States: "Loading…" and "Could not read this file (CODE)".

### L. Web preview pane (renderer/panes/WebPreview.tsx)

- Created by the "◍" button or Cmd+Shift+U, starting with an empty URL. Empty state: "Enter an address to preview" / "a dev server, e.g. localhost:3000".
- URL bar: back "‹", forward "›", reload "⟳" (stop "✕" while loading); input with placeholder "localhost:3000", Enter navigates, Esc reverts the draft; "↗" opens the page in the system browser.
- normalizeUrl: http and https only. ":3000" becomes localhost:3000, http:// is added when there is no scheme. Otherwise it toasts "Enter an http:// or https:// address" (WebPreview.tsx:41-59).
- did-navigate updates the URL and the label (host:port, store.ts:230-237). did-fail-load on the main frame, except -3 (aborted), shows "Could not load - <desc>".
- Partition "persist:seashell-preview", sandboxed. Main forces the guard, opens popups externally, and blocks non-http navigation (main/index.ts:134-175).

### M. Pane colour, link and attention

- Colour dot opens a swatch popover with 7 colours (red, amber, green, cyan, blue, purple, pink) plus "No colour". Picking the current colour clears it. Esc or an outside pointerdown closes it (panes/ColorPicker.tsx, colors.ts:36-44).
- A tagged pane gets a border in its colour, full strength when focused, and an accent stripe on its title.
- Auto-colour (setting): a tab's first pane is green; each new pane gets the first colour unused in the tab, else the least recently used (colors.ts:56, 84-96, store.ts:309-312).
- Link "⇄" opens the LinkPicker popover, "Share notes with" (panes/LinkPicker.tsx): lists the other term panes in the tab by index and label; disabled with "no agent" when the pane's foreground is not claude; "linked" when already linked; "Stop sharing" unlinks. Linking calls links.ensure, then types Ctrl+U, the briefing sentence and CR into both panes. Toasts: "Panes are sharing notes", "Both panes need to be running an agent to link" (app.tsx:766-801, link.ts:29-58). The "⇄" icon is highlighted while linked.
- Attention: "waiting" is set by the bell. "done" is set when the pane returns to PROMPT from BUSY or WAITING, and expires after 9 s (panes/attention.ts:22-46, store.ts:726-785). CSS breathing animation: 2.8 s infinite for waiting (amber), four times 1.8 s for done (green), the pane's tag colour when it has one, respects reduced motion (styles.css:695-731). Never on the focused pane. Off when Sleep is on.
- Attention ping: two sine tones (880 Hz, then 587.33 Hz, 90 ms apart) through Web Audio, on the transition into attention, at most once per 1.8 s, only when both glow and sound are on. The audio is unlocked on the first gesture (panes/ping.ts, app.tsx:216-233).

### N. Projects (renderer/projects/ProjectsPanel.tsx, serialize.ts; app.tsx:182-189, 486-749, 803-810)

- Projects sheet opens with Cmd+Shift+P. Cmd+S opens it on window scope; "Save Tab as Project..." opens it on tab scope. Esc or "Done" closes it.
- Save section: scope buttons "Whole window" and "This tab"; "Save "<current>"" updates the project in place, window scope only; name input (max 60 characters, Enter saves); the button reads "Save", "Save as project", or "Overwrite" when the name matches an existing project case-insensitively; description lists the tab and pane counts.
- Open section: each row shows the name, "N tabs · M panes · saved X ago", and buttons Delete (inline confirm Delete/Cancel), Add and Open.
- Open replaces the window and kills every live pane. Add appends tabs. Toasts: "Opened", "Added", "Saved project", "Saved tab as", "Nothing to save", "Could not save project (CODE)".
- Saved (serialize.ts:100-186): tabs with tree ratios, plus panes with label, kind, command, commandText, cwd, colour, filePath, url and a UUID-validated claudeSessionId. Claude detection uses process proof, then metrics, then sticky claude state (serialize.ts:100-115).
- Restore (serialize.ts:233-308, 327-445; app.tsx:649-692): mints fresh ids and remaps the tree; settles session ids through projects:sessionIds and the permission mode through projects:resumeModes; types `claude [--dangerously-skip-permissions | --permission-mode X] [-r <uuid>]`.

### O. Session restore (renderer/session/*, app.tsx:570-634, 1357-1388)

- The last-session snapshot is written every 30 s when it changed, and on main's quit request (forced).
- A window not worth offering is cleared instead: one tab, one pane, plain zsh (session/offer.ts).
- At launch, a full-window card asks "Restore last session?" with "N tabs, M panes, saved <locale time>. Claude panes resume their sessions." and buttons Restore (autofocused) and "Start fresh". Esc means Start fresh, which also clears the snapshot.

### P. Settings sheet (renderer/settings/SettingsPanel.tsx, settings.ts:63-74)

- Opens with Cmd+, or the "⚙" button. Esc or "Done" closes it.
- Appearance: Theme, 7 buttons labelled Current, Nautical, Retro CRT, macOS Light, macOS Dark, Hacker and Aero Glass, each with a tooltip note and the theme's full name beside them; Accent, "Theme default" plus 6 swatches (Homebrew green, Brass, Blue, Signal red, Violet, Cyan); Terminal palette, Theme native, Solar, Amber mono, Ice; Pane frame, Theme, Hairline, Bezel, Floating, Slab; CRT glass, Theme, On, Off.
- Panes (checkboxes): attentionGlow (default on), attentionSound (default off), autoColorPanes (default on), autoTitlePanes (default on).
- New panes: "Start new panes with" text field, max 200 characters, control characters stripped. Default empty, meaning a plain shell.
- Help: Tutorial "Show" button.
- Sleep moon in the tab bar ("☾" awake, "☽" asleep) toggles attentionGlow (app.tsx:1532-1542).

### Q. Status bar (renderer/status/StatusBar.tsx)

- "N panes"; "~X in panes" (sum of RSS, with a tooltip); "used/total used", styled warn or crit by memory pressure; "compressed X" when above 0; "swap X", warn above 2 GB.
- Hint text on the right: "⌘D pane · ⌘T tab · ⌘=/- zoom · ⌘+/_ pane zoom · ⌘↩ full screen", with platform spelling.

### R. Theme (renderer/theme/*, styles.css)

- Every chrome colour, gradient, radius and shadow is a CSS custom property. 7 themes with about 82 tokens (tokens.ts:30-494).
- Other axes: palettes (tokens.ts:515-528); pane frames including bezel padding, floating shadow and slab 2 px border (tokens.ts:533-585); CRT effects, scanlines with a 1.8 s crawl, a 5.5 s flicker, a vignette or glass layer, an 8 s rolling band, a text-shadow glow (tokens.ts:594-608, styles.css:1784-1862); accent override with readable text colour by luminance (apply.ts:54-95).
- Aero adds frosted backdrop blur on the tab bar, sidebar and status bar, plus a gradient "desk" layer behind the window (styles.css:179-202).
- applyTheme clears the full union of keys before setting new ones (apply.ts:109-117). The terminal palette is pushed to xterm (palette.ts:79-95).

### S. Zoom (renderer/term/zoom.ts; app.tsx:243-252, 1116-1144, 1512-1523)

- Global rungs as font px / UI scale: 9/.85, 12/.95, 13/1.0 (default), 16/1.1, 17/1.18, 21/1.32, 25/1.48, 30/1.65. The UI scale is published as --ui-scale; every chrome dimension uses it.
- Per-pane text zoom: Cmd+Shift+= and Cmd+Shift+-. Any global zoom clears per-pane overrides.
- Tab bar badge "N%" shows, with "*" when panes are zoomed, whenever anything is off-default. Clicking it resets everything.

### T. Tutorial (renderer/tutorial/Tutorial.tsx)

- 12 text steps with key tables spelled per platform. Shown on first run, and from Help, Show Tutorial (Cmd+/) or Settings.
- Controls: "Skip"; clickable step dots; Back and Next, with "Get started" on the last step; Esc, ArrowLeft and ArrowRight, captured so a focused terminal does not see them; "Don't show this again" checkbox, checked by default.

### U. Updater (renderer/update/UpdateBanner.tsx, app.tsx:1395-1398, 1744-1764)

- A strip above the status bar. Phases: available ("SeaShell V is available." with Download (canInstall) or "Release page", plus Later); downloading ("Downloading V: N%" or "N MB"); ready ("Install and Relaunch" and Later); error ("Try again" and Dismiss).
- Later remembers the version. An error dismissal lasts for the session only.

### V. Window chrome (renderer/chrome/WindowControls.tsx, shared/window-chrome.ts)

- macOS: the tab bar keeps a 78 px left inset for the traffic lights and is a drag region.
- Linux (frameless): "≡" menu button on the left pops up the app menu; minimize, maximize/restore (glyph follows window:maximized) and close drawn at Windows 11 metrics, 46 px wide, red hover on close.
- win32 native frame: no drag region and no drawn buttons.
- Alt shows the hidden menu bar off the Mac.

### W. Every modal, card and dialog

- Cards and sheets: RestoreCard, SettingsPanel, ProjectsPanel, Tutorial.
- Popovers: ColorPicker, LinkPicker, Explorer context menu.
- In-pane overlays: the exit overlay, the save-conflict banner, the web error banner.
- window.confirm dialogs: "Discard unsaved changes in this file?" (app.tsx:418); "This tab has a file with unsaved changes. Discard them?" (app.tsx:440); "Discard unsaved changes?" (FilePreview.tsx:290); "Reload from disk and discard your edits?" (FilePreview.tsx:342).
- Toast, update banner, "Starting SeaShell..." splash, "No tabs open" empty state.

### X. Keyboard shortcuts

| Mac chord | Other platforms | Action | Where |
|---|---|---|---|
| Cmd+, | Ctrl+, | Settings | main/menu.ts:62 |
| Cmd+T | Ctrl+Shift+T | New tab | menu.ts:81 |
| (none) | (none) | Rename Tab... | menu.ts:93 |
| Cmd+Shift+P | Ctrl+Alt+P | Projects | menu.ts:95 |
| Cmd+S | Ctrl+Shift+S | Save Project (window scope) | menu.ts:96 |
| (none) | (none) | Save Tab as Project | menu.ts:99 |
| Cmd+D | Ctrl+Shift+D | New pane (runs newPaneCommand if set) | menu.ts:101, app.tsx:404 |
| Cmd+Shift+O | Ctrl+Alt+O | "New File Preview": toast plus open explorer | menu.ts:103, app.tsx:935 |
| Cmd+Shift+U | Ctrl+Alt+U | New web preview | menu.ts:104 |
| Cmd+W | Ctrl+Shift+W | Close focused pane | menu.ts:106 |
| Cmd+Alt+W | Ctrl+Alt+Shift+W | Close all preview panes | menu.ts:107 |
| Cmd+Shift+W | Ctrl+Alt+W | Close tab | menu.ts:108 |
| Cmd+C / Cmd+V / Cmd+A | Ctrl+Shift+C / V / A | Copy / Paste / Select All | menu.ts:116-118 |
| Cmd+F / Cmd+G / Cmd+Shift+G | Ctrl+Shift+F / Ctrl+Shift+G / Ctrl+Alt+G | Find / next / previous | menu.ts:120-122 |
| Cmd+K | Ctrl+Shift+K | Clear pane | menu.ts:124 |
| Cmd+Return | Ctrl+Shift+Return | Full-screen pane | menu.ts:132 |
| Cmd+Shift+R | Ctrl+Alt+R | Rebalance | menu.ts:133 |
| Cmd+B / Cmd+J / Cmd+R | Ctrl+Shift+B / J / R | Explorer / Drawer / Refresh explorer | menu.ts:142-146 |
| Cmd+] / Cmd+[ | Ctrl+Shift+] / [ | Next / previous pane | menu.ts:155-156 |
| Cmd+Shift+] / [ | Ctrl+Alt+] / [ | Next / previous tab | menu.ts:158-159 |
| Cmd+1..9 | Ctrl+Shift+1..9 | Tab N | menu.ts:161-163 |
| Cmd+/ | Ctrl+Shift+/ | Tutorial | menu.ts:186 |
| Cmd+= / Cmd+- / Cmd+0 | Ctrl+= / - / 0 | Global zoom in / out / reset | app.tsx:1116-1144 |
| Cmd++ / Cmd+_ (shifted) | Ctrl+Shift+= / - | Focused pane text zoom | app.tsx:1130-1135 |
| Shift+Enter | same | Sends ESC CR to the pty | terminal.ts:320 |
| Ctrl+A (non-Mac, agent foreground) | same | Select input line | terminal.ts:368 |
| Backspace/Delete after a select-all | same | Sends Ctrl+U | terminal.ts:384 |
| Escape | same | Close find bar from anywhere | app.tsx:1147 |
| Enter / Shift+Enter / Esc | same | Find next / previous / close | FindBar.tsx:123-133 |
| Enter / Esc / blur | same | Tab rename commit / cancel / commit | app.tsx:1840-1856 |
| Esc, ArrowLeft, ArrowRight | same | Tutorial close / back / next | Tutorial.tsx:273-291 |
| Esc | same | Close Settings, Projects, ColorPicker, LinkPicker, context menu; Restore card means Start fresh | each component |
| Enter / Esc in the URL field | same | Navigate / revert | WebPreview.tsx:354-358 |
| Cmd/Ctrl+S in the editor textarea | same | Save file | FilePreview.tsx:209 |
| Enter in the project name field | same | Save | ProjectsPanel.tsx:155 |
| Mouse: double-click / Cmd+dbl / Cmd+Alt+dbl / Alt+dbl on a path | Ctrl instead of Cmd | Reveal / preview / OS open / keep the click from the TUI | terminal.ts:424-492 |

Menu-only items handled by main: About, Hide, Hide Others, Show All, Quit/Exit, Window, Minimize and Close Window, togglefullscreen, devtools (dev builds), "SeaShell on GitHub" (menu.ts:58-191). On Linux, main matches accelerators itself in before-input-event (main/accelerators.ts, main/index.ts:199-206).

### Y. Built but not wired, so do not port

- fitsAutoMinimum, the 32x10 auto-insert refusal (auto-arrange.ts:131).
- clampDividerDrag (resize.ts:83).
- validateInvariant and hasPane (tree.ts).
- The pane.label action.
- Dead CSS: .pane__idle, .viewer__*, .sidebar--hidden.
- Theme tokens no CSS rule reads: --lightsDisplay, --winCtlDisplay, --l1/--l2/--l3, --lightRing, --cardRotate, --sideImg.

## 2. IPC surface

The 47 channels in src/shared/ipc.ts:37-101, all confirmed in main and all used by the renderer through the preload. invoke is a request with a response, send is fire and forget, on is an event from main.

| Channel | Dir | Payload |
|---|---|---|
| clipboard:windows-files | invoke | () -> string[] (Windows paths, WSL only); used by paste |
| clipboard:image | invoke | () -> string (PNG path or ''); used by paste |
| pty:spawn | invoke | {paneId, file, args[], cwd, cols, rows} -> Result<{pid}, ENOENT, EACCES, ECWD, ELIMIT> |
| pty:write | send | {paneId, data} |
| pty:resize | send | {paneId, cols, rows} |
| pty:kill | invoke | {paneId} -> {ok, survivors} |
| pty:data | on | {batches: [{paneId, data}]} (frame-batched across panes) |
| pty:exit | on | {paneId, exitCode, signal or null, ranMs} |
| fs:readDir | invoke | {path, respectGitignore} -> Result<{entries: FsDirEntry[] {name, isDir, isSymlink, size, mtimeMs, ignored}, truncated}> |
| fs:statBatch | invoke | {cwd, candidates[] (max 512)} -> {results: [{i, resolved, kind file, dir or other, size, exec}]} |
| fs:findBySuffix | invoke | {root, suffix, limit (max 50)} -> {paths[], truncated} |
| fs:probe | invoke | {path} -> {exists, isDir, size, ext, route: viewer, os, reveal, too-large or binary} |
| fs:readTextFile | invoke | {path, maxBytes} -> Result<{text, lines, size, truncated, mtimeMs}, EBINARY, ETOOBIG, ENOENT, EACCES> |
| fs:writeTextFile | invoke | {path, text, expectedMtimeMs} -> Result<{mtimeMs}, ECONFLICT, EBINARY, ESCOPE, ETOOBIG, ENOENT, EACCES> |
| fs:readImageFile | invoke | {path} -> Result<{base64, mime, size}, ETOOBIG, ENOENT, EACCES, EUNSUPPORTED> |
| open:withDefaultApp | invoke | {path} -> {ok, error?} ("refused-executable" is special-cased) |
| open:revealInFinder | invoke | {path} -> {ok, error?} |
| open:externalHttp | invoke | {url} -> {ok, error?} |
| metrics:tick | on | {panes: [{paneId, footprintBytes, cpuFrac, state PROMPT, BUSY or WAITING, foregroundProcess, procCount, cwd}], system: {usedBytes, totalBytes, compressorBytes, swapUsedBytes, swapTotalBytes, pressureLevel} or null}; every 5 s visible, 30 s hidden (monitor.ts:11, 23) |
| app:getPaths | invoke | () -> {home, hostname, userData, defaultShell, cwdOfLaunch} |
| app:getTerminalFont | invoke | () -> ArrayBuffer or null |
| app:toast | on | {message} |
| update:state | on | UpdateState: idle, available{version, pageUrl, canInstall}, downloading{version, received, total}, ready{version}, error{version, message} |
| update:download | send | () |
| update:install | send | () |
| watch:subscribe / watch:unsubscribe / watch:touch | send | {dir} |
| watch:changed / watch:lost | on | {dir} |
| links:ensure | invoke | {linkId} -> {path or null} (file is userData/links/<id>.md) |
| projects:list | invoke | () -> {projects: Project[]} |
| projects:sessionIds | invoke | {panes: [{paneId, cwd, knownSid?, knownVerified?, label?, claude?}], releasing?} -> {ids: Record<pane, sid>, sources: Record<pane, process, registry, carried, title or cwd>} |
| projects:resumeModes | invoke | {panes: [{paneId, cwd, sid}]} -> {modes: Record<pane, mode>, bypassConsented} |
| projects:save | invoke | {id?, name, tabs: SavedTab[]} -> Result<{project}, EINVALID, EWRITE, ELIMIT> |
| projects:delete | invoke | {id} -> {ok} |
| session:save | invoke | {tabs: SavedTab[]} -> void |
| session:load | invoke | () -> LastSession or null |
| session:clear | invoke | () -> void |
| session:requestSnapshot | on | () at quit; main waits 1 s, or 4 s on win32 |
| ui:command | on | {command}: tab.new, tab.close, tab.next, tab.prev, tab.select.0-8, tab.rename, pane.new, pane.close, pane.closeAll, pane.next, pane.prev, pane.zoom, pane.clear, preview.file, preview.web, layout.rebalance, drawer.toggle, explorer.toggle, explorer.refresh, help.tutorial, app.projects, app.saveProject, app.saveTab, app.settings, ui.zoomIn, ui.zoomOut, ui.zoomReset, edit.find, edit.findNext, edit.findPrev, edit.copy, edit.paste, edit.selectAll |
| window:minimize / window:toggleMaximize / window:close / window:menu | send | () (frameless Linux only) |
| window:isMaximized | invoke | () -> boolean |
| window:maximized | on | {maximized} |

Constants: MAX_TERM_PANES = 64, which caps the session-id batches. DRAWER_PTY_PREFIX = "drawer:". The preload also exposes the platform string and files.pathFor(File), which calls webUtils.getPathForFile and is not an IPC channel (preload/index.ts:76-85).

## 3. xterm.js usage (@xterm/xterm 6.0.0; renderer/term/terminal.ts unless noted)

Addons: FitAddon 0.11 (refit on pane, rect, font, DPR or drawer change); SearchAddon 0.16 (findNext and findPrevious with {decorations, caseSensitive, regex, incremental}, onDidChangeResults, clearDecorations, an undocumented third argument {noScroll}, terminal.ts:75-79, 714-718); WebLinksAddon 0.12 with a custom activate handler; WebglAddon 0.19 (onContextLoss, load and dispose on visibility, at most two retries); UnicodeGraphemesAddon 0.4 with unicode.activeVersion = '15-graphemes' (term/unicode.ts), grapheme-cluster cell widths must match exactly. Not used: image, clipboard, serialize, ligatures, attach, unicode11.

Constructor options (terminal.ts:121-210): fontFamily, fontSize, lineHeight 1, letterSpacing 0; customGlyphs and rescaleOverlappingGlyphs on; cursorStyle block, cursorBlink true, cursorInactiveStyle outline; drawBoldTextInBrightColors false, macOptionIsMeta, macOptionClickForcesSelection, altClickMovesCursor false; minimumContrastRatio 1, scrollback 20000, smoothScrollDuration 0; allowTransparency true (each terminal host paints --termBg itself); allowProposedApi true, theme (ITheme); linkHandler.activate for OSC 8, http and https only. Changed at runtime: theme, fontSize, disableStdin, cursorBlink, scrollSensitivity (the wheel ramp).

APIs used: term.open(container), write, dispose, focus, element, cols, rows; attachCustomKeyEventHandler (returning false lets the event bubble to window and menu handlers); parser.registerOscHandler(7); onData, onResize, onTitleChange (OSC 0/2), onBell, onWriteParsed, buffer.onBufferChange; buffer reads buffer.active.{type 'alternate', viewportY, baseY, cursorX, cursorY, length, getLine(y).{isWrapped, length, translateToString(true), getCell(x).{getChars(), getWidth()}}} (pathclick.ts:87-138, terminal.ts:761-780); modes.mouseTrackingMode with a fallback to the private _core.coreMouseService.activeProtocol (terminal.ts:499-511); getSelection, getSelectionPosition, select(col, row, len), selectAll, clearSelection; scrollToLine; registerMarker(offset) with marker.line, isDisposed and dispose for find anchoring; term.clear() (Cmd+K) and term.paste(text) (bracketed-paste aware); private _core._renderService.dimensions.css.cell.{width, height} for layout cell size (app.tsx:1197-1207) and the DPR residual warning (terminal.ts:847-860).

DOM-level hooks on the host: capture-phase mousedown (detail==2), dblclick, passive wheel, focusout; querySelector('.xterm-screen') for the click-to-cell rect; synthetic WheelEvents dispatched at .xterm-screen so xterm encodes them in the program's mouse protocol (app-scrollbar.ts:177-192); CSS hides xterm's own vertical scrollbar in app-scroll mode (styles.css:2121).

Not used: registerLinkProvider (no hover for file paths), decorations other than search, onRender, onSelectionChange, onScroll, CSI/DCS/ESC handlers, a visual or audible bell (the bell only feeds attention), the overview ruler (colours passed, no width set).

Relied-on defaults a native grid must reproduce: mouse selection (drag, double-click word, triple-click line, Alt/Option forced selection); all mouse reporting modes and the alternate screen; bracketed paste and DECSCUSR cursor shapes; truecolor and 256 colour, OSC 8 hyperlinks, reflow on resize; wrapped-line flags (isWrapped); xterm 6's overlay scrollbar and its IntersectionObserver pause when hidden; box-drawing glyphs drawn exactly to the cell (customGlyphs).

## 4. Renderer-side state

Reducer state (renderer/store.ts): AppState (store.ts:148-157): tabs[], activeTabId, sidebarVisible, explorerRoot, revealPath {path, isDir}, system (SystemMetrics), toast. TabState (store.ts:120-133): id, name, nameIsCustom, cwd, tree (RowNode), pristine, zoomedPaneId, focusedPaneId, panes. PaneState (store.ts:35-97): id, kind term, file or web, cwd, label, labelIsCustom, command zsh, claude or cmd, commandText, claudeSessionId, claudeResumeMode, filePath, rawSource, url, color, linkId, zoomIndex, pid, status starting, live or exited, exit, metrics, claudeSeen, attention, attentionAt, generation. 37 action types (store.ts:262-299).

App component state (app.tsx:82-238, 464, 1160): ready, pendingRestore, home, zoomIndex, sidebarWidth; drawerOpen, drawerHeight, drawerPanes[]; renamingTabId, tutorialOpen, settingsOpen, projectsOpen, projectsScope, projects[]; updateState, dismissedUpdate, settings; findOpen, find {nonce, direction}, gridSize, explorerNonce, currentProject.

Module globals: terminals Map (panes and drawers, also window.__seashellTerminals); spawned Set keyed paneId#generation, and hostname (PaneView.tsx:21-91); dirtyPreviewPanes (FilePreview.tsx:50); the current xterm theme (theme/live.ts), fontLoaded, the AudioContext and lastPingAt, the uid counter. Explorer local state: dirs cache, expanded Set, selected, revealed, menu, subscribed Set.

localStorage keys: seashell.settings (JSON Settings, coerced on load, settings.ts:86-155); seashell.zoomIndex (zoom.ts:59); seashell.sidebarWidth (sidebar.ts:12); seashell.drawerHeight (drawer.ts:12); seashell.tutorialSeen = "1" (Tutorial.tsx:18); seashell.updateDismissed = the version string (app.tsx:126, 1756). The webview partition "persist:seashell-preview" keeps cookies and storage for previews.

Files written by main via IPC, in userData: projects.json (main/state/store.ts:20); last-session.json (main/state/last-session.ts:7); links/<linkId>.md; window-bounds.json (main only).

Session file: LastSession {schemaVersion: 1, savedAt ISO, tabs: SavedTab[]}. SavedTab {id, name, nameIsCustom, cwd, zoomedPaneId, focusedPaneId, tree (row/col/pane with ratios), panes: Record<id, SavedPane>, sessionIdsVerified: true}. SavedPane {label, labelIsCustom, kind, command, commandText?, cwd, color?, filePath?, url?, claudeSessionId? (UUID only)}. Project = {id, name, savedAt, tabs}.

Deliberately not persisted: scrollback, pid, metrics, attention, generation, linkId, claudeResumeMode, claudeSeen; per-pane zoomIndex, rawSource, pristine; sidebar visibility (always starts closed), drawer open state, explorer expansion, currentProject.

## 5. Things that depend on web technology

- Web preview <webview>: separate sandboxed process, persistent partition, back/forward/reload/stop, did-* events, popup and navigation guards (panes/WebPreview.tsx, main/index.ts:134-175).
- PDF preview through Chromium PDFium in a webview with plugins (viewer/FilePreview.tsx:229-261).
- Shiki syntax highlighting: TextMate grammars on the JS regex engine, 27 languages, github-dark-default, HAST rendering under a style allowlist (viewer/highlight.ts, hast.tsx).
- File preview find through Chromium window.find over rendered spans (FilePreview.tsx:169-184).
- Image decode from a data URL for png, jpg, gif, webp, bmp and ico; animated GIF plays in Chromium (FilePreview.tsx:193-199).
- Theme engine: 7 themes, about 82 CSS variables, linear, radial and repeating gradients, inset and multi-layer box-shadows, color-mix; per-theme fonts (serif for Retro, Segoe for Aero); rounded tabs and theme-dependent pane frames (theme/tokens.ts, styles.css).
- Aero backdrop-filter blur and saturate over a gradient desk layer (styles.css:179-202, 375, 915).
- CSS animations: attention breathing glow on box-shadow and border; explorer reveal flash; CRT scanline crawl, flicker, roll band, vignette and text-shadow bloom; hover transitions and the app-scrollbar thumb growth; prefers-reduced-motion fallbacks (styles.css:695-731, 1784-1862, 2125-2147).
- WebGL glyph atlas fidelity: customGlyphs box drawing, the allowTransparency alpha ramp, -webkit-font-smoothing auto, a zoom ladder chosen around DPR residuals (terminal.ts:121-201, zoom.ts, styles.css:105-140).
- Loading Terminal.app's private variable font with a weight range through the FontFace API. On Windows getTerminalFont returns null, so a font choice is needed (terminal.ts:941-967).
- Unicode 15 grapheme-cluster widths so emoji and ZWJ sequences match what Claude Code counts (term/unicode.ts).
- Synthetic wheel events driving the program's mouse protocol for the app scrollbar; natively, wheel escape sequences are emitted directly (term/app-scrollbar.ts:177-192).
- Web Audio synthesized ping with exponential gain envelopes (panes/ping.ts:56-98).
- Clipboard: navigator.clipboard plain text only, plus document.execCommand('insertText') for undo-preserving paste into fields (app.tsx:1000-1065). No HTML clipboard.
- Drag and drop of Files, uri-list and text with webUtils path extraction. No drag images, no drag-out (PaneView.tsx:525-545).
- -webkit-app-region drag on the tab bar, and the 78 px traffic-light inset on macOS (styles.css:201-222, 2008-2020).
- body.dragging disabling webview hit-testing during divider, sidebar and drawer drags (styles.css:1147).
- The left-truncating RTL path strip with an LRM mark, and ellipsised tab names (Explorer.tsx:20, 456-475).
- DPR change detection via matchMedia, which maps to WM_DPICHANGED (term/dpr.ts).
- window.confirm dialogs, which map to MessageBox (4 sites).
- The tutorial is plain text in cards. Easy natively.

## 6. Line counts (wc -l)

renderer/app.tsx 1859; renderer/store.ts 837; renderer/styles.css 2147; main.tsx + platform.ts + index.html 95; term/ (13 files) 2034, of which terminal.ts 967; panes/ (11 files) 1503, of which PaneView.tsx 574 and WebPreview.tsx 187; layout/ (8 files) 911; projects/ 776 (serialize.ts 532, ProjectsPanel.tsx 244); theme/ 767 (tokens.ts 624); links/ 688; explorer/ 684; viewer/ 638; settings/ 425; tutorial/ 357; drawer/ 304; find/ 165; chrome/ 98; status/ 84; update/ 81; session/ 64. Renderer total 14,517 lines in 67 files. Of that, roughly 2,150 is CSS and about 4,700 is pure logic (layout, links, serialize, zoom, attention, keys) that ports directly. shared/ipc.ts 667, preload/index.ts 175. Shared helpers the renderer imports: keys.ts 110, window-chrome.ts 63, wsl-path.ts 138, claude-title.ts 21. Main side, for reference: menu.ts 196, accelerators.ts 129, ipc-router.ts 643.
