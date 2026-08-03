import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { CH } from '../shared/ipc.js'

/**
 * Every keybinding in SeaShell is a menu accelerator, and every accelerator uses
 * Cmd. There are ZERO Ctrl bindings, deliberately.
 *
 * The reason: every Ctrl+<letter> maps to a C0 control code that zsh's line
 * editor or a full-screen TUI already binds (Ctrl+A/E/K/U/W/R/L/C/D/Z...).
 * Stealing any of them would break the thing the app exists to host. On macOS
 * the only Cmd chord xterm.js consumes is Cmd+A, so everything else falls
 * through without reaching the PTY.
 *
 * Accelerators fire regardless of DOM focus and are forwarded to the renderer,
 * which dispatches on which zone (pane / explorer / tab bar) is focused.
 *
 * The zoom items are the one documented exception: they carry no accelerator
 * and are bound in the renderer instead. "Zoom in" has two physical spellings —
 * ⌘= (unshifted) and ⌘+ (shifted) — and an Electron menu item accepts exactly
 * one accelerator, so binding it here would leave whichever form the user
 * actually presses silently dead. Registering both as separate menu items would
 * duplicate the row in the menu. The renderer handles both spellings in one
 * keydown listener; the menu rows stay for discoverability, with the chord
 * written into the label so the menu still teaches the shortcut.
 *
 * Every command sent from here must have a case in the renderer's command
 * switch. A menu item whose command nothing handles is worse than no menu item:
 * it presents as a working feature and does nothing.
 */
export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const send = (command: string) => () => {
    getWindow()?.webContents.send(CH.uiCommand, { command })
  }

  const item = (label: string, accelerator: string, command: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: send(command),
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'SeaShell',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('Settings…', 'Cmd+,', 'app.settings'),
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        item('New Tab', 'Cmd+T', 'tab.new'),
        { type: 'separator' },
        item('Projects…', 'Cmd+Shift+P', 'app.projects'),
        item('Save Project…', 'Cmd+S', 'app.saveProject'),
        { type: 'separator' },
        item('New Pane', 'Cmd+D', 'pane.new'),
        { type: 'separator' },
        item('New File Preview…', 'Cmd+Shift+O', 'preview.file'),
        item('New Web Preview…', 'Cmd+Shift+U', 'preview.web'),
        { type: 'separator' },
        item('Close Pane', 'Cmd+W', 'pane.close'),
        item('Close All Panes', 'Cmd+Alt+W', 'pane.closeAll'),
        item('Close Tab', 'Cmd+Shift+W', 'tab.close'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // NOT role:'copy'/'paste'/'selectAll' — a role would swallow the chord
        // before the focused terminal ever sees it.
        item('Copy', 'Cmd+C', 'edit.copy'),
        item('Paste', 'Cmd+V', 'edit.paste'),
        item('Select All', 'Cmd+A', 'edit.selectAll'),
        { type: 'separator' },
        item('Find', 'Cmd+F', 'edit.find'),
        item('Find Next', 'Cmd+G', 'edit.findNext'),
        item('Find Previous', 'Cmd+Shift+G', 'edit.findPrev'),
        { type: 'separator' },
        item('Clear Pane', 'Cmd+K', 'pane.clear'),
      ],
    },
    {
      label: 'View',
      submenu: [
        // Not "Toggle Zoom": it sat directly above Zoom In / Zoom Out, which made
        // "zoom" ambiguous between filling the tab and changing text size.
        item('Full-Screen Pane', 'Cmd+Return', 'pane.zoom'),
        item('Rebalance Panes', 'Cmd+Shift+R', 'layout.rebalance'),
        { type: 'separator' },
        // No accelerators on these three, deliberately — see the note below.
        { label: 'Zoom In\t⌘=', click: send('ui.zoomIn') },
        { label: 'Zoom Out\t⌘-', click: send('ui.zoomOut') },
        { label: 'Actual Size\t⌘0', click: send('ui.zoomReset') },
        // No menu items for the pane pair: they act on the focused pane, which
        // is a renderer concept, and the chords are listed in the tutorial.
        { type: 'separator' },
        item('Toggle File Explorer', 'Cmd+B', 'explorer.toggle'),
        // Sibling of the explorer toggle — they share the sidebar column.
        item('Toggle Lookout', 'Cmd+Shift+B', 'lookout.toggle'),
        // ⌘J after the editor convention for "toggle the panel". The drawer is
        // the human's shell alongside the agents' panes (SEASHELL-2).
        item('Toggle Shell Drawer', 'Cmd+J', 'drawer.toggle'),
        item('Refresh Explorer', 'Cmd+R', 'explorer.refresh'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        item('Next Pane', 'Cmd+]', 'pane.next'),
        item('Previous Pane', 'Cmd+[', 'pane.prev'),
        { type: 'separator' },
        item('Next Tab', 'Cmd+Shift+]', 'tab.next'),
        item('Previous Tab', 'Cmd+Shift+[', 'tab.prev'),
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) =>
          item(`Tab ${i + 1}`, `Cmd+${i + 1}`, `tab.select.${i}`)
        ),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        item('Show Tutorial', 'Cmd+/', 'help.tutorial'),
        {
          label: 'SeaShell on GitHub',
          click: () => void shell.openExternal('https://github.com/voidharbor/seashell'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
