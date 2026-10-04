import { describe, expect, it, vi } from 'vitest'
import { createShim } from '../../src/core/electron-shim.js'

function make() {
  const out: string[] = []
  const pushes: Array<[string, unknown]> = []
  const shim = createShim({ write: (l) => out.push(l), hostPid: 4242, userData: '/mnt/c/scratch/ud', version: '0.6.0', onPush: (ch, p) => pushes.push([ch, p]) })
  return { out, pushes, shim }
}

describe('electron shim', () => {
  it('app paths and identity come from the options', () => {
    const { shim } = make()
    expect(shim.app.getPath('userData')).toBe('/mnt/c/scratch/ud')
    expect(shim.app.getVersion()).toBe('0.6.0')
    expect(shim.app.requestSingleInstanceLock()).toBe(true)
  })
  it('is packaged only when the shell says it is the installed build', () => {
    const base = { write: () => {}, hostPid: 1, userData: '/u', version: '0.6.0', onPush: () => {} }
    expect(createShim({ ...base, installed: true }).app.isPackaged).toBe(true)
    expect(createShim({ ...base, installed: false }).app.isPackaged).toBe(false)
  })
  it('webContents.send writes pty:data and ui:model to the pipe and routes everything else to onPush', () => {
    const { out, pushes, shim } = make()
    const wc = shim.BrowserWindow.getAllWindows()[0]!.webContents
    wc.send('pty:data', { batches: [] })
    wc.send('metrics:tick', { panes: [], system: null })
    expect(JSON.parse(out.at(-1)!)).toEqual({ k: 'on', ch: 'pty:data', p: { batches: [] } })
    expect(pushes).toEqual([['metrics:tick', { panes: [], system: null }]])
  })
  it('pty:data batches cross the pipe as base64 of the UTF-8 bytes', () => {
    const { out, shim } = make()
    shim.BrowserWindow.getAllWindows()[0]!.webContents.send('pty:data', { batches: [{ paneId: 'p1', data: 'joshwald % \u00e9\u{1F600}' }] })
    const sent = JSON.parse(out.at(-1)!)
    expect(sent).toMatchObject({ k: 'on', ch: 'pty:data', p: { batches: [{ paneId: 'p1' }] } })
    expect(Buffer.from(sent.p.batches[0].data, 'base64').toString('utf8')).toBe('joshwald % \u00e9\u{1F600}')
  })
  it('an invoke from the shell is answered by the ipcMain handler with the same id', async () => {
    const { out, shim } = make()
    shim.ipcMain.handle('fs:probe', async (_e, p: { path: string }) => ({ exists: p.path === '/yes' }))
    await shim.dispatch({ k: 'invoke', ch: 'fs:probe', id: 9, p: { path: '/yes' } })
    expect(JSON.parse(out.at(-1)!)).toEqual({ k: 'reply', ch: 'fs:probe', id: 9, p: { exists: true } })
  })
  it('an invoke with no handler replies with ENOHANDLER instead of hanging', async () => {
    const { out, shim } = make()
    await shim.dispatch({ k: 'invoke', ch: 'nope:x', id: 10, p: {} })
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ k: 'reply', id: 10, p: { ok: false, code: 'ENOHANDLER' } })
  })
  it('invokeLocal calls a handler in process and sendLocal fires listeners', async () => {
    const { shim } = make()
    shim.ipcMain.handle('app:getPaths', () => ({ home: '/Users/joshwald' }))
    const seen = vi.fn()
    shim.ipcMain.on('pty:write', (_e, p) => seen(p))
    expect(await shim.invokeLocal('app:getPaths', {})).toEqual({ home: '/Users/joshwald' })
    shim.sendLocal('pty:write', { paneId: 'a', data: 'x' })
    expect(seen).toHaveBeenCalledWith({ paneId: 'a', data: 'x' })
  })
  it('shell and clipboard are invokes toward the shell, resolved by its reply', async () => {
    const { out, shim } = make()
    const p = shim.shell.openPath('/Users/joshwald/a.txt')
    const sent = JSON.parse(out.at(-1)!)
    expect(sent).toMatchObject({ k: 'invoke', ch: 'open:withDefaultApp', p: { path: '/Users/joshwald/a.txt' } })
    await shim.dispatch({ k: 'reply', ch: 'open:withDefaultApp', id: sent.id, p: { ok: true } })
    expect(await p).toBe('')
  })
  it('an invoke the shell does not answer in 10 s rejects with ETIMEOUT, and a late reply is dropped', async () => {
    vi.useFakeTimers()
    try {
      const out: string[] = []
      const logs: string[] = []
      const shim = createShim({ write: (l) => out.push(l), hostPid: 4242, userData: '/u', version: '0.6.0', onPush: () => {}, log: (l) => logs.push(l) })
      const answered = shim.invokeShell('clip:write', { text: 'a' })
      const firstId = JSON.parse(out.at(-1)!).id
      const silent = shim.invokeShell('clip:write', { text: 'b' })
      const silentId = JSON.parse(out.at(-1)!).id
      const caught = silent.catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(9_999)
      await shim.dispatch({ k: 'reply', ch: 'clip:write', id: firstId, p: { ok: true } })
      expect(await answered).toEqual({ ok: true })
      await vi.advanceTimersByTimeAsync(1)
      const err = (await caught) as Error & { code?: string }
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toBe('ETIMEOUT')
      expect(logs).toEqual([`[core] the shell did not answer clip:write (id ${silentId}) in 10000 ms`])
      // The late reply finds nothing pending and changes nothing.
      await shim.dispatch({ k: 'reply', ch: 'clip:write', id: silentId, p: { ok: true } })
      // The answered invoke's timer was cleared: nothing else times out.
      await vi.advanceTimersByTimeAsync(20_000)
      expect(logs).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('the folder picker waits on the user and never times out', async () => {
    vi.useFakeTimers()
    try {
      const out: string[] = []
      const shim = createShim({ write: (l) => out.push(l), hostPid: 4242, userData: '/u', version: '0.6.0', onPush: () => {}, log: () => {} })
      const pick = shim.dialog.showOpenDialog()
      const id = JSON.parse(out.at(-1)!).id
      let settled = false
      void pick.then(() => (settled = true), () => (settled = true))
      await vi.advanceTimersByTimeAsync(120_000)
      expect(settled).toBe(false)
      await shim.dispatch({ k: 'reply', ch: 'app:pickFolder', id, p: { ok: true, path: '/home/joshwald/x' } })
      expect(await pick).toEqual({ canceled: false, filePaths: ['/home/joshwald/x'] })
    } finally {
      vi.useRealTimers()
    }
  })
  it('the virtual window takes what createWindow and the window controls call, and does nothing but minimize and close', async () => {
    const { out, pushes, shim } = make()
    const win = new (shim.BrowserWindow as unknown as new (o: unknown) => ReturnType<typeof shim.BrowserWindow.getAllWindows>[number])({ width: 1440 })
    expect(win).toBe(shim.BrowserWindow.getAllWindows()[0])
    const wc = win.webContents
    expect(wc.on('will-attach-webview', vi.fn())).toBe(wc)
    expect(wc.once('did-finish-load', vi.fn())).toBe(wc)
    wc.setWindowOpenHandler(vi.fn())
    expect(wc.isLoading()).toBe(false)
    expect(win.on('close', vi.fn()).once('ready-to-show', vi.fn()).off('close', vi.fn())).toBe(win)
    expect(win.isMaximized()).toBe(false)
    expect(win.isVisible()).toBe(true)
    expect(win.getNormalBounds()).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    win.maximize()
    win.unmaximize()
    win.minimize()
    win.close()
    await win.loadURL('app://seashell/index.html')
    expect(shim.BrowserWindow.fromWebContents(wc)).toBe(win)
    expect(shim.BrowserWindow.fromWebContents({})).toBeNull()
    // The menu's Window items (menu.ts): the shell minimizes and closes its own window.
    expect(out.map((l) => JSON.parse(l)).map((e) => [e.k, e.ch])).toEqual([['invoke', 'window:minimize'], ['invoke', 'window:close']])
    expect(pushes).toEqual([])
  })
  it('Menu keeps the template and draws nothing', () => {
    const { shim } = make()
    const m = shim.Menu.buildFromTemplate([{ label: 'File', submenu: [{ label: 'New Pane', accelerator: 'Ctrl+Shift+D', click: vi.fn() }] }])
    shim.Menu.setApplicationMenu(m)
    expect(shim.Menu.getApplicationMenu()?.items[0]?.submenu?.items[0]?.accelerator).toBe('Ctrl+Shift+D')
  })
  it('a send with no ipcMain listener is routed to onPush for the controller', async () => {
    const { pushes, shim } = make()
    await shim.dispatch({ k: 'send', ch: 'ui:command', p: { command: 'tab.new' } })
    expect(pushes).toEqual([['ui:command', { command: 'tab.new' }]])
  })
  it('app:secondInstance from the shell raises second-instance', async () => {
    const { shim } = make()
    const seen = vi.fn()
    shim.app.on('second-instance', seen)
    await shim.dispatch({ k: 'send', ch: 'app:secondInstance', p: {} })
    expect(seen).toHaveBeenCalled()
  })
})
