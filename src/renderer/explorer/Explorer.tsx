import { useCallback, useEffect, useRef, useState } from 'react'
import type { FsDirEntry } from '../../shared/ipc.js'
import { FileIcon, FolderIcon } from './icons.js'

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
  revealPath: string | null
  onRevealHandled: () => void
  onOpenInViewer: (path: string) => void
  onToast: (message: string) => void
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function ancestorsOf(p: string, root: string): string[] {
  const out: string[] = []
  let cur = parentOf(p)
  while (cur.startsWith(root) && cur.length >= root.length) {
    out.unshift(cur)
    if (cur === root) break
    cur = parentOf(cur)
  }
  return out
}

export function Explorer(props: ExplorerProps): React.JSX.Element {
  const { root, revealPath } = props
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]))
  const [selected, setSelected] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

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
    void load(root)
  }, [root, load])

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
    let cancelled = false

    void (async () => {
      const chain = ancestorsOf(revealPath, root)
      for (const dir of chain) {
        if (cancelled) return
        if (!dirs[dir]) await load(dir)
      }
      if (cancelled) return
      setExpanded((prev) => new Set([...prev, ...chain]))
      setSelected(revealPath)
      setRevealed(revealPath)
      props.onRevealHandled()

      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(
          `[data-path="${CSS.escape(revealPath)}"]`
        )
        el?.scrollIntoView({ block: 'center' })
      })
      setTimeout(() => setRevealed((r) => (r === revealPath ? null : r)), 2500)
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

  return (
    <div className="sidebar">
      <div className="sidebar__head">
        <span>{displayRoot(root, props.home)}</span>
        <span className="sidebar__refresh" title="Refresh (⌘R)" onClick={() => void load(root)}>
          ⟳
        </span>
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
    </div>
  )
}
