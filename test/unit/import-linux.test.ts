import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  MARKER_FILE,
  planLinuxImport,
  resolveDistro,
  runLinuxImport,
  wslStateDir,
  type ImportFs,
} from '../../src/main/state/import-linux.js'

const SRC = '\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\.config\\seashell'
const TARGET = path.join('/tmp', 'seashell-import-target')

function memFs(files: Record<string, string>): ImportFs & { files: Map<string, string>; writes: string[] } {
  const m = new Map(Object.entries(files))
  const writes: string[] = []
  return {
    files: m,
    writes,
    exists: async (p) => m.has(p),
    readFile: async (p) => {
      const v = m.get(p)
      if (v === undefined) throw new Error('ENOENT')
      return Buffer.from(v)
    },
    writeNew: async (p, data) => {
      if (m.has(p)) throw new Error('EEXIST')
      writes.push(p)
      m.set(p, data.toString())
    },
    mkdirp: async () => {},
  }
}

const deps = (fs: ImportFs, over: Partial<Parameters<typeof runLinuxImport>[0]> = {}) => ({
  platform: 'win32' as NodeJS.Platform,
  userData: TARGET,
  env: {},
  fs,
  linuxHome: async () => '/Users/joshwald',
  now: () => new Date('2026-10-01T12:00:00Z'),
  ...over,
})

describe('planLinuxImport', () => {
  const base = { platform: 'win32' as NodeJS.Platform, targetDir: TARGET, targetHas: new Set<string>(), sourceDir: SRC, sourceHas: new Set(['projects.json', 'last-session.json']) }

  it('copies both files on a fresh win32 userData', () => {
    const plan = planLinuxImport(base)
    expect(plan.action).toBe('copy')
    if (plan.action !== 'copy') return
    expect(plan.copies).toEqual([
      { from: `${SRC}\\projects.json`, to: path.join(TARGET, 'projects.json') },
      { from: `${SRC}\\last-session.json`, to: path.join(TARGET, 'last-session.json') },
    ])
    expect(plan.markerPath).toBe(path.join(TARGET, MARKER_FILE))
  })
  it('never copies window.json', () => {
    const plan = planLinuxImport({ ...base, sourceHas: new Set(['window.json', 'projects.json']) })
    expect(plan.action === 'copy' && plan.copies.map((c) => path.win32.basename(c.from))).toEqual(['projects.json'])
  })
  it('skips off win32', () => {
    expect(planLinuxImport({ ...base, platform: 'linux' })).toEqual({ action: 'skip', reason: 'not win32' })
  })
  it('skips when either target file exists', () => {
    expect(planLinuxImport({ ...base, targetHas: new Set(['projects.json']) }).action).toBe('skip')
    expect(planLinuxImport({ ...base, targetHas: new Set(['last-session.json']) }).action).toBe('skip')
  })
  it('skips after a previous import', () => {
    expect(planLinuxImport({ ...base, targetHas: new Set([MARKER_FILE]) })).toEqual({ action: 'skip', reason: 'already imported' })
  })
  it('skips when the source is unresolved or empty', () => {
    expect(planLinuxImport({ ...base, sourceDir: null }).action).toBe('skip')
    expect(planLinuxImport({ ...base, sourceHas: new Set() }).action).toBe('skip')
  })
})

describe('wslStateDir and resolveDistro', () => {
  it('builds the UNC path', () => {
    expect(wslStateDir('Ubuntu-24.04', '/Users/joshwald\n')).toBe(SRC)
  })
  it('rejects a non-absolute or traversing home', () => {
    expect(wslStateDir('Ubuntu-24.04', 'joshwald')).toBeNull()
    expect(wslStateDir('Ubuntu-24.04', '/home/../etc')).toBeNull()
    expect(wslStateDir('Ubuntu-24.04', '')).toBeNull()
  })
  it('reads the distro from env with a fallback', () => {
    expect(resolveDistro({})).toBe('Ubuntu-24.04')
    expect(resolveDistro({ SEASHELL_WSL_DISTRO: ' Debian ' })).toBe('Debian')
  })
})

