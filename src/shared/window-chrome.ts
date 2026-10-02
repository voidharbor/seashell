/**
 * [pure] Who draws the window frame, decided once per platform.
 *
 * macOS keeps its native title bar with the traffic lights inset into the tab
 * bar, which is what `hiddenInset` means there. Everywhere else that option
 * is silently ignored: on Linux the window still asked the compositor for a
 * full frame (its _MOTIF_WM_HINTS said "all decorations"), and under WSLg
 * that frame is Weston's own 59px title bar and 38px margins, drawn in a
 * style no Windows user has seen before, with Electron's menu strip under it.
 *
 * So on Linux the window is frameless and the app draws the chrome itself:
 * the tab bar is the title bar, WindowControls.tsx supplies the three
 * buttons, and the menu bar hides until Alt or the ≡ button asks for it.
 * Every accelerator in that menu keeps working while it is hidden.
 *
 * Native Windows is the other way round: it keeps the real DWM caption, so
 * the user's own theme (an OpenGlass Win7 caption, say) draws the title bar,
 * buttons, snap layouts and shadow. Only the menu strip is hidden, and with a
 * native frame Electron fires the menu's accelerators itself.
 */

export interface WindowChrome {
  titleBarStyle?: 'hiddenInset'
  frame?: boolean
  autoHideMenuBar?: boolean
  transparent?: boolean
  hasShadow?: boolean
}

/**
 * The BrowserWindow options that decide the frame, for `process.platform`.
 *
 * Linux is also marked transparent, and that is not about see-through
 * chrome: the page paints opaque from edge to edge. It is the one switch
 * that makes Electron's Linux frame layout reserve NO border. Otherwise a
 * frameless X11 window is laid out with a 4px frame inset on the left, right
 * and bottom (a 1440x900 request comes back 1448x904), painted GTK-grey as a
 * stand-in shadow, and under WSLg that reads as one more border on a window
 * that just lost two. `hasShadow: false` alone only stops the paint and
 * leaves the inset see-through, which over a light window looks like a white
 * frame. `GetRestoredFrameBorderInsets` returns empty insets for a translucent
 * window, so with `transparent` the window is exactly the size asked for.
 * The shadow is turned off as well so a Wayland launch gets the same bare
 * edge; on X11 it makes no difference once the insets are gone. Windows
 * keeps its DWM shadow and needs neither.
 */
export function windowChrome(platform: string): WindowChrome {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  if (platform === 'linux') {
    return { frame: false, autoHideMenuBar: true, transparent: true, hasShadow: false }
  }
  if (platform === 'win32') return { frame: true, autoHideMenuBar: true }
  return { frame: false, autoHideMenuBar: true }
}

/**
 * Whether the renderer draws minimize, maximize and close itself. True only
 * for the frameless platforms; macOS has its traffic lights and Windows its
 * native caption.
 */
export function ownsWindowControls(platform: string): boolean {
  return platform !== 'darwin' && platform !== 'win32'
}
