import { describe, expect, it } from 'vitest'
import {
  DRAWER_DEFAULT,
  DRAWER_MAX,
  DRAWER_MIN,
  clampDrawer,
  drawerHeightFromDrag,
} from '../../src/renderer/layout/drawer.js'
import { cdCommandFor } from '../../src/renderer/drawer/cd.js'
import { DRAWER_PTY_PREFIX, drawerPtyId } from '../../src/renderer/drawer/id.js'
import { paneById, type AppState } from '../../src/renderer/store.js'

describe('clampDrawer', () => {
  it('holds the range', () => {
    expect(clampDrawer(DRAWER_MIN - 40)).toBe(DRAWER_MIN)
    expect(clampDrawer(DRAWER_MAX + 400)).toBe(DRAWER_MAX)
    expect(clampDrawer(300)).toBe(300)
  })

  it('falls back rather than storing garbage', () => {
    expect(clampDrawer(Number.NaN)).toBe(DRAWER_DEFAULT)
    expect(clampDrawer(Number.POSITIVE_INFINITY)).toBe(DRAWER_DEFAULT)
  })
})

describe('drawerHeightFromDrag', () => {
  it('measures up from the drawer bottom, since the drawer is bottom-anchored', () => {
    // Grid bottom at 800, pointer at 500: 300px of drawer.
    expect(drawerHeightFromDrag(500, 800, 1)).toBe(300)
  })

  it('divides the zoom back out so the stored height is zoom-independent', () => {
    expect(drawerHeightFromDrag(350, 800, 1.5)).toBe(300)
  })

  it('treats a nonsense scale as 1 instead of dividing by zero', () => {
    expect(drawerHeightFromDrag(500, 800, 0)).toBe(300)
    expect(drawerHeightFromDrag(500, 800, Number.NaN)).toBe(300)
  })

  it('clamps a drag past either end', () => {
    expect(drawerHeightFromDrag(795, 800, 1)).toBe(DRAWER_MIN) // dragged shut
    expect(drawerHeightFromDrag(-500, 800, 1)).toBe(DRAWER_MAX) // dragged off the top
  })
})

describe('cdCommandFor', () => {
  it('quotes a plain path', () => {
    expect(cdCommandFor('/Users/x/proj')).toBe("cd '/Users/x/proj'")
  })

  it('quotes spaces', () => {
    expect(cdCommandFor('/Users/x/My Folder')).toBe("cd '/Users/x/My Folder'")
  })

  it('escapes embedded single quotes', () => {
    expect(cdCommandFor("/Users/x/it's here")).toBe("cd '/Users/x/it'\\''s here'")
  })

  it('keeps other shell metacharacters inert inside the quotes', () => {
    expect(cdCommandFor('/tmp/$(rm -rf ~)`x`;&|')).toBe("cd '/tmp/$(rm -rf ~)`x`;&|'")
  })

  // The command is typed into a live shell with a trailing Enter, so a control
  // character in the path — above all \r or \n — would submit early and turn a
  // directory name into an executed command. The cwd comes from the pane's
  // shell via OSC 7, which is program-influenced text, not trusted input.
  it('refuses any control character outright', () => {
    expect(cdCommandFor('/tmp/evil\rrm -rf ~')).toBeNull()
    expect(cdCommandFor('/tmp/evil\nx')).toBeNull()
    expect(cdCommandFor('/tmp/ev\x1b[2Jil')).toBeNull()
    expect(cdCommandFor('/tmp/ev\x00il')).toBeNull()
  })

  it('refuses empty and absurdly long paths', () => {
    expect(cdCommandFor('')).toBeNull()
    expect(cdCommandFor('/x'.repeat(3000))).toBeNull()
  })
})

/**
 * The drawer is one shell per pane, so its pty ids share the PtyManager map
 * with every pane's. They must be unmistakable in it: main reaps by id, the
 * renderer routes output by id, and a collision would send an agent's bytes
 * into a scratch shell or vice versa.
 */
describe('drawerPtyId', () => {
  it('namespaces the id so it can never be mistaken for a pane id', () => {
    expect(drawerPtyId('p1')).toBe('drawer:p1')
    expect(drawerPtyId('p1').startsWith(DRAWER_PTY_PREFIX)).toBe(true)
  })

  it('gives each pane its own, which is the whole feature', () => {
    expect(drawerPtyId('p1')).not.toBe(drawerPtyId('p2'))
  })

  it('round-trips back to the pane it belongs to', () => {
    const paneId = 'pane-abc123'
    expect(drawerPtyId(paneId).slice(DRAWER_PTY_PREFIX.length)).toBe(paneId)
  })
})

describe('paneById', () => {
  const state = {
    tabs: [
      { id: 't1', panes: { a: { id: 'a', label: 'first' } } },
      { id: 't2', panes: { b: { id: 'b', label: 'second' } } },
    ],
  } as unknown as AppState

  it('finds a pane in a tab that is not the active one', () => {
    // The drawer mount list is window-wide: a pane keeps its shell while you
    // work in another tab, and rendering it needs that pane's label and cwd.
    expect(paneById(state, 'b')?.label).toBe('second')
  })

  it('finds one in the first tab too', () => {
    expect(paneById(state, 'a')?.label).toBe('first')
  })

  it('returns undefined for a pane that is gone, which is what triggers a reap', () => {
    expect(paneById(state, 'nope')).toBeUndefined()
  })
})
