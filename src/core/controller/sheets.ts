/**
 * The sheets the core draws through the shell (native design spec section 7):
 * the Settings sheet from `src/renderer/settings/SettingsPanel.tsx`, the
 * Projects sheet from `src/renderer/projects/ProjectsPanel.tsx` and the
 * tutorial from `src/renderer/tutorial/Tutorial.tsx`.
 * Pure: the shell draws a `SheetModel`, the controller applies its clicks.
 *
 * The theme row is the native build's own (`nativeTheme`: System, Aero, Aero
 * Dark and the ported Electron themes; colorization.ts paints them). The pane
 * frames and the CRT glass are listed greyed with the tooltip `coming back`
 * (spec 12). Accent, the tab strip and terminal palette work.
 */
import {
  NATIVE_THEME_ORDER,
  TAB_STRIP_ORDER,
  type NativeThemeKey,
  type Settings,
  type TabStripMode,
} from '../../renderer/settings/settings.js'
import {
  ACCENTS,
  PALETTE_LABELS,
  PALETTE_ORDER,
  PALETTES,
  PANE_STYLE_ORDER,
  PANE_STYLES,
  THEMES,
  type PaneStyleKey,
  type PaletteKey,
} from '../../renderer/theme/tokens.js'
import { xtermThemeFrom } from '../../renderer/term/palette.js'
import { chordLabel } from '../../shared/keys.js'
import type { Project } from '../../shared/ipc.js'
import type { SheetField, SheetModel } from './model.js'
import type { TutorialStep } from './tutorial-steps.js'

/** The card's width at uiScale 1 (`.sheet__card`: min(620px, 88%)); the shell caps it at 88 percent of the body. */
export const SETTINGS_SHEET_WIDTH = 620

/** The new-pane command's cap (SettingsPanel.tsx `maxLength={200}`). */
export const NEW_PANE_COMMAND_MAX = 200

const COMING_BACK = 'coming back'

const TAB_STRIP_LABELS: Record<TabStripMode, string> = { system: 'System', light: 'Light', dark: 'Dark' }

/** UI copy here never carries an em dash (U+2014): the renderer's spaced dash becomes ', '. */
const noDash = (s: string): string => s.replace(/\s*\u2014\s*/g, ', ')

/**
 * The native themes' button labels, names (for the note) and tooltips. The
 * ported ones keep the Electron theme's own words; Homebrew's label there is
 * `Current`, which would read as the selected one here.
 */
const ported = (k: 'mac' | 'macDark' | 'nautical' | 'hacker' | 'homebrew', label = THEMES[k].label) => ({
  label,
  name: noDash(THEMES[k].name),
  note: noDash(THEMES[k].note),
})
const NATIVE_THEMES: Record<NativeThemeKey, { label: string; name: string; note: string }> = {
  system: {
    label: 'System',
    name: 'System',
    note: 'Follows the Windows app theme: Aero Glass while apps are light, Aero Dark while they are dark.',
  },
  aero: { label: THEMES.aero.label, name: noDash(THEMES.aero.name), note: noDash(THEMES.aero.note) },
  aeroDark: {
    label: 'Aero Dark',
    name: 'Aero Dark, Windows 7 glass over dark surfaces',
    note: 'The Aero glass tab strip over Windows 11 dark surfaces, from the panes to the menus and dialogs, with the desktop colour as the accent.',
  },
  graphite: {
    label: 'Graphite',
    name: 'Graphite, flat dark grey with no glass',
    note: 'Flat dark grey from the tab strip to the status bar, no glass and no desktop colour, with SeaShell drawing its own window buttons.',
  },
  mac: ported('mac'),
  macDark: ported('macDark'),
  nautical: ported('nautical'),
  hacker: ported('hacker'),
  homebrew: ported('homebrew', 'Homebrew'),
}

/** The Tab strip setting darkens Aero's strip only; every other theme sets its own. System counts while it can be Aero. */
export const tabStripApplies = (theme: NativeThemeKey): boolean => theme === 'aero' || theme === 'system'

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

