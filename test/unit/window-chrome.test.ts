import { describe, expect, it } from 'vitest'
import { ownsWindowControls, windowChrome } from '../../src/shared/window-chrome.js'

/**
 * The frame is decided per platform, and the decision that matters is the
 * one that was wrong: `hiddenInset` is a macOS word. Linux ignores it and
 * shows a full compositor frame, which under WSLg is Weston's grey title bar
 * and margins around a window that then draws Electron's menu strip inside.
 */
describe('window chrome', () => {
  it('keeps the native macOS title bar with the traffic lights inset', () => {
    expect(windowChrome('darwin')).toEqual({ titleBarStyle: 'hiddenInset' })
    expect(ownsWindowControls('darwin')).toBe(false)
  })

  it('is frameless with the menu bar hidden on Linux', () => {
    expect(windowChrome('linux')).toMatchObject({ frame: false, autoHideMenuBar: true })
    expect(ownsWindowControls('linux')).toBe(true)
  })

  it('keeps the native DWM caption on Windows, with only the menu strip hidden', () => {
    expect(windowChrome('win32')).toEqual({ frame: true, autoHideMenuBar: true })
    expect(ownsWindowControls('win32')).toBe(false)
    for (const key of ['titleBarStyle', 'titleBarOverlay', 'transparent', 'hasShadow']) {
      expect(windowChrome('win32')).not.toHaveProperty(key)
    }
  })

  it('marks Linux transparent, the switch that removes the 4px frame inset, and only Linux', () => {
    expect(windowChrome('linux')).toMatchObject({
      transparent: true,
      hasShadow: false,
    })
    for (const platform of ['win32', 'darwin']) {
      expect(windowChrome(platform)).not.toHaveProperty('transparent')
      expect(windowChrome(platform)).not.toHaveProperty('hasShadow')
    }
  })

  it('never hands Linux the macOS-only option it silently ignores', () => {
    expect(windowChrome('linux')).not.toHaveProperty('titleBarStyle')
  })
})
