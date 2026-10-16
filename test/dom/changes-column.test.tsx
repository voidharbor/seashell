import { cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChangesColumn } from '../../src/renderer/changes/ChangesColumn.js'
import { themeTokens } from '../../src/renderer/changes/useChangesPanel.js'
import type { ChangesPanel } from '../../src/core/controller/changes.js'
import type { ChangesModel } from '../../src/core/controller/model.js'

const model = (over: Partial<ChangesModel> = {}): ChangesModel => ({
  paneId: 'p1',
  rect: { x: 600, y: 0, w: 400, h: 700 },
  gripRect: { x: 594, y: 0, w: 6, h: 700 },
  width: 0.38,
  title: 'Changes',
  subtitle: 'Jarvis · 2 files',
  totals: '+4 -1',
  note: null,
  empty: null,
  listRect: { x: 600, y: 44, w: 400, h: 656 },
  groups: [
    {
      id: 'created',
      label: 'Created',
      count: 1,
      folded: false,
      rows: [{ id: 'row:/home/user/proj/new.md', path: '/home/user/proj/new.md', name: 'new.md', dir: '', change: 'created', stat: '+3 -0', added: 3, removed: 0, tooltip: '/home/user/proj/new.md', selected: false }],
    },
    {
      id: 'deleted',
      label: 'Deleted',
      count: 1,
      folded: false,
      rows: [{ id: 'row:/home/user/proj/src/old.ts', path: '/home/user/proj/src/old.ts', name: 'old.ts', dir: 'src', change: 'deleted', stat: '+0 -1', added: 0, removed: 1, tooltip: '/home/user/proj/src/old.ts', selected: true }],
    },
  ],
  rowsSeq: 1,
  headerH: 44,
  rowH: 22,
  groupH: 24,
  preview: null,
  ...over,
})

function fakePanel() {
  const events: Array<[string, string]> = []
  const panel = { event: vi.fn((rest: string, e: { type: string }) => events.push([rest, e.type])) } as unknown as ChangesPanel
  return { panel, events }
}

describe('ChangesColumn', () => {
  afterEach(() => cleanup())
  it('lists the groups and rows with their marks and counts', () => {
    const { panel } = fakePanel()
    const { container, getByText } = render(
      <ChangesColumn model={model()} panel={panel} area={{ x: 0, y: 0, w: 1000, h: 700 }} frame={createRef()} chordLabel="⌘E" />
    )
    expect(getByText('Jarvis · 2 files')).toBeTruthy()
    expect([...container.querySelectorAll('.changes__grouphead')].map((g) => g.textContent)).toEqual(['▸Created1', '▸Deleted1'])
    expect([...container.querySelectorAll('.changes__mark')].map((m) => m.textContent)).toEqual(['A', 'D'])
    expect(container.querySelector('.changes__row--selected .changes__name')?.textContent).toBe('old.ts')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('sends the panel the same events the native shell does', () => {
    const { panel, events } = fakePanel()
    const { container, getByText } = render(
      <ChangesColumn model={model()} panel={panel} area={{ x: 0, y: 0, w: 1000, h: 700 }} frame={createRef()} chordLabel="⌘E" />
    )
    fireEvent.click(getByText('new.md'))
    fireEvent.doubleClick(getByText('new.md'))
    fireEvent.click(container.querySelector('.changes__grouphead')!)
    fireEvent.click(container.querySelector('.changes__hide')!)
    fireEvent.doubleClick(container.querySelector('.changes__grip')!)
    expect(events).toEqual([
      ['row:/home/user/proj/new.md', 'click'],
      ['row:/home/user/proj/new.md', 'dblclick'],
      ['group:created', 'click'],
      ['hide', 'click'],
      ['grip', 'dblclick'],
    ])
  })

  it('shows the preview page in a frame of its own origin only while a row is previewed', () => {
    const { panel } = fakePanel()
    const frame = createRef<HTMLIFrameElement>() as React.MutableRefObject<HTMLIFrameElement | null>
    const { container } = render(
      <ChangesColumn
        model={model({ preview: { rect: { x: 600, y: 300, w: 400, h: 400 }, path: '/home/user/proj/new.md', seq: 1 } })}
        panel={panel}
        area={{ x: 0, y: 0, w: 1000, h: 700 }}
        frame={frame}
        chordLabel="⌘E"
      />
    )
    const iframe = container.querySelector('iframe')!
    expect(iframe.getAttribute('src')).toBe('app://preview/index.html')
    expect(frame.current).toBe(iframe)
  })

  it('shows the note and the empty line', () => {
    const { panel } = fakePanel()
    const { getByText } = render(
      <ChangesColumn
        model={model({ groups: [], empty: 'No changes yet', note: 'Only files the agent wrote directly are listed: this folder is too big to watch.', listRect: { x: 600, y: 84, w: 400, h: 616 } })}
        panel={panel}
        area={{ x: 0, y: 0, w: 1000, h: 700 }}
        frame={createRef()}
        chordLabel="⌘E"
      />
    )
    expect(getByText('No changes yet')).toBeTruthy()
    expect(getByText(/too big to watch/)).toBeTruthy()
  })
})

describe('themeTokens', () => {
  it('maps the renderer theme onto the core’s token names', () => {
    const vars: Record<string, string> = { '--cardBg': ' #161c22', '--text': '#abc', '--paneRadius': '4px', '--accent': 'rgb(1, 2, 3)' }
    const t = themeTokens((n) => vars[n] ?? '')
    expect(t).toMatchObject({ panel: '#161C22', titleText: '#AABBCC', radius: '4', accent: 'rgb(1, 2, 3)' })
  })
})
