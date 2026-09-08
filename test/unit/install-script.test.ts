import { describe, expect, it } from 'vitest'
import { buildInstallScript } from '../../src/main/update/install-script.js'

const input = {
  pid: 4242,
  zipPath: '/ud/updates/SeaShell-0.6.0-universal.zip',
  stagingDir: '/ud/updates/staging',
  appPath: '/Applications/SeaShell.app',
  expectedVersion: '0.6.0',
  logPath: '/ud/updates/install.log',
}

describe('buildInstallScript', () => {
  const s = buildInstallScript(input)
  it('waits for the app to exit before touching anything', () => {
    expect(s.indexOf('kill -0 4242')).toBeGreaterThan(-1)
    expect(s.indexOf('kill -0 4242')).toBeLessThan(s.indexOf('ditto'))
  })
  it('verifies the staged version before swapping', () => {
    expect(s).toContain('CFBundleShortVersionString')
    expect(s.indexOf('"0.6.0"')).toBeLessThan(s.indexOf('mv "$APP"'))
  })
  it('moves the old app aside, never deletes it first, and rolls back on failure', () => {
    expect(s).toContain('mv "$APP" "$OLD"')
    expect(s).toContain('mv "$OLD" "$APP"')
    expect(s).toContain('xattr -dr com.apple.quarantine "$APP"')
    expect(s).toContain('open -a "$APP"')
  })
  it('quotes every path', () => {
    for (const p of [input.zipPath, input.stagingDir, input.appPath, input.logPath]) expect(s).toContain(`"${p}"`)
  })
})
