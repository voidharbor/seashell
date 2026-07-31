import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
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
        item('New Pane', 'Cmd+D', 'pane.new'),
        item('New Pane in New Column', 'Cmd+Shift+D', 'pane.newColumn'),
        { type: 'separator' },
        item('Close Pane', 'Cmd+W', 'pane.close'),
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
        item('Find in Pane', 'Cmd+F', 'edit.find'),
        item('Clear Pane', 'Cmd+K', 'pane.clear'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Toggle Zoom', 'Cmd+Return', 'pane.zoom'),
        item('Rebalance Panes', 'Cmd+Shift+R', 'layout.rebalance'),
        { type: 'separator' },
        item('Toggle File Explorer', 'Cmd+B', 'explorer.toggle'),
        item('Focus File Explorer', 'Cmd+Shift+E', 'explorer.focus'),
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
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
