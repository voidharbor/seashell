import { describe, expect, it } from 'vitest'
import { parseLastPermissionMode } from '../../src/main/state/resume-mode.js'

const line = (obj: unknown) => JSON.stringify(obj)

describe('parseLastPermissionMode', () => {
  it('finds the mode a permission-mode event recorded', () => {
    const lines = [
      line({ type: 'user', message: {} }),
      line({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' }),
    ]
    expect(parseLastPermissionMode(lines)).toBe('bypassPermissions')
  })

  it('reads the mode stamped on an ordinary message entry', () => {
    const lines = [line({ type: 'user', permissionMode: 'acceptEdits', message: {} })]
    expect(parseLastPermissionMode(lines)).toBe('acceptEdits')
  })

  it('the LAST recorded mode wins — the user cycled mid-session', () => {
    const lines = [
      line({ type: 'permission-mode', permissionMode: 'bypassPermissions' }),
      line({ type: 'user', permissionMode: 'plan' }),
    ]
    expect(parseLastPermissionMode(lines)).toBe('plan')
  })

  it('refuses a mode outside the known set — the transcript is a file on disk', () => {
    const lines = [line({ type: 'permission-mode', permissionMode: '--exec evil' })]
    expect(parseLastPermissionMode(lines)).toBeNull()
  })

  it('skips garbage lines without giving up', () => {
    const lines = [
      line({ type: 'permission-mode', permissionMode: 'dontAsk' }),
      'not json at all {{{',
      '',
    ]
    expect(parseLastPermissionMode(lines)).toBe('dontAsk')
  })

  it('returns null for a transcript that never mentions a mode', () => {
    expect(parseLastPermissionMode([line({ type: 'user', message: {} })])).toBeNull()
  })
})
