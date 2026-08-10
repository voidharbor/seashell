import { useCallback, useEffect, useRef, useState } from 'react'
import type { FsDirEntry } from '../../shared/ipc.js'
import type { RevealTarget } from '../store.js'
import { expandChain } from './chain.js'
import { FileIcon, FolderIcon } from './icons.js'

/**
 * U+200E, written as an escape because it is invisible in source.
 *
 * The path strip truncates from the left via `direction: rtl`, which also
 * changes how the bidi algorithm places the path's leading `/` — a neutral
 * character with no strong character before it takes the paragraph direction
 * and gets rendered at the far end, so `/Users/j/a.ts` displays as
 * `Users/j/a.ts/`. Putting a strong left-to-right character first makes every
 * separator inherit that direction and the path renders as written.
 */
const LEFT_TO_RIGHT_MARK = '\u200e'

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

function displayRoot(root: string, home: string): string {
  return root === home ? 'Home' : (root.split('/').filter(Boolean).pop() ?? root)
}

interface DirState {
  entries: FsDirEntry[]
  truncated: boolean
  error?: string
}

export interface ExplorerProps {
  root: string
  /** Used only to show "Home" instead of a long absolute path in the header. */
  home: string
  /** Path to expand to and highlight — set by a double-click in a terminal. */
  revealPath: RevealTarget | null
  /** Bumped by ⌘R. Re-reads every directory currently expanded. */
  refreshNonce: number
  onRevealHandled: () => void
  onOpenInViewer: (path: string) => void
  onToast: (message: string) => void
}

