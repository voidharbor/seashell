import { describe, expect, it } from 'vitest'
import {
  DRAWER_DEFAULT,
  DRAWER_MAX,
  DRAWER_MIN,
  clampDrawer,
  drawerHeightFromDrag,
} from '../../src/renderer/layout/drawer.js'
import { cdCommandFor } from '../../src/renderer/drawer/cd.js'

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
