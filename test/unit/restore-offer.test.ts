import { describe, expect, it } from 'vitest'
import { shouldOfferRestore } from '../../src/renderer/session/offer.js'
import type { SavedTab } from '../../src/shared/ipc.js'

const t = (panes: Array<'zsh' | 'claude' | 'cmd'>): SavedTab => ({
  id: 't', name: 'n', nameIsCustom: false, cwd: '/h', zoomedPaneId: null, focusedPaneId: null, tree: {},
  panes: Object.fromEntries(panes.map((c, i) => [`p${i}`, { label: c, labelIsCustom: false, kind: 'term', command: c, cwd: '/h' }])),
})

describe('shouldOfferRestore', () => {
  it('does not offer a single fresh shell', () => {
    expect(shouldOfferRestore([t(['zsh'])])).toBe(false)
    expect(shouldOfferRestore([])).toBe(false)
  })
  it('offers anything with an agent, a command, two panes or two tabs', () => {
    expect(shouldOfferRestore([t(['claude'])])).toBe(true)
    expect(shouldOfferRestore([t(['cmd'])])).toBe(true)
    expect(shouldOfferRestore([t(['zsh', 'zsh'])])).toBe(true)
    expect(shouldOfferRestore([t(['zsh']), t(['zsh'])])).toBe(true)
  })
})
