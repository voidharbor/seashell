import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.js'
import { applyTheme, themeVars } from './theme/apply.js'
import { setCurrentXtermTheme } from './theme/live.js'
import { xtermThemeFrom } from './term/palette.js'
import { loadSettings } from './settings/settings.js'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

/**
 * The theme goes on before React renders anything.
 *
 * Settings live in localStorage precisely so they are readable without waiting
 * on IPC, and applying here rather than in an effect is the difference between
 * the window appearing in the chosen theme and it appearing in the stylesheet's
 * default for a frame and then flipping.
 */
{
  const s = loadSettings()
  const choice = {
    theme: s.theme,
    paneStyle: s.paneStyle,
    palette: s.palette,
    crt: s.crt,
    accent: s.accent,
  }
  applyTheme(document.documentElement, choice)

  /**
   * The xterm half has to be set here too, not left to App's effect.
   *
   * React runs child effects before parent effects, so a pane's terminal is
   * constructed before App's appearance effect ever runs. Seeding the holder
   * first is what stops the first terminals in the window being built with the
   * previous palette and only repainting on the next theme change.
   */
  setCurrentXtermTheme(xtermThemeFrom(themeVars(choice)))
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
