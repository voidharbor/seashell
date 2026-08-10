import { describe, expect, it } from 'vitest'
import { canBrief, linkBriefing, newLinkId } from '../../src/renderer/panes/link.js'
import { reducer } from '../../src/renderer/store.js'
import type { AppState, PaneState, TabState } from '../../src/renderer/store.js'

/**
 * Linking two agent panes onto one shared notes file.
 *
 * The briefing is typed into a live agent session, so the rules it has to obey
 * are the same ones the control socket obeys: no control characters, one line,
 * and never into a pane that is not actually running an agent.
 */

describe('linkBriefing', () => {
  it('names the file the agents are to share', () => {
    const b = linkBriefing('/Users/j/Library/Application Support/seashell/links/link-1.md')
    expect(b?.text).toContain('/links/link-1.md')
    expect(b?.text).toMatch(/read it/i)
    expect(b?.text).toMatch(/append/i)
  })

  it('never contains a newline, because the caller owns the Enter', () => {
    const b = linkBriefing('/tmp/notes.md')
    expect(b?.text).not.toContain('\n')
    expect(b?.text).not.toContain('\r')
  })

  it('refuses a path carrying a control character', () => {
    // A briefing that half-typed itself into an agent's prompt, with the rest
    // interpreted as key presses, is worse than no link at all.
    expect(linkBriefing('/tmp/a\x00b.md')).toBeNull()
    expect(linkBriefing('/tmp/a\rb.md')).toBeNull()
    expect(linkBriefing('/tmp/a\x1bb.md')).toBeNull()
    expect(linkBriefing('/tmp/a\x7fb.md')).toBeNull()
  })

  it('refuses an empty path rather than briefing about nothing', () => {
    expect(linkBriefing('')).toBeNull()
    expect(linkBriefing('   ')).toBeNull()
  })
})

describe('canBrief', () => {
  it('only agrees to type into a pane running an agent', () => {
    // An English sentence at a shell prompt is a command line, not a comment.
    expect(canBrief('claude')).toBe(true)
    expect(canBrief('Claude')).toBe(true)
    expect(canBrief('zsh')).toBe(false)
    expect(canBrief('vim')).toBe(false)
    expect(canBrief('')).toBe(false)
    expect(canBrief(undefined)).toBe(false)
  })
})

describe('newLinkId', () => {
  it('produces something main will accept as a filename', () => {
    // main refuses anything that is not a plain id, so the renderer cannot
    // compose a path from its side of the boundary.
    expect(newLinkId(() => 'link-abc123')).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(newLinkId(() => 'link/../../etc/passwd')).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(newLinkId(() => '')).toBe('link')
  })
})

describe('link state', () => {
  const pane = (id: string, over: Partial<PaneState> = {}): PaneState =>
    ({
      id,
      kind: 'term',
      cwd: '/x',
      label: id,
      labelIsCustom: false,
      command: 'claude',
      pid: 1,
      status: 'live',
      ...over,
    }) as PaneState

  const state = (panes: PaneState[]): AppState =>
    ({
      tabs: [
        {
          id: 't1',
          name: 't',
          cwd: '/x',
          pristine: true,
          zoomedPaneId: null,
          focusedPaneId: panes[0]!.id,
          panes: Object.fromEntries(panes.map((p) => [p.id, p])),
          tree: { type: 'row', ratios: [1], children: [] },
        } as unknown as TabState,
      ],
      activeTabId: 't1',
      sidebarVisible: true,
      explorerRoot: '/x',
      revealPath: null,
      system: null,
      toast: null,
    }) as AppState

  it('puts both panes in the same group', () => {
    let s = state([pane('a'), pane('b')])
    s = reducer(s, { type: 'pane.link', paneId: 'a', linkId: 'link-1' })
    s = reducer(s, { type: 'pane.link', paneId: 'b', linkId: 'link-1' })
    expect(s.tabs[0]!.panes.a!.linkId).toBe('link-1')
    expect(s.tabs[0]!.panes.b!.linkId).toBe('link-1')
  })

  it('unlinking one pane leaves the other alone', () => {
    let s = state([pane('a', { linkId: 'link-1' }), pane('b', { linkId: 'link-1' })])
    s = reducer(s, { type: 'pane.unlink', paneId: 'a' })
    expect(s.tabs[0]!.panes.a!.linkId).toBeUndefined()
    expect(s.tabs[0]!.panes.b!.linkId).toBe('link-1')
  })

  it('removes the key rather than blanking it, so unlinked has one spelling', () => {
    let s = state([pane('a', { linkId: 'link-1' })])
    s = reducer(s, { type: 'pane.unlink', paneId: 'a' })
    expect('linkId' in s.tabs[0]!.panes.a!).toBe(false)
  })
})
