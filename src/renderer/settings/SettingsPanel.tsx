import { useEffect, useRef } from 'react'
import type { Settings } from './settings.js'

interface Row {
  key: keyof Settings
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
        key: 'autoTitlePanes',
        title: 'Name panes from the running program',
        detail:
          'Use the title a program sets — an agent session summary, npm run dev — instead of the folder name. Renaming a pane yourself always wins.',
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

  const set = (key: keyof Settings, value: boolean): void => {
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