export function Explorer(props: ExplorerProps): React.JSX.Element {
  const { root, revealPath } = props
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]))
  const [selected, setSelected] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(
    null
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)

  /**
   * Context-menu dismissal, ColorPicker's pattern: pointerdown in capture
   * phase (a click listener fires after focus has already moved, which reads
   * as a laggy close) plus Escape. Bound only while a menu is open.
   */
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.ctx')) setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setMenu(null)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  const load = useCallback(async (dir: string): Promise<void> => {
    const res = await window.seashell.fs.readDir({ path: dir, respectGitignore: true })
    setDirs((prev) => ({
      ...prev,
      [dir]: res.ok
        ? { entries: res.entries, truncated: res.truncated }
        : { entries: [], truncated: false, error: res.code },
    }))
  }, [])

  useEffect(() => {
    setExpanded(new Set([root]))
    setDirs({})
    // A selection from the previous root is not a selection under this one, and
    // leaving it would strand the path strip on a path no longer in the tree.
    setSelected(null)
    void load(root)
  }, [root, load])

  /**
   * ⌘R. Re-reads every directory that is currently open rather than only the
   * root — a refresh that left every expanded subdirectory stale would be
   * indistinguishable from a refresh that did nothing, since the thing the user
   * is looking at is usually nested.
   */
  const refresh = useCallback(() => {
    for (const dir of expanded) void load(dir)
  }, [expanded, load])

  const firstRefresh = useRef(true)
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false
      return
    }
    refresh()
    // Only the nonce drives this; `refresh` changes on every expand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshNonce])

  const toggle = useCallback(
    (dir: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(dir)) {
          next.delete(dir)
        } else {
          next.add(dir)
          if (!dirs[dir]) void load(dir)
        }
        return next
      })
    },
    [dirs, load]
  )

  /**
   * Reveal, not open.
   *
   * A double-click on a path in a terminal expands the tree to it, scrolls it
   * into view and highlights it — and stops there. Opening is a separate,
   * deliberate act, so a stray double-click can never launch a heavy app.
   */
  useEffect(() => {
    if (!revealPath) return
    const target = revealPath.path
    let cancelled = false

    void (async () => {
      // A directory is expanded, not merely selected — the chain includes the
      // folder itself. A file still expands nothing past its parent.
      //
      // Every chain directory is re-read, cached or not. The revealed path was
      // just stat'ed as existing, which makes it *newer* than any cached
      // listing — a file created after its parent was listed has no row, and
      // selecting a row that does not exist is a silent no-op that presents as
      // "double-click does nothing". A reveal is rare and user-initiated;
      // a few readDirs is nothing next to looking dead.
      const chain = expandChain(target, root, revealPath.isDir)
      for (const dir of chain) {
        if (cancelled) return
        await load(dir)
      }
      if (cancelled) return
      setExpanded((prev) => new Set([...prev, ...chain]))
      setSelected(target)
      setRevealed(target)
      props.onRevealHandled()

      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(
          `[data-path="${CSS.escape(target)}"]`
        )
        el?.scrollIntoView({ block: 'center' })
      })
      setTimeout(() => setRevealed((r) => (r === target ? null : r)), 2500)
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPath, root])

  const activate = useCallback(
    async (fullPath: string, isDir: boolean) => {
      if (isDir) {
        toggle(fullPath)
        return
      }
      const probe = await window.seashell.fs.probe({ path: fullPath })
      if (!probe.exists) {
        props.onToast('File no longer exists')
        return
      }
      switch (probe.route) {
        case 'viewer':
          props.onOpenInViewer(fullPath)
          break
        case 'os': {
          const res = await window.seashell.open.withDefaultApp({ path: fullPath })
          if (!res.ok && res.error === 'refused-executable') {
            props.onToast('That file is executable — revealed in Finder instead')
          } else if (!res.ok) {
            props.onToast(`Could not open: ${res.error ?? 'unknown error'}`)
          }
          break
        }
        case 'too-large':
          props.onToast('Too large to preview — opening with the default app')
          await window.seashell.open.withDefaultApp({ path: fullPath })
          break
        case 'binary':
        case 'reveal':
          await window.seashell.open.revealInFinder({ path: fullPath })
          break
      }
    },
    [toggle, props]
  )

  const renderDir = (dir: string, depth: number): React.JSX.Element[] => {
    const state = dirs[dir]
    if (!state) return []
    if (state.error) {
      return [
        <div key={`${dir}!err`} className="node node--ignored" style={{ paddingLeft: 8 + depth * 12 }}>
          <span className="node__name">({state.error})</span>
        </div>,
      ]
    }

    const out: React.JSX.Element[] = []
    for (const entry of state.entries) {
      const full = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`
      const isOpen = expanded.has(full)
      out.push(
        <div
          key={full}
          data-path={full}
          className={
            'node' +
            (selected === full ? ' node--selected' : '') +
            (revealed === full ? ' node--revealed' : '') +
            (entry.ignored ? ' node--ignored' : '')
          }
          style={{ paddingLeft: 6 + depth * 13 }}
          onClick={() => setSelected(full)}
          onDoubleClick={() => void activate(full, entry.isDir)}
          onContextMenu={(e) => {
            e.preventDefault()
            setSelected(full)
            setMenu({ x: e.clientX, y: e.clientY, path: full, isDir: entry.isDir })
          }}
          title={full}
        >
          <span
            className={'node__twisty' + (entry.isDir && isOpen ? ' node__twisty--open' : '')}
            onClick={(e) => {
              // Finder toggles from the triangle without changing selection.
              if (!entry.isDir) return
              e.stopPropagation()
              toggle(full)
            }}
          >
            {entry.isDir ? '▶' : ''}
          </span>
          {entry.isDir ? <FolderIcon open={isOpen} /> : <FileIcon ext={extOf(entry.name)} />}
          <span className="node__name">{entry.name}</span>
        </div>
      )
      if (entry.isDir && isOpen) out.push(...renderDir(full, depth + 1))
    }
    if (state.truncated) {
      out.push(
        <div key={`${dir}!trunc`} className="node node--ignored" style={{ paddingLeft: 8 + depth * 12 }}>
          <span className="node__name">… too many entries to list</span>
        </div>
      )
    }
    return out
  }

  // Nothing selected is the normal case on launch, and the root is the honest
  // answer to "where am I" — never a leftover path from a previous selection.
  const shownPath = selected ?? root

  return (
    <div className="sidebar">
      <div className="sidebar__head">
        {/* A section title, matching the Lookout header above it, rather than
            the root folder's name. Which folder the tree is rooted at is
            already answered by the path readout along the bottom, and by the
            tree's own first row; the header's job is to say what the panel is.
            It used to read "Home", which named the folder and looked like a
            breadcrumb that had lost the rest of itself. */}
        <span title={displayRoot(root, props.home)}>File Browser</span>
        <span className="sidebar__refresh" title="Refresh (⌘R)" onClick={refresh}>
          ⟳
        </span>
      </div>
      {/* Retro's card-index drawer pull. Every other theme leaves --pullH
          unset, so the strip is zero-height and invisible rather than
          conditional on the theme — the explorer does not know what a theme
          is, which is the whole point of the token set. */}
      <div className="sidebar__pull" aria-hidden="true">
        <span className="sidebar__grip2" />
      </div>

      <div className="sidebar__tree" ref={scrollRef}>
        <div
          className={'node' + (selected === root ? ' node--selected' : '')}
          onClick={() => setSelected(root)}
          onDoubleClick={() => toggle(root)}
          title={root}
        >
          <span
            className={'node__twisty' + (expanded.has(root) ? ' node__twisty--open' : '')}
            onClick={(e) => {
              e.stopPropagation()
              toggle(root)
            }}
          >
            ▶
          </span>
          <FolderIcon open={expanded.has(root)} />
          <span className="node__name">{displayRoot(root, props.home)}</span>
        </div>
        {expanded.has(root) && renderDir(root, 1)}
      </div>

      {/*
        Right-click menu. Two verbs, deliberately: in-pane preview owns
        double-click, so the menu is for the explicit exceptions — hand the
        file to the OS anyway, or go find it in Finder. Position is fixed at
        the pointer; the sidebar's own overflow would clip an absolute child.
      */}
      {menu && (
        <div className="ctx" style={{ left: menu.x, top: menu.y }}>
          {!menu.isDir && (
            <button
              className="ctx__item"
              onClick={() => {
                const p = menu.path
                setMenu(null)
                void window.seashell.open.withDefaultApp({ path: p }).then((res) => {
                  if (!res.ok && res.error === 'refused-executable') {
                    props.onToast('That file is executable — revealed in Finder instead')
                  } else if (!res.ok) {
                    props.onToast(`Could not open: ${res.error ?? 'unknown error'}`)
                  }
                })
              }}
            >
              Open Outside SeaShell
            </button>
          )}
          <button
            className="ctx__item"
            onClick={() => {
              const p = menu.path
              setMenu(null)
              void window.seashell.open.revealInFinder({ path: p })
            }}
          >
            Reveal in Finder
          </button>
        </div>
      )}

      {/*
        Where the selected thing actually is.

        Until now the only way to see a full path was the native `title` tooltip
        on each row: you had to hover and wait, it vanished the moment you
        moved, and it could not be copied. Selecting a row should simply tell
        you.

        Deliberately the last flex child and `flex: none` — the tree is what
        flexes. A strip that reflowed the tree on every selection change would
        be worse than no strip at all.
      */}
      <div
        className="sidebar__path"
        title="Click to copy"
        onClick={() => {
          void navigator.clipboard.writeText(shownPath).then(
            // A silent copy reads as a dead click, so it always says so.
            () => props.onToast('Copied path'),
            () => props.onToast('Could not copy the path')
          )
        }}
      >
        {/*
          Truncates from the *left*, so the filename — the part being looked
          for — always survives. The leading marker forces the first strong
          character to be left-to-right: without it the `direction: rtl` that
          moves the ellipsis to the front also drags the path's leading slash
          around to the end, rendering `Users/j/a.ts/`.
        */}
        {LEFT_TO_RIGHT_MARK + shownPath}
      </div>
    </div>
  )
}
