import { describe, expect, it } from 'vitest'
import { pickSessionIds } from '../../src/main/state/session-lookup.js'
import { launchCommandText, paneToSaved, savedToPane } from '../../src/renderer/projects/serialize.js'
import type { PaneState } from '../../src/renderer/store.js'
import type { SavedPane } from '../../src/shared/ipc.js'

const SID = '3f2a1b0c-4d5e-6f70-8192-a3b4c5d6e7f8'
const SID2 = '99999999-1111-2222-3333-444444444444'

function pane(extra: Partial<PaneState> = {}): PaneState {
  return {
    id: 'p1',
    kind: 'term',
    cwd: '/Users/j/work',
    label: 'work',
    labelIsCustom: false,
    command: 'zsh',
    pid: 4242,
    status: 'live',
    ...extra,
  }
}

function savedPane(extra: Partial<SavedPane> = {}): SavedPane {
  return {
    label: 'work',
    labelIsCustom: false,
    kind: 'term',
    command: 'claude',
    cwd: '/Users/j/work',
    ...extra,
  }
}

describe('pickSessionIds', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    session_id: SID,
    pane_id: 'p1',
    pid: 100,
    registered_at: 1000,
    ...over,
  })

  it('maps a pane to its registered session, ignoring other panes', () => {
    const out = pickSessionIds(
      [entry(), entry({ pane_id: 'p9', session_id: SID2 })],
      ['p1'],
      () => true
    )
    expect(out).toEqual({ p1: SID })
  })

  it('the newest registration wins — a restarted claude has a new id', () => {
    const out = pickSessionIds(
      [entry({ session_id: SID2, registered_at: 500 }), entry({ registered_at: 2000 })],
      ['p1'],
      () => true
    )
    expect(out).toEqual({ p1: SID })
  })

  it('an entry whose process is dead is not a session to restore', () => {
    const out = pickSessionIds([entry()], ['p1'], () => false)
    expect(out).toEqual({})
  })

  it('malformed session ids and missing pane ids are skipped', () => {
    const out = pickSessionIds(
      [entry({ session_id: 'rm -rf /; echo' }), entry({ pane_id: null, session_id: SID2 })],
      ['p1'],
      () => true
    )
    expect(out).toEqual({})
  })
})

describe('capture — ids recorded per pane', () => {
  it('stamps the session id onto a claude pane at save time', () => {
    const saved = paneToSaved(pane({ command: 'claude' }), SID)
    expect(saved.claudeSessionId).toBe(SID)
  })

  it('a pane not running claude never records a session id', () => {
    const saved = paneToSaved(pane({ command: 'zsh' }), SID)
    expect(saved.claudeSessionId).toBeUndefined()
  })

  it('a preview pane never records a session id', () => {
    const saved = paneToSaved(pane({ kind: 'file', filePath: '/x.md' }), SID)
    expect(saved.claudeSessionId).toBeUndefined()
  })
})

describe('restore', () => {
  it('carries a well-formed session id back into the pane', () => {
    const restored = savedToPane('p-new', savedPane({ claudeSessionId: SID }))
    expect(restored.claudeSessionId).toBe(SID)
  })

  it('drops a tampered session id — the project file is user data', () => {
    const restored = savedToPane('p-new', savedPane({ claudeSessionId: 'x; rm -rf ~' }))
    expect(restored.claudeSessionId).toBeUndefined()
  })

  it('types a visible resume command for a claude pane with a session', () => {
    expect(launchCommandText(pane({ command: 'claude', claudeSessionId: SID }))).toBe(
      `claude -r ${SID}`
    )
  })

  it('a claude pane without a session gets a fresh claude', () => {
    expect(launchCommandText(pane({ command: 'claude' }))).toBe('claude')
  })

  it('a plain shell pane types nothing', () => {
    expect(launchCommandText(pane({ command: 'zsh' }))).toBeNull()
  })

  it('a cmd pane types its own command text, as before', () => {
    expect(launchCommandText(pane({ command: 'cmd', commandText: 'npm run dev' }))).toBe(
      'npm run dev'
    )
  })
})

/**
 * The bug this guards: Josh runs his agents in bypassPermissions, but restore
 * typed a bare `claude -r <id>` — so every resumed session fell back to the
 * settings defaultMode (dontAsk on his machine) and had Bash denied without a
 * prompt. The session's own last mode is recovered from its transcript and
 * relaunched with it, composed from a fixed flag table — never free text.
 */
describe('resumed sessions keep their permission mode', () => {
  it('relaunches a bypassPermissions session the way it was running', () => {
    expect(
      launchCommandText(
        pane({ command: 'claude', claudeSessionId: SID, claudeResumeMode: 'bypassPermissions' })
      )
    ).toBe(`claude --dangerously-skip-permissions -r ${SID}`)
  })

  it('carries the other modes through --permission-mode', () => {
    for (const mode of ['acceptEdits', 'plan', 'auto', 'manual', 'dontAsk'] as const) {
      expect(
        launchCommandText(
          pane({ command: 'claude', claudeSessionId: SID, claudeResumeMode: mode })
        )
      ).toBe(`claude --permission-mode ${mode} -r ${SID}`)
    }
  })

  it('ignores a mode outside the flag table — it composes into a shell', () => {
    expect(
      launchCommandText(
        pane({
          command: 'claude',
          claudeSessionId: SID,
          claudeResumeMode: '; rm -rf ~' as never,
        })
      )
    ).toBe(`claude -r ${SID}`)
  })

  it('never applies a mode without a session to resume', () => {
    expect(
      launchCommandText(pane({ command: 'claude', claudeResumeMode: 'bypassPermissions' }))
    ).toBe('claude')
  })

  it('never saves the mode into a project — it is re-read at open', () => {
    const saved = paneToSaved(
      pane({ command: 'claude', claudeSessionId: SID, claudeResumeMode: 'bypassPermissions' }),
      SID
    )
    expect('claudeResumeMode' in saved).toBe(false)
  })
})
