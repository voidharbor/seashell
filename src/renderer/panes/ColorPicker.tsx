import { useEffect, useRef } from 'react'
import { PANE_COLORS, paneColorHex, type PaneColorKey } from './colors.js'

export interface ColorPickerProps {
  current: PaneColorKey | undefined
  onPick: (color: PaneColorKey | null) => void
  onClose: () => void
}

/**
 * The pane's colour-tag popover.
 *
 * Anchored inside the pane rather than rendered to a portal at the window root.
 * A portal would need the pane's live screen rect to position itself, and that
 * rect changes on every divider drag, zoom toggle and window resize — three
 * things that already have their own layout paths. Keeping it in the pane means
 * it moves with the pane for free.
 */
export function ColorPicker(props: ColorPickerProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Pointerdown, not click: a click listener fires after the terminal
    // underneath has already taken focus, so the popover would visibly close a
    // frame late and the pane would flicker focus on the way past.
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) props.onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [props])

  return (
    <div className="swatches" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      {PANE_COLORS.map((c) => (
        <button
          key={c.key}
          className={'swatch' + (props.current === c.key ? ' swatch--on' : '')}
          style={{ background: c.hex }}
          title={c.label}
          aria-label={c.label}
          onClick={() => {
            // Picking the colour a pane already has clears it, so the same
            // control both sets and unsets without a separate "remove" step.
            props.onPick(props.current === c.key ? null : c.key)
            props.onClose()
          }}
        />
      ))}
      <button
        className={'swatch swatch--none' + (props.current === undefined ? ' swatch--on' : '')}
        title="No colour"
        aria-label="No colour"
        onClick={() => {
          props.onPick(null)
          props.onClose()
        }}
      />
    </div>
  )
}

/** The always-visible dot in the title bar that opens the picker. */
export function ColorDot(props: {
  color: PaneColorKey | undefined
  onClick: () => void
}): React.JSX.Element {
  const hex = paneColorHex(props.color)
  return (
    <span
      className={'pane__dot' + (hex ? '' : ' pane__dot--empty')}
      style={hex ? { background: hex, borderColor: hex } : undefined}
      title="Colour this pane"
      onClick={(e) => {
        e.stopPropagation()
        props.onClick()
      }}
    />
  )
}
