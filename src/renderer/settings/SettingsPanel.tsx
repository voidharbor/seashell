import { useEffect, useRef } from 'react'
import type { Settings } from './settings.js'
import {
  ACCENTS,
  PALETTE_LABELS,
  PALETTE_ORDER,
  PANE_STYLES,
  PANE_STYLE_ORDER,
  THEMES,
  THEME_ORDER,
  type PaneStyleKey,
} from '../theme/tokens.js'

/**
 * A labelled row of mutually exclusive choices.
 *
 * Buttons rather than a <select>: there are never more than seven options, the
 * whole point is seeing them at once, and a native menu on a themed sheet is
 * the one control that would refuse to take the theme.
 */
function Segmented<T extends string>(props: {
  label: string
  detail?: string
  options: ReadonlyArray<{ key: T; label: string; title?: string }>
  value: T
  onPick: (key: T) => void
}): React.JSX.Element {
  return (
    <div className="set__seg">
      <span className="set__seglabel">{props.label}</span>
      <span className="set__segbtns">
        {props.options.map((o) => (
          <button
            key={o.key}
            className={o.key === props.value ? 'btn btn--primary' : 'btn'}
            title={o.title}
            onClick={() => props.onPick(o.key)}
          >
            {o.label}
          </button>
        ))}
      </span>
      {props.detail && <span className="set__detail">{props.detail}</span>}
    </div>
  )
}

/**
 * Only the on/off settings belong in this list. Appearance settings are enums
 * and get their own controls below, so narrowing the key type here is what
 * stops a theme key being handed to a checkbox.
 */
type BooleanSettingKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never
}[keyof Settings]

interface Row {
  key: BooleanSettingKey
  title: string
  detail: string
}

/**
 * Grouped so the list reads as sentences about behaviour, not a wall of
 * switches. Each detail says what actually changes, because a toggle labelled
 * only "Attention glow" tells you nothing about what it will do.
 */
const GROUPS: Array<{ heading: string; rows: Row[] }> = [
  {
    heading: 'Panes',
    rows: [
      {
        key: 'attentionGlow',
        title: 'Glow when a pane needs you',
        detail:
          'A pane breathes its border while its program sits waiting for input, and pulses briefly when a job finishes. Never the pane you are focused on.',
      },
      {
        key: 'attentionSound',
        title: 'Ping when a pane starts glowing',
        detail:
          'A short, quiet two-tone chime the moment a pane begins asking — not while it keeps asking. Sleep silences it along with the glow, and rapid pings are collapsed into one.',
      },
      {
        key: 'autoColorPanes',
        title: 'Colour new panes automatically',
        detail:
          'Each new pane gets a colour the tab is not already using, so panes stay distinguishable without tagging them by hand. Colours you set yourself are never overwritten.',
      },
      {
        key: 'autoTitlePanes',
        title: 'Name panes from the running program',
        detail:
          'Use the title a program sets — an agent session summary, npm run dev — instead of the folder name. Renaming a pane yourself always wins.',
      },
      {
        key: 'lookoutCards',
        title: 'Approval cards',
        detail:
          'Raise a card when an agent pane stops on a question. The ◉ button in the Lookout header is the same switch, for turning cards off without coming in here — and turning them off clears whatever is already showing.',
      },
    ],
  },
]

export interface SettingsPanelProps {
  settings: Settings
  onChange: (next: Settings) => void
  onShowTutorial: () => void
  onClose: () => void
}

export function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    props.onChange({ ...props.settings, [key]: value })
  }

  return (
    <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sheet__card">
        <div className="sheet__head">
          <h2 className="sheet__title">Settings</h2>
          <span className="pane__spacer" />
          <button className="btn" onClick={props.onClose}>
            Done
          </button>
        </div>

        <div className="set__group">
          <div className="set__heading">Appearance</div>

          <div className="set__seg">
            <span className="set__seglabel">Theme</span>
            <span className="set__segbtns">
              {THEME_ORDER.map((key) => (
                <button
                  key={key}
                  className={key === props.settings.theme ? 'btn btn--primary' : 'btn'}
                  title={THEMES[key].note}
                  onClick={() => set('theme', key)}
                >
                  {THEMES[key].label}
                </button>
              ))}
            </span>
            <span className="set__detail">{THEMES[props.settings.theme].name}</span>
          </div>

          <div className="set__seg">
            <span className="set__seglabel">Accent</span>
            <span className="set__segbtns">
              <button
                className={props.settings.accent === null ? 'btn btn--primary' : 'btn'}
                onClick={() => set('accent', null)}
              >
                Theme default
              </button>
              {ACCENTS.map((a) => (
                <button
                  key={a.key}
                  className={'set__swatch' + (props.settings.accent === a.key ? ' set__swatch--on' : '')}
                  style={{ background: a.key }}
                  title={a.label}
                  aria-label={a.label}
                  onClick={() => set('accent', a.key)}
                />
              ))}
            </span>
          </div>

          <Segmented
            label="Terminal"
            detail="Recolours the terminals themselves, not just the chrome. Existing scrollback repaints."
            options={PALETTE_ORDER.map((k) => ({ key: k, label: PALETTE_LABELS[k] }))}
            value={props.settings.palette}
            onPick={(k) => set('palette', k)}
          />

          <Segmented
            label="Pane frame"
            options={PANE_STYLE_ORDER.map((k) => ({
              key: k,
              label: k === 'theme' ? 'Theme' : PANE_STYLES[k as Exclude<PaneStyleKey, 'theme'>].label,
            }))}
            value={props.settings.paneStyle}
            onPick={(k) => set('paneStyle', k)}
          />

          <Segmented
            label="CRT glass"
            detail="Scanlines, flicker and curved glass over the terminal. On for Retro CRT by default, and independent of the theme."
            options={[
              { key: 'theme' as const, label: 'Theme' },
              { key: 'on' as const, label: 'On' },
              { key: 'off' as const, label: 'Off' },
            ]}
            value={props.settings.crt}
            onPick={(k) => set('crt', k)}
          />
        </div>

        {GROUPS.map((group) => (
          <div className="set__group" key={group.heading}>
            <div className="set__heading">{group.heading}</div>
            {group.rows.map((row) => (
              <label className="set__row" key={row.key}>
                <input
                  type="checkbox"
                  checked={props.settings[row.key]}
                  onChange={(e) => set(row.key, e.target.checked)}
                />
                <span className="set__text">
                  <span className="set__name">{row.title}</span>
                  <span className="set__detail">{row.detail}</span>
                </span>
              </label>
            ))}
          </div>
        ))}

        <div className="set__group">
          <div className="set__heading">Help</div>
          <div className="set__row">
            <span className="set__text">
              <span className="set__name">Tutorial</span>
              <span className="set__detail">
                A short tour of the parts that are not obvious. Also on Help ▸ Show Tutorial (⌘/).
              </span>
            </span>
            <button className="btn" onClick={props.onShowTutorial}>
              Show
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