/** `appsDark` is the shell's last report, for the note on what System is showing now. */
export function settingsSheet(settings: Settings, platform: string, uiScale = 1, appsDark = false): SheetModel {
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
      options: NATIVE_THEME_ORDER.map((k) => option(k, NATIVE_THEMES[k].label, settings.nativeTheme === k, false, NATIVE_THEMES[k].note)),
      // The renderer's detail is the theme's name.
      note:
        settings.nativeTheme === 'system'
          ? `Current: System, showing ${appsDark ? NATIVE_THEMES.aeroDark.label : NATIVE_THEMES.aero.label} while Windows apps are ${appsDark ? 'dark' : 'light'}.`
          : `Current: ${NATIVE_THEMES[settings.nativeTheme].name}`,
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
      // Plan amendment 10/03 05:40: a dark mode for Aero's tabs only. Greyed under a theme with its own strip.
      id: 'tabStrip',
      kind: 'buttons',
      label: 'Tab strip',
      options: TAB_STRIP_ORDER.map((k) =>
        tabStripApplies(settings.nativeTheme)
          ? option(k, TAB_STRIP_LABELS[k], settings.tabStrip === k, false, null)
          : option(k, TAB_STRIP_LABELS[k], settings.tabStrip === k, true, 'Aero Glass only'),
      ),
      note: tabStripApplies(settings.nativeTheme)
        ? 'For Aero Glass: System follows the Windows app theme. Only the tabs darken; everything below them stays light.'
        : 'For Aero Glass only. This theme sets its own tab strip.',
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

// ---------------------------------------------------------------------------
// The Projects sheet (ProjectsPanel.tsx; inventory row N)
// ---------------------------------------------------------------------------

/** What a save covers (ProjectsPanel.tsx `SaveScope`): the whole window, or the active tab alone. */
export type SaveScope = 'window' | 'tab'

/** The name field's cap (ProjectsPanel.tsx `maxLength={60}`). */
export const PROJECT_NAME_MAX = 60

/** Everything `projectsSheet` draws from: the panel's own state plus the props app.tsx:1784-1799 passes it. */
export interface ProjectsSheetState {
  projects: Project[]
  scope: SaveScope
  name: string
  /** Bumps when the core clears or sets the name itself (`SheetField.rev`). */
  nameRev: number
  confirmDelete: string | null
  currentProject: { id: string; name: string } | null
  tabCount: number
  paneCount: number
  activeTabName: string
  activeTabPaneCount: number
}

/** ProjectsPanel.tsx:47-56, copied (the panel imports React). `now` is ms since the epoch. */
export function whenSaved(iso: string, now: number): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const mins = Math.round((now - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** ProjectsPanel.tsx:58-62, copied. */
export function describeProject(project: Project): string {
  const tabs = project.tabs.length
  const panes = project.tabs.reduce((n, t) => n + Object.keys(t.panes ?? {}).length, 0)
  return `${tabs} tab${tabs === 1 ? '' : 's'} · ${panes} pane${panes === 1 ? '' : 's'}`
}

/** The existing project a save under `name` replaces: a case-insensitive match (ProjectsPanel.tsx:89-91). */
export function projectNamed(projects: readonly Project[], name: string): Project | undefined {
  const want = name.trim().toLowerCase()
  return projects.find((p) => p.name.toLowerCase() === want)
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * ProjectsPanel.tsx:104-241 as a sheet: the scope buttons, `Save “<current>”`
 * at window scope when a project is current, the name field and its save
 * button, the description; then one row per project. Copy is the panel's,
 * verbatim, except its one em dash, which becomes a semicolon.
 */
export function projectsSheet(st: ProjectsSheetState, now: number, uiScale = 1): SheetModel {
  const existing = projectNamed(st.projects, st.name)
  const save: SheetField[] = [
    {
      id: 'scope',
      kind: 'buttons',
      label: '',
      options: [
        { id: 'window', label: 'Whole window', selected: st.scope === 'window', disabled: false, tooltip: null, swatch: null },
        { id: 'tab', label: 'This tab', selected: st.scope === 'tab', disabled: false, tooltip: null, swatch: null },
      ],
      note: st.scope === 'tab' ? 'a project you can add to any window' : 'the whole workspace',
    },
  ]
  if (st.currentProject && st.scope === 'window') {
    save.push({ id: 'saveCurrent', kind: 'button', label: `Save “${st.currentProject.name}”`, note: 'updates the open project in place' })
  }
  const what =
    st.scope === 'tab'
      ? `The tab “${st.activeTabName}” · ${plural(st.activeTabPaneCount, 'pane')} will be saved.`
      : `${plural(st.tabCount, 'tab')} · ${plural(st.paneCount, 'pane')} will be saved.`
  save.push(
    { id: 'name', kind: 'text', label: '', value: st.name, placeholder: 'Project name', maxLen: PROJECT_NAME_MAX, rev: st.nameRev },
    {
      id: 'save',
      kind: 'button',
      label: existing ? 'Overwrite' : st.currentProject ? 'Save as project' : 'Save',
      disabled: st.name.trim() === '',
    },
    {
      id: 'describe',
      kind: 'note',
      label:
        `${what} Layout, directories, names and colours, plus the agent session in each pane ` +
        '(Claude Code, Jarvis, Ultron or opencode); reopening resumes it with a visible ' +
        "`claude -r`, `jarvis --session`, `ultron --session` or `opencode -s` in that pane's shell. " +
        'Other running programs come back as a fresh shell.' +
        (existing ? ' A project with this name already exists and will be replaced.' : ''),
    },
  )
  return {
    kind: 'projects',
    title: 'Projects',
    width: SETTINGS_SHEET_WIDTH * uiScale,
    sections: [
      { title: 'Save what is open', fields: save },
      {
        title: 'Open a project',
        fields: [
          {
            id: 'projects',
            kind: 'rows',
            label: '',
            rows: st.projects.map((p) => ({
              id: p.id,
              name: p.name,
              meta: `${describeProject(p)} · saved ${whenSaved(p.savedAt, now)}`,
              confirming: st.confirmDelete === p.id,
            })),
            ...(st.projects.length === 0 ? { note: 'Nothing saved yet.' } : {}),
          },
        ],
      },
    ],
    buttons: [{ id: 'done', label: 'Done', isDefault: true, disabled: false }],
    focusField: 'name',
  }
}

// ---------------------------------------------------------------------------
// The tutorial (Tutorial.tsx; inventory row T)
// ---------------------------------------------------------------------------

/** The card's width at uiScale 1 (`.tut__card`: min(560px, 86%)). */
export const CLOSE_TAB_SHEET_WIDTH = 380

/**
 * The question before a tab with a live shell closes (its X, `tab.close`, its
 * last pane's X): Enter is the default Close tab, Escape keeps it.
 */
export function closeTabSheet(name: string, panes: number, uiScale = 1): SheetModel {
  const what = panes === 1 ? 'Its pane and whatever is running in it' : `Its ${panes} panes and whatever is running in them`
  return {
    kind: 'closeTab',
    title: 'Close tab?',
    width: CLOSE_TAB_SHEET_WIDTH * uiScale,
    sections: [{ title: name, fields: [{ id: 'note', kind: 'note', label: `${what} will be stopped.` }] }],
    buttons: [
      { id: 'keep', label: 'Keep it', isDefault: false, disabled: false },
      { id: 'close', label: 'Close tab', isDefault: true, disabled: false },
    ],
    focusField: null,
  }
}

export const TUTORIAL_SHEET_WIDTH = 560

/**
 * Tutorial.tsx:293-356 as a sheet: the step counter as the card's title, one
 * section for the step shown (its title, its paragraphs as notes, its key
 * table as a `rows` field with the chord as the name and the action as the
 * meta), the dots as the `step` buttons, the `dontShow` check, then Skip,
 * Back (greyed on the first step) and Next (`Get started` on the last, the
 * default). The shell draws the tutorial's dots and key table its own way.
 */
export function tutorialSheet(steps: readonly TutorialStep[], step: number, dontShow: boolean, uiScale = 1): SheetModel {
  const i = Math.max(0, Math.min(steps.length - 1, step))
  const cur = steps[i]!
  const last = i === steps.length - 1
  const fields: SheetField[] = cur.body.map((text, n) => ({ id: `body${n}`, kind: 'note' as const, label: text }))
  if (cur.keys.length > 0) {
    fields.push({
      id: 'keys',
      kind: 'rows',
      label: '',
      rows: cur.keys.map(([chord, action], n) => ({ id: String(n), name: chord, meta: action, confirming: false })),
    })
  }
  fields.push(
    {
      id: 'step',
      kind: 'buttons',
      label: '',
      options: steps.map((s, n) => ({ id: String(n), label: String(n + 1), selected: n === i, disabled: false, tooltip: s.title, swatch: null })),
    },
    // Tutorial.tsx:240-249 and 330-338; checked by default, so the tour shows once.
    { id: 'dontShow', kind: 'check', label: 'Don’t show this again', value: dontShow },
  )
  return {
    kind: 'tutorial',
    title: `${i + 1} / ${steps.length}`,
    width: TUTORIAL_SHEET_WIDTH * uiScale,
    sections: [{ title: cur.title, fields }],
    buttons: [
      { id: 'skip', label: 'Skip', isDefault: false, disabled: false },
      { id: 'back', label: 'Back', isDefault: false, disabled: i === 0 },
      { id: 'next', label: last ? 'Get started' : 'Next', isDefault: true, disabled: false },
    ],
    focusField: null,
  }
}
