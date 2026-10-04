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

  it('keeps the installed build and updater flags out of the pane', () => {
    const env = buildEnv({
      ...opts,
      baseEnv: base({
        SEASHELL_INSTALLED: '1',
        SEASHELL_UPDATE_API: 'http://127.0.0.1:9/latest',
        SEASHELL_UPDATE_ORIGIN: 'http://127.0.0.1:9',
      }),
    })
    expect(env.SEASHELL_INSTALLED).toBeUndefined()
    expect(env.SEASHELL_UPDATE_API).toBeUndefined()
    expect(env.SEASHELL_UPDATE_ORIGIN).toBeUndefined()
    expect(env.SEASHELL_PANE_ID).toBe('pane-9')
  })

  it('does not mutate the environment it was given', () => {
    const original = base({ ZDOTDIR: SHIM })
    const snapshot = { ...original }
    buildEnv({ ...opts, baseEnv: original })
    expect(original).toEqual(snapshot)
  })
})

/**
 * The second nesting bug, same shape as the ZDOTDIR one above and also observed
 * live: SeaShell launched from inside a Claude Code session inherits that
 * session's agent identity, and — because SeaShell reparents to launchd — holds
 * it for the whole run. Every pane then gets it, and `claude` started in a pane
 * reads CLAUDE_CODE_CHILD_SESSION=1, concludes it is a nested child of some
 * other session, and silently saves no transcript. CLAUDE_CODE_SESSION_ID is
 * worse than useless in a pane: it names a session that has since ended.
 *
 * Stripping is safe because a pane's root is a login shell — anything the user
 * genuinely exports from their own dotfiles is set again a moment later. Only
 * the inherited process identity, which no dotfile will restore, is lost.
 */
const CLAUDE_IDENTITY: NodeJS.ProcessEnv = {
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'dc8273ba-c1b5-464d-a045-6c9e6f75a7c1',
  CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01NSEnWnWBkZc4W1oV1n29h3',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_EXECPATH: '/Users/j/.local/share/claude/versions/2.1.220',
  CLAUDE_PID: '2836',
  CLAUDE_EFFORT: 'xhigh',
  AI_AGENT: 'claude-code_2-1-220_agent',
}

describe('buildEnv agent-identity leak', () => {
  const opts = { paneId: 'pane-9', appVersion: '0.1.0', zdotdirShimPath: SHIM }

  it('drops the child-session flag that turns off transcript saving', () => {
    const env = buildEnv({ ...opts, baseEnv: base(CLAUDE_IDENTITY) })
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
  })

  it('drops the rest of the inherited session identity', () => {
    const env = buildEnv({ ...opts, baseEnv: base(CLAUDE_IDENTITY) })
    const leaked = Object.keys(CLAUDE_IDENTITY).filter((key) => env[key] !== undefined)
    expect(leaked).toEqual([])
  })

  it('keeps variables the user exports for their own use', () => {
    const env = buildEnv({
      ...opts,
      baseEnv: base({ ...CLAUDE_IDENTITY, ANTHROPIC_API_KEY: 'sk-real', EDITOR: 'vim' }),
    })
    expect(env.ANTHROPIC_API_KEY).toBe('sk-real')
    expect(env.EDITOR).toBe('vim')
    expect(env.PATH).toBe('/usr/bin:/bin')
  })
})

/**
 * The Linux AppImage runtime exports its own variables into SeaShell's
 * environment, and panes inherited all of them. ARGV0 is the one that bites:
 * zsh uses an exported ARGV0 as argv[0] for every command it runs, so on the
 * PC every claude in every pane showed up in ps as
 * `/Users/joshwald/.local/bin/SeaShell.AppImage --dangerously-skip-permissions`.
 * The c-assistant hook then could not find claude by name (the session registry
 * stayed empty) and the control socket's foreground check refused every pane.
 */
describe('the AppImage runtime does not leak into panes', () => {
  const MOUNT = '/tmp/.mount_SeaSheFyiyRI'
  const appimage = (): NodeJS.ProcessEnv =>
    base({
      APPDIR: MOUNT,
      APPIMAGE: '/Users/j/.local/bin/SeaShell.AppImage',
      ARGV0: '/Users/j/.local/bin/SeaShell.AppImage',
      OWD: '/Users/j',
      CHROME_DESKTOP: 'seashell.desktop',
      PATH: `${MOUNT}:${MOUNT}/usr/sbin:/usr/local/bin:/usr/bin:/bin`,
      LD_LIBRARY_PATH: `${MOUNT}/usr/lib`,
      XDG_DATA_DIRS: `${MOUNT}/usr/share/:/usr/share/gnome:/usr/local/share/:/usr/share/`,
      GSETTINGS_SCHEMA_DIR: `${MOUNT}/usr/share/glib-2.0/schemas`,
    })
  const env = (): NodeJS.ProcessEnv =>
    buildEnv({ baseEnv: appimage(), paneId: 'p1', appVersion: '0.5.0', zdotdirShimPath: SHIM })

  it('drops the runtime identity variables', () => {
    const e = env()
    for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP']) expect(e[k]).toBeUndefined()
  })

  it('takes the mount point out of search paths and keeps everything else in order', () => {
    const e = env()
    expect(e.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(e.XDG_DATA_DIRS).toBe('/usr/share/gnome:/usr/local/share/:/usr/share/')
    expect(e.LD_LIBRARY_PATH).toBeUndefined()
    expect(e.GSETTINGS_SCHEMA_DIR).toBeUndefined()
  })

  it('leaves a normal environment alone', () => {
    const e = buildEnv({
      baseEnv: base({ LD_LIBRARY_PATH: '/opt/lib', ARGV0: 'kept-without-appdir' }),
      paneId: 'p1',
      appVersion: '0.5.0',
      zdotdirShimPath: SHIM,
    })
    expect(e.PATH).toBe('/usr/bin:/bin')
    expect(e.LD_LIBRARY_PATH).toBe('/opt/lib')
  })
})
