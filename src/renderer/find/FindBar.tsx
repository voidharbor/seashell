import { useEffect, useRef, useState } from 'react'

export interface FindBarProps {
  /** Ties the bar to whatever it is searching, so switching target resets it. */
  targetKey: string
  onSearch: (query: string, direction: 'next' | 'prev') => boolean
  onClose: () => void
  /** Bumped by the host to re-run the current query from a menu command. */
  nonce: number
  /** Which way the host's nonce bump wants to move. */
  nonceDirection: 'next' | 'prev'
}

/**
 * A find bar over a terminal or the file viewer.
 *
 * Deliberately not a controlled search-as-you-type against the PTY buffer:
 * xterm's search walks the whole scrollback, and re-running it on every
 * keystroke over a 5000-line buffer is enough work to stutter the pane the user
 * is typing into. It searches on submit and on the explicit next/prev commands.
 */
export function FindBar(props: FindBarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [miss, setMiss] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const lastNonce = useRef(props.nonce)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [props.targetKey])

  // Re-issue the current query when the host asks (⌘G / ⌘⇧G).
  useEffect(() => {
    if (props.nonce === lastNonce.current) return
    lastNonce.current = props.nonce
    if (!query) return
    setMiss(!props.onSearch(query, props.nonceDirection))
    // Only the nonce should drive this, never a keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nonce])

  const run = (direction: 'next' | 'prev'): void => {
    if (!query) return
    setMiss(!props.onSearch(query, direction))
  }

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        className={'findbar__input' + (miss ? ' findbar__input--miss' : '')}
        value={query}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value)
          setMiss(false)
        }}
        onKeyDown={(e) => {
          // Stop every key here from reaching the terminal underneath.
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            run(e.shiftKey ? 'prev' : 'next')
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose()
          }
        }}
      />
      <button className="btn findbar__btn" title="Previous (⇧⏎)" onClick={() => run('prev')}>
        ↑
      </button>
      <button className="btn findbar__btn" title="Next (⏎)" onClick={() => run('next')}>
        ↓
      </button>
      <button className="btn findbar__btn" title="Close (esc)" onClick={props.onClose}>
        ✕
      </button>
    </div>
  )
}
