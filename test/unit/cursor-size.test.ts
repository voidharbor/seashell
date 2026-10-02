import { describe, expect, it } from 'vitest'
import { WSL_CURSOR_SIZE, wslCursorSize } from '../../src/shared/cursor-size.js'

/**
 * Under WSLg nothing tells Chromium the pointer size, so it divides the X
 * screen's shorter side by 48. Two stacked monitors made that 52 and the
 * pointer came out at 48px. The size is pinned only there.
 */
describe('wsl cursor size', () => {
  const wsl = '6.18.33.2-microsoft-standard-WSL2'

  it('pins the pointer under WSL when nothing set it', () => {
    expect(wslCursorSize('linux', wsl, {})).toBe(WSL_CURSOR_SIZE)
  })

  it('leaves a user-set XCURSOR_SIZE alone', () => {
    expect(wslCursorSize('linux', wsl, { XCURSOR_SIZE: '32' })).toBeNull()
  })

  it('leaves a real Linux desktop and other platforms alone', () => {
    expect(wslCursorSize('linux', '6.8.0-45-generic', {})).toBeNull()
    expect(wslCursorSize('darwin', wsl, {})).toBeNull()
    expect(wslCursorSize('win32', wsl, {})).toBeNull()
  })
})
