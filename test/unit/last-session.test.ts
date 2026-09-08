import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clearLastSession, loadLastSession, saveLastSession } from '../../src/main/state/last-session.js'
import type { SavedTab } from '../../src/shared/ipc.js'

const tab = (): SavedTab => ({
  id: 't1', name: 'work', nameIsCustom: false, cwd: '/h', zoomedPaneId: null, focusedPaneId: 'p1',
  tree: { type: 'row', ratios: [1], children: [{ type: 'col', ratios: [1], children: [{ type: 'pane', paneId: 'p1' }] }] },
  panes: { p1: { label: 'claude', labelIsCustom: false, kind: 'term', command: 'claude', cwd: '/h', claudeSessionId: '3f2a1b0c-4d5e-6f70-8192-a3b4c5d6e7f8' } },
})

let dir = ''
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seashell-ls-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('last session file', () => {
  it('round-trips', async () => {
    await saveLastSession([tab()], dir)
    const back = await loadLastSession(dir)
    expect(back?.tabs).toEqual([tab()])
    expect(back?.schemaVersion).toBe(1)
    expect(typeof back?.savedAt).toBe('string')
  })
  it('is null when missing, corrupt, or another schema', async () => {
    expect(await loadLastSession(dir)).toBeNull()
    await fs.writeFile(path.join(dir, 'last-session.json'), '{not json')
    expect(await loadLastSession(dir)).toBeNull()
    await fs.writeFile(path.join(dir, 'last-session.json'), JSON.stringify({ schemaVersion: 2, savedAt: 'x', tabs: [] }))
    expect(await loadLastSession(dir)).toBeNull()
  })
  it('clear removes it and tolerates absence', async () => {
    await saveLastSession([tab()], dir)
    await clearLastSession(dir)
    expect(await loadLastSession(dir)).toBeNull()
    await clearLastSession(dir)
  })
})
