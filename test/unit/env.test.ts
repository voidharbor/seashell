import { describe, expect, it } from 'vitest'
import { buildEnv, resolveUserZdotdir } from '../../src/main/pty/env.js'

const SHIM = '/Users/j/Library/Application Support/seashell/zdotdir'
const HOME = '/Users/j'

const base = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOME,
  PATH: '/usr/bin:/bin',
  ...extra,
})

/**
 * The nesting bug this guards against, in full:
 *
 * SeaShell launched from inside a SeaShell pane inherits ZDOTDIR pointing at
 * SeaShell's own shim. Trusting that makes SEASHELL_USER_ZDOTDIR the shim
 * directory, so the shim's .zshrc sources itself — forever. zsh reports it as
 * "job table full or recursion limit exceeded", which names neither the shim
 * nor the nesting, and the pane still reaches a prompt with none of the user's
 * configuration loaded. Observed live, not hypothetical.
 */
describe('resolveUserZdotdir', () => {
  it('uses HOME when nothing is inherited', () => {
    expect(resolveUserZdotdir(base(), SHIM)).toBe(HOME)
  })

  it('honours a genuine user ZDOTDIR', () => {
    expect(resolveUserZdotdir(base({ ZDOTDIR: '/Users/j/dotfiles' }), SHIM)).toBe(
      '/Users/j/dotfiles'
    )
  })

  it('refuses our own shim as the user dotfile location', () => {
    expect(resolveUserZdotdir(base({ ZDOTDIR: SHIM }), SHIM)).toBe(HOME)
  })

  it('ignores a trailing slash when recognising the shim', () => {
    expect(resolveUserZdotdir(base({ ZDOTDIR: `${SHIM}/` }), SHIM)).toBe(HOME)
  })

  it('reuses the outer instance answer when nested', () => {
    const env = base({ ZDOTDIR: SHIM, SEASHELL_USER_ZDOTDIR: '/Users/j/dotfiles' })
    expect(resolveUserZdotdir(env, SHIM)).toBe('/Users/j/dotfiles')
  })

  it('falls back to HOME if even the recorded value is the shim', () => {
    const env = base({ ZDOTDIR: SHIM, SEASHELL_USER_ZDOTDIR: SHIM })
    expect(resolveUserZdotdir(env, SHIM)).toBe(HOME)
  })
})

describe('buildEnv nesting safety', () => {
  const opts = { paneId: 'pane-9', appVersion: '0.1.0', zdotdirShimPath: SHIM }

  it('never points the shim at itself, however deeply nested', () => {
    const nested = buildEnv({
      ...opts,
      baseEnv: base({ ZDOTDIR: SHIM, SEASHELL_USER_ZDOTDIR: SHIM, SEASHELL_PANE_ID: 'pane-1' }),
    })
    expect(nested.ZDOTDIR).toBe(SHIM)
    expect(nested.SEASHELL_USER_ZDOTDIR).not.toBe(SHIM)
    expect(nested.SEASHELL_USER_ZDOTDIR).toBe(HOME)
  })

  it('gives the new pane its own id rather than the one it inherited', () => {
    const nested = buildEnv({
      ...opts,
      baseEnv: base({ SEASHELL_PANE_ID: 'pane-from-outer-instance' }),
    })
    expect(nested.SEASHELL_PANE_ID).toBe('pane-9')
  })

  it('still does the ordinary thing outside a pane', () => {
    const env = buildEnv({ ...opts, baseEnv: base() })
    expect(env.SEASHELL_USER_ZDOTDIR).toBe(HOME)
    expect(env.ZDOTDIR).toBe(SHIM)
    expect(env.TERM).toBe('xterm-256color')
    expect(env.TERM_PROGRAM).toBe('SeaShell')
    expect(env.COLORTERM).toBeUndefined()
  })

  it('does not mutate the environment it was given', () => {
    const original = base({ ZDOTDIR: SHIM })
    const snapshot = { ...original }
    buildEnv({ ...opts, baseEnv: original })
    expect(original).toEqual(snapshot)
  })
})
