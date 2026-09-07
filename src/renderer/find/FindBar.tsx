import { useEffect, useRef, useState } from 'react'
import type { FindOptions } from '../term/terminal.js'

export interface FindBarProps {
  /** Ties the bar to whatever it is searching, so switching target resets it. */
  targetKey: string
  onSearch: (query: string, direction: 'next' | 'prev', opts: FindOptions) => boolean
  onClose: () => void
  /** Bumped by the host to re-run the current query from a menu command. */
  nonce: number
  nonceDirection: 'next' | 'prev'
  /** Subscribe to result counts. Absent for targets that cannot count. */
  onResults?: (cb: (r: { resultIndex: number; resultCount: number }) => void) => () => void
  /** What the target supports. Defaults to everything. */
  capabilities?: { regex: boolean; count: boolean }
}

/** How long typing pauses before a search runs. Long enough that a burst of
 *  keystrokes over a 20,000-line buffer costs one search, not one per key. */
export const FIND_DEBOUNCE_MS = 120

/** The addon stops decorating past this many matches. */
const COUNT_CAP = 1000

export function FindBar(props: FindBarProps): React.JSX.Element {
  const caps = props.capabilities ?? { regex: true, count: true }
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [miss, setMiss] = useState(false)
  const [count, setCount] = useState<{ index: number; total: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const lastNonce = useRef(props.nonce)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** True once this bar has actually run a search, so emptying the field only
   *  sends the "drop what you are holding" instruction when there is something
   *  to drop. Without it, opening the bar would clear the pane's selection. */
  const searched = useRef(false)

  const opts = (incremental: boolean): FindOptions => ({ incremental, caseSensitive, regex })

  const search = (q: string, direction: 'next' | 'prev', incremental: boolean): boolean => {
    searched.current = q !== ''
    return props.onSearch(q, direction, opts(incremental))
  }

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [props.targetKey])

  useEffect(() => {
    if (!props.onResults) return
    return props.onResults((r) => setCount({ index: r.resultIndex, total: r.resultCount }))
  }, [props.onResults])

  // Re-issue the current query when the host asks (⌘G / ⌘⇧G).
  useEffect(() => {
    if (props.nonce === lastNonce.current) return
    lastNonce.current = props.nonce
    if (!query) return
    setMiss(!search(query, props.nonceDirection, false))
    // Only the nonce should drive this, never a keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nonce])

  // Search as you type, debounced. Incremental: the addon extends the current
  // match instead of jumping when the query grows by a character.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    if (!query) {
      setMiss(false)
      setCount(null)
      // Emptying the field is an instruction, not a search. The target is
      // holding a match, and something like the terminal's search addon goes on
      // re-selecting it in the background until it is told to let go. The result
      // is neither a hit nor a miss, so it never paints the field red.
      if (!searched.current) return
      debounce.current = setTimeout(() => {
        search('', 'next', true)
      }, FIND_DEBOUNCE_MS)
      return () => {
        if (debounce.current) clearTimeout(debounce.current)
      }
    }
    debounce.current = setTimeout(() => {
      setMiss(!search(query, 'next', true))
    }, FIND_DEBOUNCE_MS)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
    // Toggles re-run the search too, which is what a user flipping them expects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, regex])

  const run = (direction: 'next' | 'prev'): void => {
    if (!query) return
    setMiss(!search(query, direction, false))
  }

  // Shown while there is a query or a result to report, so a count arriving
  // for the last query still reads after the field is cleared.
  const counter =
    caps.count && (query !== '' || count !== null)
      ? `${count ? Math.max(0, count.index + 1) : 0} of ${
          count ? (count.total >= COUNT_CAP ? `${COUNT_CAP}+` : count.total) : 0
        }`
      : null

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
      {counter !== null && <span className="findbar__count">{counter}</span>}
      <button
        className={'btn findbar__toggle' + (caseSensitive ? ' findbar__toggle--on' : '')}
        title="Match case"
        aria-pressed={caseSensitive}
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      {caps.regex && (
        <button
          className={'btn findbar__toggle' + (regex ? ' findbar__toggle--on' : '')}
          title="Regular expression"
          aria-pressed={regex}
          onClick={() => setRegex((v) => !v)}
        >
          .*
        </button>
      )}
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
