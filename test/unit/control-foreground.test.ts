import { describe, expect, it } from 'vitest'
import { foregroundIsClaude } from '../../src/main/control/foreground.js'

/** Fabricated `ps -t <tty> -o stat=,command=` outputs. */
describe('foregroundIsClaude', () => {
  it('true when claude owns the foreground group', () => {
    const out = ['Ss   /bin/zsh -l', 'S+   claude --dangerously-skip-permissions'].join('\n')
    expect(foregroundIsClaude(out)).toBe(true)
  })

  it('true for the versions-path binary form of claude', () => {
    const out = [
      'Ss   /bin/zsh -l',
      'S+   /Users/joshwald/.local/share/claude/versions/2.1.216 --resume /x.jsonl',
    ].join('\n')
    expect(foregroundIsClaude(out)).toBe(true)
  })

  it('false when the shell itself is foreground — text would execute', () => {
    const out = 'Ss+  /bin/zsh -l'
    expect(foregroundIsClaude(out)).toBe(false)
  })

  it('false when claude is present but backgrounded behind another program', () => {
    const out = ['Ss   /bin/zsh -l', 'S    claude', 'S+   vim notes.txt'].join('\n')
    expect(foregroundIsClaude(out)).toBe(false)
  })

  it('false for a non-claude process that merely has .claude in its arguments', () => {
    const out = ['Ss   /bin/zsh -l', 'S+   node /Users/j/.claude/plugins/foo/server.js'].join('\n')
    expect(foregroundIsClaude(out)).toBe(false)
  })

  it('false on empty ps output', () => {
    expect(foregroundIsClaude('')).toBe(false)
  })
})
