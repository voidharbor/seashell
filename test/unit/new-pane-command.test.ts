import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, coerceSettings } from '../../src/renderer/settings/settings.js'
import { reducer, type AppState } from '../../src/renderer/store.js'
import { launchCommandText } from '../../src/renderer/projects/serialize.js'

/**
 * The command a new pane starts with is typed into a live shell followed by
 * Enter, so the one thing it must never do is carry a newline or control byte
 * out of localStorage: that would run something other than what the field shows.
 */
describe('newPaneCommand setting', () => {
  it('defaults to a plain shell', () => {
    expect(DEFAULT_SETTINGS.newPaneCommand).toBe('')
    expect(coerceSettings({}).newPaneCommand).toBe('')
  })

  it('keeps a one-line command, trimmed', () => {
    expect(coerceSettings({ newPaneCommand: '  codex ' }).newPaneCommand).toBe('codex')
  })

  it('rejects control bytes, over-long values and non-strings', () => {
    expect(coerceSettings({ newPaneCommand: 'codex\nrm -rf ~' }).newPaneCommand).toBe('')
    expect(coerceSettings({ newPaneCommand: 'a\x1b[31m' }).newPaneCommand).toBe('')
    expect(coerceSettings({ newPaneCommand: 'x'.repeat(201) }).newPaneCommand).toBe('')
    expect(coerceSettings({ newPaneCommand: 42 }).newPaneCommand).toBe('')
  })
})

describe('tab.new with a command', () => {
  const empty = { tabs: [], activeTabId: null } as unknown as AppState

  it('starts a plain shell when no command is given', () => {
    const s = reducer(empty, { type: 'tab.new', cwd: '/h', home: '/h' })
    const pane = Object.values(s.tabs[0]!.panes)[0]!
    expect(pane.command).toBe('zsh')
    expect(launchCommandText(pane)).toBeNull()
  })

  it('types the command into the first pane', () => {
    const s = reducer(empty, { type: 'tab.new', cwd: '/h', home: '/h', commandText: 'codex' })
    const pane = Object.values(s.tabs[0]!.panes)[0]!
    expect(pane.command).toBe('cmd')
    expect(launchCommandText(pane)).toBe('codex')
  })
})