describe('runLinuxImport', () => {
  it('copies the files, writes a marker, and never writes the Linux side', async () => {
    const fs = memFs({ [`${SRC}\\projects.json`]: 'P', [`${SRC}\\last-session.json`]: 'L', [`${SRC}\\window.json`]: 'W' })
    const r = await runLinuxImport(deps(fs))
    expect(r.reason).toBe('imported')
    expect(fs.files.get(path.join(TARGET, 'projects.json'))).toBe('P')
    expect(fs.files.get(path.join(TARGET, 'last-session.json'))).toBe('L')
    expect(fs.files.has(path.join(TARGET, 'window.json'))).toBe(false)
    expect(fs.writes.every((w) => w.startsWith(TARGET))).toBe(true)
    const marker = JSON.parse(fs.files.get(path.join(TARGET, MARKER_FILE)) ?? '{}')
    expect(marker).toMatchObject({ importedAt: '2026-10-01T12:00:00.000Z', distro: 'Ubuntu-24.04', sourceDir: SRC })
    expect(marker.files).toEqual([`${SRC}\\projects.json`, `${SRC}\\last-session.json`])
  })
  it('does not ask wsl.exe when userData already has state', async () => {
    const fs = memFs({ [path.join(TARGET, 'projects.json')]: 'mine' })
    let asked = false
    const r = await runLinuxImport(deps(fs, { linuxHome: async () => { asked = true; return '/x' } }))
    expect(asked).toBe(false)
    expect(r.imported).toEqual([])
    expect(fs.writes).toEqual([])
  })
  it('does nothing off win32', async () => {
    const fs = memFs({ [`${SRC}\\projects.json`]: 'P' })
    expect((await runLinuxImport(deps(fs, { platform: 'linux' }))).reason).toBe('not win32')
    expect(fs.writes).toEqual([])
  })
  it('survives an unreadable home and a throwing fs', async () => {
    const fs = memFs({})
    expect((await runLinuxImport(deps(fs, { linuxHome: async () => null }))).reason).toBe('linux home not resolved')
    const bad: ImportFs = { ...fs, exists: async () => { throw new Error('boom') } }
    expect((await runLinuxImport(deps(bad))).reason).toBe('error')
  })
  it('uses the env distro', async () => {
    const dsrc = '\\\\wsl.localhost\\Debian\\home\\j\\.config\\seashell'
    const fs = memFs({ [`${dsrc}\\last-session.json`]: 'L' })
    const r = await runLinuxImport(deps(fs, { env: { SEASHELL_WSL_DISTRO: 'Debian' }, linuxHome: async () => '/home/j' }))
    expect(r.imported).toEqual([`${dsrc}\\last-session.json`])
  })
})

describe('the import copy itself', () => {
  it('never overwrites, and never leaves a partial or temp file behind', async () => {
    const { writeNewAtomic } = await import('../../src/main/state/import-linux.js')
    const nfs = await import('node:fs/promises')
    const nos = await import('node:os')
    const npath = await import('node:path')
    const dir = await nfs.mkdtemp(npath.join(nos.tmpdir(), 'import-atomic-'))
    try {
      const target = npath.join(dir, 'projects.json')
      await writeNewAtomic(target, '{"a":1}')
      expect(await nfs.readFile(target, 'utf8')).toBe('{"a":1}')
      await expect(writeNewAtomic(target, '{"b":2}')).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await nfs.readFile(target, 'utf8')).toBe('{"a":1}')
      expect(await nfs.readdir(dir)).toEqual(['projects.json'])
    } finally {
      await nfs.rm(dir, { recursive: true, force: true })
    }
  })

  it('waits for an async distro answer', async () => {
    const { runLinuxImport } = await import('../../src/main/state/import-linux.js')
    const seen: string[] = []
    const r = await runLinuxImport({
      platform: 'win32',
      userData: 'C:\\Users\\j\\AppData\\Roaming\\seashell',
      env: {},
      distro: async () => 'Debian',
      fs: {
        exists: async (p) => {
          seen.push(p)
          return false
        },
        readFile: async () => Buffer.from(''),
        writeNew: async () => {},
        mkdirp: async () => {},
      },
      linuxHome: async () => '/home/j',
      now: () => new Date(0),
    })
    expect(r.reason).toBe('no linux state found')
    expect(seen.some((p) => p.includes('\\Debian\\'))).toBe(true)
  })
})
