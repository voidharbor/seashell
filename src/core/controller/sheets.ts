/**
 * The sheets the core draws through the shell (native design spec section 7):
 * the Settings sheet here, from `src/renderer/settings/SettingsPanel.tsx`.
 * Pure: the shell draws a `SheetModel`, the controller applies its clicks.
 *
 * Only Aero is drawn on the native build, so the other themes, the pane frames
 * and the CRT glass are listed greyed with the tooltip `coming back` (spec 12).
 * Accent and terminal palette work.
 */
import type { Settings } from '../../renderer/settings/settings.js'
import {
  ACCENTS,
  PALETTE_LABELS,
  PALETTE_ORDER,
  PALETTES,
  PANE_STYLE_ORDER,
  PANE_STYLES,
  THEME_ORDER,
  THEMES,
  type PaneStyleKey,
  type PaletteKey,
} from '../../renderer/theme/tokens.js'
import { xtermThemeFrom } from '../../renderer/term/palette.js'
import { chordLabel } from '../../shared/keys.js'
import type { SheetField, SheetModel } from './model.js'

/** The card's width at uiScale 1 (`.sheet__card`: min(620px, 88%)); the shell caps it at 88 percent of the body. */
export const SETTINGS_SHEET_WIDTH = 620

/** The new-pane command's cap (SettingsPanel.tsx `maxLength={200}`). */
export const NEW_PANE_COMMAND_MAX = 200

const COMING_BACK = 'coming back'

/** UI copy here never carries an em dash (U+2014): the renderer's spaced dash becomes ', '. */
const noDash = (s: string): string => s.replace(/\s*\u2014\s*/g, ', ')

/**
 * The check rows, SettingsPanel.tsx:66-100 (GROUPS), titles verbatim. Two
 * details had em dashes, rewritten with a comma and with parentheses.
 */
const CHECKS: Array<{ id: 'attentionGlow' | 'attentionSound' | 'autoColorPanes' | 'autoTitlePanes'; label: string; note: string }> = [
  {
    id: 'attentionGlow',
    label: 'Glow when a pane needs you',
    note: 'A pane breathes its border when its program rings the terminal bell to ask for you, and pulses briefly when a job finishes. Claude Code rings it once preferredNotifChannel is terminal_bell.',
  },
  {
    id: 'attentionSound',
    label: 'Ping when a pane starts glowing',
    note: 'A short, quiet two-tone chime the moment a pane begins asking, not while it keeps asking. Sleep silences it along with the glow, and rapid pings are collapsed into one.',
  },
  {
    id: 'autoColorPanes',
    label: 'Colour new panes automatically',
    note: 'Each new pane gets a colour the tab is not already using, so panes stay distinguishable without tagging them by hand. Colours you set yourself are never overwritten.',
  },
  {
    id: 'autoTitlePanes',
    label: 'Name panes from the running program',
    note: 'Use the title a program sets (an agent session summary, npm run dev) instead of the folder name. Renaming a pane yourself always wins.',
  },
]

/** The check field ids, which are also the `Settings` keys they toggle. */
export const SETTINGS_CHECKS: readonly string[] = CHECKS.map((c) => c.id)

/** The accent option id for a `#rrggbb` key: the hex without `#`. */
export const accentOptionId = (key: string): string => key.replace(/^#/, '')

export function settingsSheet(settings: Settings, platform: string, uiScale = 1): SheetModel {
  const option = (id: string, label: string, selected: boolean, disabled: boolean, tooltip: string | null, swatch: string | null = null) => ({
    id,
    label,
    selected,
    disabled,
    tooltip,
    swatch,
  })
  const appearance: SheetField[] = [
    {
      id: 'theme',
      kind: 'buttons',
      label: 'Theme',
      options: THEME_ORDER.map((k) =>
        k === 'aero'
          ? option(k, THEMES[k].label, true, false, noDash(THEMES[k].note))
          : option(k, THEMES[k].label, false, true, COMING_BACK),
      ),
      // The renderer's detail is the theme's name. Homebrew's own label is
      // `Current`, so the note says which theme is current instead of the button.
      note: `Current: ${noDash(THEMES.aero.name)}`,
    },
    {
      id: 'accent',
      kind: 'buttons',
      label: 'Accent',
      options: [
        option('default', 'Theme default', settings.accent === null, false, null),
        ...ACCENTS.map((a) => option(accentOptionId(a.key), a.label, settings.accent === a.key, false, a.label, a.key)),
      ],
    },
    {
      id: 'palette',
      kind: 'buttons',
      label: 'Terminal palette',
      options: PALETTE_ORDER.map((k) => option(k, PALETTE_LABELS[k], settings.palette === k, false, null)),
      note: 'Recolours the terminals themselves, not just the chrome. Existing scrollback repaints.',
    },
    {
      id: 'paneStyle',
      kind: 'buttons',
      label: 'Pane frame',
      options: PANE_STYLE_ORDER.map((k) =>
        option(k, k === 'theme' ? 'Theme' : PANE_STYLES[k as Exclude<PaneStyleKey, 'theme'>].label, settings.paneStyle === k, true, COMING_BACK),
      ),
    },
    {
      id: 'crt',
      kind: 'buttons',
      label: 'CRT glass',
      options: [
        option('theme', 'Theme', settings.crt === 'theme', true, COMING_BACK),
        option('on', 'On', settings.crt === 'on', true, COMING_BACK),
        option('off', 'Off', settings.crt === 'off', true, COMING_BACK),
      ],
      note: 'Scanlines, flicker and curved glass over the terminal. On for Retro CRT by default, and independent of the theme.',
    },
  ]
  return {
    kind: 'settings',
    title: 'Settings',
    width: SETTINGS_SHEET_WIDTH * uiScale,
    sections: [
      { title: 'Appearance', fields: appearance },
      { title: 'Panes', fields: CHECKS.map((c) => ({ id: c.id, kind: 'check' as const, label: c.label, value: settings[c.id], note: c.note })) },
      {
        title: 'New panes',
        fields: [
          {
            id: 'newPaneCommand',
            kind: 'text',
            label: 'Start new panes with',
            value: settings.newPaneCommand,
            placeholder: 'plain shell',
            maxLen: NEW_PANE_COMMAND_MAX,
            note: 'A command typed into each new pane or tab once its shell is ready, e.g. claude. Leave empty for a plain shell. Exiting the command drops back to that shell.',
          },
        ],
      },
      {
        title: 'Help',
        fields: [
          {
            id: 'tutorial',
            kind: 'button',
            label: 'Tutorial',
            value: 'Show',
            note: `A short tour of the parts that are not obvious. Also on Help ▸ Show Tutorial (${chordLabel('Cmd+/', platform)}).`,
          },
        ],
      },
    ],
    buttons: [{ id: 'done', label: 'Done', isDefault: true, disabled: false }],
    focusField: null,
  }
}

/** The text field's value as SettingsPanel.tsx keeps it: control characters out, at most 200. */
export function cleanNewPaneCommand(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, NEW_PANE_COMMAND_MAX)
}

/**
 * `UiModel.window.palette` for a palette key: xtermThemeFrom over the
 * palette's tokens (palette.ts:79-95), as xterm `ITheme` keys; null for
 * `native`, which keeps the shell's own table.
 */
export function paletteOverride(key: PaletteKey): Record<string, string> | null {
  if (key === 'native') return null
  const vars = PALETTES[key]
  if (!vars) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(xtermThemeFrom(vars))) if (typeof v === 'string') out[k] = v
  return out
}
