import { app, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { AGENT_KINDS, type AgentKind } from '../../shared/agents.js'
import { CH, type ChangesFileResponse, type ChangesListResponse } from '../../shared/ipc.js'
import { recordSourceFor } from './sources.js'
import { ChangeTracker } from './tracker.js'

/** Shadow repositories nobody has looked at for this long are removed at start. */
const SHADOW_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const PaneId = z.string().min(1).max(128)
const WatchReq = z.object({
  paneId: PaneId,
  kind: z.enum(AGENT_KINDS as [AgentKind, ...AgentKind[]]),
  sid: z.string().max(64).optional(),
  cwd: z.string().min(1).max(4096).startsWith('/'),
})
const PaneReq = z.object({ paneId: PaneId })
const FileReq = z.object({ paneId: PaneId, path: z.string().min(1).max(4096).startsWith('/') })

async function pruneShadows(dir: string, now: number): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!/^[0-9a-f]{20}$/.test(name)) continue
    try {
      const st = await fs.stat(path.join(dir, name))
      if (now - st.mtimeMs > SHADOW_MAX_AGE_MS) await fs.rm(path.join(dir, name), { recursive: true, force: true })
    } catch {
      /* gone already */
    }
  }
}

/**
 * The `changes:*` handlers. win32 (Electron on Windows, whose panes live in
 * WSL behind a UNC path) has no tracker: every call answers as if the pane
 * ran no agent. `claudeHome` is where `.claude/` lives when it is not home.
 */
export function registerChangesIpc(platformId: NodeJS.Platform, claudeHome: () => Promise<string | undefined | null>): void {
  let tracker: ChangeTracker | null = null
  const get = (): ChangeTracker | null => {
    if (platformId === 'win32') return null
    if (tracker) return tracker
    const userData = app.getPath('userData')
    const home = os.homedir()
    let claude: string | undefined
    void claudeHome().then((h) => {
      claude = h ?? undefined
    })
    void pruneShadows(path.join(userData, 'changes'), Date.now())
    tracker = new ChangeTracker({
      userData,
      home,
      now: () => Date.now(),
      recordFor: (s) => recordSourceFor(s, home, () => Date.now(), claude),
    })
    return tracker
  }

  ipcMain.handle(CH.changesWatch, async (_e, raw) => {
    const parsed = WatchReq.safeParse(raw)
    if (!parsed.success) return { ok: false }
    get()?.watch(parsed.data.paneId, parsed.data)
    return { ok: true }
  })
  ipcMain.handle(CH.changesRelease, async (_e, raw) => {
    const parsed = PaneReq.safeParse(raw)
    if (parsed.success) get()?.release(parsed.data.paneId)
    return { ok: true }
  })
  ipcMain.handle(CH.changesList, async (_e, raw): Promise<ChangesListResponse | null> => {
    const parsed = PaneReq.safeParse(raw)
    if (!parsed.success) return null
    return (await get()?.list(parsed.data.paneId)) ?? null
  })
  ipcMain.handle(CH.changesFile, async (_e, raw): Promise<ChangesFileResponse> => {
    const parsed = FileReq.safeParse(raw)
    const t = get()
    if (!parsed.success || !t) return { ok: false, code: 'ENOENT', message: 'No such change' }
    return t.file(parsed.data.paneId, parsed.data.path)
  })
}
