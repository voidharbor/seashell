// The `electron` alias inside the core bundle: src/core/index.ts puts the live shim on
// globalThis.__seashellCore before src/main loads, so `import { app } from 'electron'` resolves to it.
const s = (globalThis as Record<string, unknown>).__seashellCore as Record<string, unknown>
export const app = s.app,
  BrowserWindow = s.BrowserWindow,
  Menu = s.Menu,
  ipcMain = s.ipcMain,
  net = s.net,
  protocol = s.protocol,
  screen = s.screen,
  shell = s.shell,
  clipboard = s.clipboard,
  dialog = s.dialog
export default s
