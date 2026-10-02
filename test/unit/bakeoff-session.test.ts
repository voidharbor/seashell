import { describe, expect, it } from 'vitest'
import { buildW10 } from '../../scripts/bakeoff/make-session.mjs'
import { isValidProject } from '../../src/main/state/store.js'

describe('W10 session seed', () => {
  const s = buildW10('/Users/joshwald')
  it('is 9 tabs and 10 term panes of plain zsh', () => {
    expect(s.tabs).toHaveLength(9)
    const panes = s.tabs.flatMap((t) => Object.values(t.panes))
    expect(panes).toHaveLength(10)
    expect(panes.every((p) => p.kind === 'term' && p.command === 'zsh' && p.cwd === '/Users/joshwald')).toBe(true)
    expect(Object.keys(s.tabs[0]!.panes)).toHaveLength(2)
  })
  it('validates as a project the real loader would accept', () => {
    expect(isValidProject({ id: 'w10', name: 'w10', savedAt: s.savedAt, tabs: s.tabs })).toBe(true)
    expect(s.schemaVersion).toBe(1)
  })
  it('never carries a claude session id', () => {
    expect(JSON.stringify(s)).not.toMatch(/claudeSessionId/)
  })
})
