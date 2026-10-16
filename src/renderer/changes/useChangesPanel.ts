import { useEffect, useRef, useState } from 'react'
import { ChangesPanel, type ChangesHost } from '../../core/controller/changes.js'
import { CHANGES_WIDTH_DEFAULT, clampChangesWidth } from '../../core/controller/ui-state.js'
import type { Action, AppState } from '../store.js'

/**
 * The changes column in the Electron window: the same `ChangesPanel` the
 * native core drives (src/core/controller/changes.ts), with this window as its
 * host. Main answers `changes:*` over the preload; the preview page is the
 * native build's page, served as `app://preview/` (src/main/index.ts) and
 * talked to with postMessage instead of WebView2's bridge.
 */

export const PREVIEW_ORIGIN = 'app://preview'
export const PREVIEW_URL = `${PREVIEW_ORIGIN}/index.html`

const WIDTH_KEY = 'seashell.changesWidth'

function storedWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    return v > 0 ? clampChangesWidth(v) : CHANGES_WIDTH_DEFAULT
  } catch {
    return CHANGES_WIDTH_DEFAULT
  }
}

/** `#abc` and `#aabbcc` as `#AABBCC`; anything else as it is. */
function hex(v: string): string {
  const s = v.trim()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (!m) return s
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!
  return `#${h.toUpperCase()}`
}

/** The renderer theme's CSS variables as the core's token names, for the page. */
export function themeTokens(read: (name: string) => string): Record<string, string> {
  const v = (name: string): string => hex(read(name))
  return {
    panel: v('--cardBg'),
    titleText: v('--text'),
    badgeText: v('--dim'),
    titleBar: v('--paneTitleBg'),
    panelBorder: v('--paneBorder'),
    accent: v('--accent'),
    accentText: v('--onAccent'),
    danger: v('--danger'),
    selection: v('--select'),
    badge: v('--chromeAlt'),
    radius: String(parseFloat(read('--paneRadius')) || 6),
  }
}

type Invoke = <T = unknown>(ch: string, p: unknown) => Promise<T>

/** The channels the panel asks for, through the preload's enumerated surface. */
const invoke: Invoke = async <T,>(ch: string, p: unknown): Promise<T> => {
  const api = window.seashell
  switch (ch) {
    case 'projects:sessionIds':
      return (await api.projects.sessionIds(p as never)) as T
    case 'changes:watch':
      return (await api.changes.watch(p as never)) as T
    case 'changes:list':
      return (await api.changes.list(p as never)) as T
    case 'changes:file':
      return (await api.changes.file(p as never)) as T
    case 'open:externalHttp':
      return (await api.open.externalHttp(p as never)) as T
    default:
      throw new Error(`changes: no channel ${ch}`)
  }
}

export interface ChangesDeps {
  state: AppState
  dispatch: (a: Action) => void
  reveal: (path: string, isDir: boolean) => void
  openWithDefaultApp: (path: string) => void
}

export function useChangesPanel(deps: ChangesDeps): {
  panel: ChangesPanel
  rev: number
  frame: React.MutableRefObject<HTMLIFrameElement | null>
} {
  const [rev, setRev] = useState(0)
  const live = useRef(deps)
  live.current = deps
  const frame = useRef<HTMLIFrameElement | null>(null)
  const width = useRef(storedWidth())
  const panelRef = useRef<ChangesPanel | null>(null)
  if (!panelRef.current) {
    const bump = (): void => setRev((n) => n + 1)
    const host: ChangesHost = {
      invoke,
      invokeShell: async <T,>(ch: string, p: unknown): Promise<T> => {
        if (ch !== 'clip:write') throw new Error(`changes: no shell channel ${ch}`)
        try {
          await navigator.clipboard.writeText(String((p as { text?: unknown }).text ?? ''))
          return { ok: true } as T
        } catch {
          return { ok: false } as T
        }
      },
      state: () => live.current.state,
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      },
      changed: bump,
      relayout: bump,
      toast: (message) => live.current.dispatch({ type: 'toast', message }),
      viewCmd: (cmd) => frame.current?.contentWindow?.postMessage({ seashellHost: cmd.message }, PREVIEW_ORIGIN),
      reveal: async (p, isDir) => live.current.reveal(p, isDir),
      openWithDefaultApp: (p) => live.current.openWithDefaultApp(p),
      tokens: () => {
        const cs = getComputedStyle(document.documentElement)
        return themeTokens((n) => cs.getPropertyValue(n))
      },
      width: () => width.current,
      setWidth: (w, save) => {
        width.current = clampChangesWidth(w)
        if (save) {
          try {
            localStorage.setItem(WIDTH_KEY, String(width.current))
          } catch {
            /* the width still applies for this session */
          }
        }
        bump()
      },
    }
    panelRef.current = new ChangesPanel(host)
  }
  const panel = panelRef.current

  // Follows the active tab's zoomed pane on every state change, as the core does after every dispatch.
  useEffect(() => {
    panel.follow()
  })
  useEffect(() => () => panel.stop(), [panel])

  // A pane that closed: main stops tracking its agent session (the shadow stays on disk).
  const known = useRef(new Set<string>())
  useEffect(() => {
    const now = new Set(deps.state.tabs.flatMap((t) => Object.values(t.panes).filter((p) => p.kind === 'term').map((p) => p.id)))
    for (const id of known.current) if (!now.has(id)) void window.seashell.changes.release({ paneId: id }).catch(() => undefined)
    known.current = now
  }, [deps.state.tabs])

  // What the preview page says, from its frame only.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== PREVIEW_ORIGIN) return
      const m = (e.data as { seashellPreview?: unknown } | null)?.seashellPreview
      if (m && typeof m === 'object') panel.view({ type: 'message', message: m })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [panel])

  return { panel, rev, frame }
}
