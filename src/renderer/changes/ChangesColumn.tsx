import { useRef } from 'react'
import type { ChangesPanel } from '../../core/controller/changes.js'
import type { ChangesModel, Rect } from '../../core/controller/model.js'
import { PREVIEW_URL } from './useChangesPanel.js'

/**
 * The changes column beside a zoomed agent pane (the native shell draws the
 * same model in ui/changes.cpp): the files the session created, edited and
 * deleted, grouped, and below them the preview page in a frame of its own
 * origin while a row is selected. Positions are the model's, relative to the
 * grid area this is rendered in.
 */
export interface ChangesColumnProps {
  model: ChangesModel
  panel: ChangesPanel
  /** The grid area, for the grip's drag. */
  area: Rect
  frame: React.MutableRefObject<HTMLIFrameElement | null>
  /** The column's chord, for the hide button's title. */
  chordLabel: string
}

const MARK: Record<string, string> = { created: 'A', edited: 'M', deleted: 'D' }

function box(r: Rect): React.CSSProperties {
  return { left: r.x, top: r.y, width: r.w, height: r.h }
}

export function ChangesColumn(props: ChangesColumnProps): React.JSX.Element {
  const { model: m, panel, area } = props
  const gridLeft = useRef(0)

  const startGrip = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const host = (e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect()
    gridLeft.current = host?.left ?? 0
    panel.event('grip', { type: 'down', x: e.clientX - gridLeft.current, button: 0 }, area)
    document.body.classList.add('dragging')
    const move = (ev: MouseEvent): void => panel.event('grip', { type: 'move', x: ev.clientX - gridLeft.current }, area)
    const up = (ev: MouseEvent): void => {
      panel.event('grip', { type: 'up', x: ev.clientX - gridLeft.current }, area)
      document.body.classList.remove('dragging')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const click = (rest: string, dbl = false): void => panel.event(rest, { type: dbl ? 'dblclick' : 'click', button: 0 }, area)
  const plus = m.totals.split(' ')[0] ?? ''
  const minus = m.totals.split(' ')[1] ?? ''
  const listTop = m.listRect.y - m.rect.y

  return (
    <>
      <div
        className="changes__grip"
        style={box(m.gripRect)}
        title="Drag to resize"
        onMouseDown={startGrip}
        onDoubleClick={() => panel.event('grip', { type: 'dblclick' }, area)}
      />
      <div className="changes" style={box(m.rect)}>
        <div className="changes__head" style={{ height: m.headerH }}>
          <div className="changes__titles">
            <div className="changes__title">{m.title}</div>
            <div className="changes__subtitle">{m.subtitle}</div>
          </div>
          {m.totals && (
            <div className="changes__totals">
              <span className="changes__add">{plus}</span> <span className="changes__del">{minus}</span>
            </div>
          )}
          <button className="changes__hide" title={`Hide changes (${props.chordLabel})`} onClick={() => click('hide')}>
            ×
          </button>
        </div>
        {m.note && (
          <div className="changes__note" style={{ height: listTop - m.headerH }}>
            {m.note}
          </div>
        )}
        <div className="changes__list" style={{ height: m.listRect.h }}>
          {m.empty && <div className="changes__empty">{m.empty}</div>}
          {m.groups.map((g) => (
            <div key={g.id} className="changes__group">
              <div className="changes__grouphead" style={{ height: m.groupH }} onClick={() => click(`group:${g.id}`)}>
                <span className={'changes__twisty' + (g.folded ? '' : ' changes__twisty--open')}>▸</span>
                {g.label}
                <span className="changes__count">{g.count}</span>
              </div>
              {!g.folded &&
                g.rows.map((r) => (
                  <div
                    key={r.id}
                    className={'changes__row changes__row--' + r.change + (r.selected ? ' changes__row--selected' : '')}
                    style={{ height: m.rowH }}
                    title={r.tooltip}
                    onClick={() => click(r.id)}
                    onDoubleClick={() => click(r.id, true)}
                  >
                    <span className="changes__name">{r.name}</span>
                    {r.dir && <span className="changes__dir">{r.dir}</span>}
                    <span className="changes__spacer" />
                    {r.stat && (
                      <span className="changes__stat">
                        {(r.added > 0 || r.change !== 'deleted') && <span className="changes__add">+{r.added}</span>}
                        {(r.removed > 0 || r.change !== 'created') && <span className="changes__del">-{r.removed}</span>}
                      </span>
                    )}
                    <span className={'changes__mark changes__mark--' + r.change}>{MARK[r.change]}</span>
                  </div>
                ))}
            </div>
          ))}
        </div>
        {m.preview && (
          <iframe
            ref={props.frame}
            className="changes__preview"
            src={PREVIEW_URL}
            title="Preview"
            referrerPolicy="no-referrer"
            style={{ height: m.preview.rect.h }}
          />
        )}
      </div>
    </>
  )
}
