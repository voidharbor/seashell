import { describe, expect, it } from 'vitest'
import { makeTab, reducer, type AppState } from '../../src/renderer/store.js'
import { DEFAULT_ZOOM_INDEX, ZOOM_LEVELS } from '../../src/renderer/term/zoom.js'

const HOME = '/Users/test'

function stateWithTabs(count: number): AppState {
  const tabs = Array.from({ length: count }, () => makeTab(HOME, HOME))
  return {
    tabs,
    activeTabId: tabs[0]!.id,
    sidebarVisible: true,
    explorerRoot: HOME,
    revealPath: null,
    system: null,
    toast: null,
  }
}

/** The only pane of the first tab, which is where the focus starts. */
function firstPane(s: AppState) {
  const tab = s.tabs[0]!
  return tab.panes[tab.focusedPaneId!]!
}

describe('pane.zoomText', () => {
  it('starts from the global rung, not the ladder default', () => {
    // The pane is still following the global level, so the first step has to be
    // relative to what is actually on screen — otherwise zooming a pane while
    // the window is at 160% would yank it back down to near 100%.
    const s = reducer(stateWithTabs(1), { type: 'pane.zoomText', delta: 1, base: 5 })
    expect(firstPane(s).zoomIndex).toBe(6)
  })

  it('steps from its own rung once it has one', () => {
    let s = reducer(stateWithTabs(1), { type: 'pane.zoomText', delta: 1, base: DEFAULT_ZOOM_INDEX })
    s = reducer(s, { type: 'pane.zoomText', delta: 1, base: DEFAULT_ZOOM_INDEX })
    expect(firstPane(s).zoomIndex).toBe(DEFAULT_ZOOM_INDEX + 2)
  })

  it('clamps at both ends of the ladder instead of running off it', () => {
    let s = stateWithTabs(1)
    for (let i = 0; i < 20; i += 1) {
      s = reducer(s, { type: 'pane.zoomText', delta: 1, base: DEFAULT_ZOOM_INDEX })
    }
    expect(firstPane(s).zoomIndex).toBe(ZOOM_LEVELS.length - 1)

    for (let i = 0; i < 40; i += 1) {
      s = reducer(s, { type: 'pane.zoomText', delta: -1, base: DEFAULT_ZOOM_INDEX })
    }
    expect(firstPane(s).zoomIndex).toBe(0)
  })

  it('touches only the focused pane', () => {
    const base = stateWithTabs(1)
    const s = reducer(base, { type: 'pane.zoomText', delta: 1, base: DEFAULT_ZOOM_INDEX })
    const others = Object.values(s.tabs[0]!.panes).filter((p) => p.id !== s.tabs[0]!.focusedPaneId)
    for (const p of others) expect(p.zoomIndex).toBeUndefined()
  })

  it('is a no-op when nothing is focused', () => {
    const base = stateWithTabs(1)
    base.tabs[0]!.focusedPaneId = null
    expect(reducer(base, { type: 'pane.zoomText', delta: 1, base: 2 })).toBe(base)
  })
})

describe('pane.clearTextZoom', () => {
  it('clears overrides across every tab, not just the active one', () => {
    // Global zoom owns all panes; a background tab keeping its override is
    // exactly the bug that would make Reset look broken when you switch tabs.
    let s = stateWithTabs(3)
    s = { ...s, activeTabId: s.tabs[0]!.id }
    s = reducer(s, { type: 'pane.zoomText', delta: 2, base: DEFAULT_ZOOM_INDEX })
    s = { ...s, activeTabId: s.tabs[2]!.id }
    s = reducer(s, { type: 'pane.zoomText', delta: -1, base: DEFAULT_ZOOM_INDEX })

    const before = s.tabs.flatMap((t) => Object.values(t.panes)).filter((p) => p.zoomIndex !== undefined)
    expect(before).toHaveLength(2)

    const cleared = reducer(s, { type: 'pane.clearTextZoom' })
    for (const t of cleared.tabs) {
      for (const p of Object.values(t.panes)) expect(p.zoomIndex).toBeUndefined()
    }
  })

  it('preserves everything else about a pane', () => {
    let s = reducer(stateWithTabs(1), { type: 'pane.zoomText', delta: 1, base: DEFAULT_ZOOM_INDEX })
    const before = firstPane(s)
    const after = firstPane(reducer(s, { type: 'pane.clearTextZoom' }))
    expect({ ...after, zoomIndex: before.zoomIndex }).toEqual(before)
  })
})
