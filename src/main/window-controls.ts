import { BrowserWindow, ipcMain, Menu, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { CH } from '../shared/ipc.js'

/**
 * The window buttons, off macOS.
 *
 * There the window is frameless (shared/window-chrome.ts) so nothing native
 * draws minimize, maximize or close; the renderer draws them and these are
 * what they do. Each acts on the window that sent the message, so a message
 * can never reach a window it did not come from, and a webview guest cannot
 * send one at all: guests get no preload, so no ipcRenderer.
 *
 * Close goes through `close()`, never `destroy()`, so the quit ladder in
 * index.ts runs exactly as it does for the macOS traffic light.
 */
export function registerWindowControls(): void {
  const from = (e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  ipcMain.on(CH.windowMinimize, (e) => from(e)?.minimize())
  ipcMain.on(CH.windowToggleMaximize, (e) => {
    const win = from(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(CH.windowClose, (e) => from(e)?.close())
  ipcMain.handle(CH.windowIsMaximized, (e) => from(e)?.isMaximized() ?? false)

  // The application menu still exists with its bar hidden, accelerators and
  // all; this only gives it somewhere to be seen.
  ipcMain.on(CH.windowMenu, (e) => {
    const win = from(e)
    if (win) Menu.getApplicationMenu()?.popup({ window: win })
  })
}

/** Tells the renderer when maximized flips, so the middle button redraws. */
export function reportMaximized(win: BrowserWindow): void {
  const send = (maximized: boolean) => (): void => {
    if (!win.isDestroyed()) win.webContents.send(CH.windowMaximized, { maximized })
  }
  win.on('maximize', send(true))
  win.on('unmaximize', send(false))
}
