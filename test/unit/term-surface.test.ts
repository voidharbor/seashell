import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The invariant `allowTransparency: true` creates.
 *
 * With it on, xterm stops baking the cell background into the glyph atlas: a
 * cell using the default background is left genuinely transparent and the
 * element underneath shows through. That is fine — and is what restores the
 * antialiased edge pixels the atlas's clearColor pass was deleting — but only
 * for as long as every element that hosts a terminal paints the terminal
 * background itself.
 *
 * This is not hypothetical. `.drawer` is --chrome-bg (#0a0f0a, green-tinted),
 * so the shell drawer's terminal would have rendered on a tinted surface
 * rather than black the moment the flag flipped. Nothing else would have
 * caught it: it typechecks, it renders, and every existing test passes.
 *
 * So the list of hosts is spelled out here, and the count check below makes
 * adding a third terminal host without adding it to the list a test failure
 * rather than a subtly wrong background someone notices months later.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

const css = read('src/renderer/styles.css')
const terminalTs = read('src/renderer/term/terminal.ts')

/** Every element a PaneTerminal is mounted into. Keep in step with the count check. */
const TERMINAL_HOSTS = ['pane__term', 'drawer__term']

/** The body of a single CSS rule, or null if the selector is not in the sheet. */
function ruleBody(selector: string): string | null {
  const re = new RegExp(`(^|[},\\s])\\.${selector}(?![\\w-])\\s*\\{([^}]*)\\}`, 'm')
  return re.exec(css)?.[2] ?? null
}

describe('terminal host surfaces', () => {
  it('keeps allowTransparency on, which is what this whole file is about', () => {
    expect(terminalTs).toMatch(/allowTransparency:\s*true/)
  })

  it('paints an opaque terminal background on every terminal host', () => {
    for (const host of TERMINAL_HOSTS) {
      const body = ruleBody(host)
      expect(body, `no .${host} rule in styles.css`).not.toBeNull()
      expect(body, `.${host} must set a background or the transparent atlas shows the surface behind it`)
        .toMatch(/background:\s*var\(--term-bg\)/)
    }
  })

  it('is looking at the real hosts — a new one must be added to the list', () => {
    const sources = ['src/renderer/panes/PaneView.tsx', 'src/renderer/drawer/DrawerShell.tsx']
      .map(read)
      .join('\n')
    const mounts = [...sources.matchAll(/new PaneTerminal\(/g)].length

    // If this fails because a terminal was mounted somewhere new, add that
    // element's class to TERMINAL_HOSTS and give it `background: var(--term-bg)`.
    expect(mounts).toBe(TERMINAL_HOSTS.length)

    // And a guard on the guard: the two known hosts really are referenced by
    // those files, so the regexes above are not matching an empty world.
    for (const host of TERMINAL_HOSTS) expect(sources).toContain(host)
  })

  it('declares a weight range on the terminal face so bold reaches the real Bold cut', () => {
    // SFMono-Terminal.ttf is a variable font. With no weight descriptor the
    // face declares 400 only, a request for bold is clamped back to it, and
    // bold text measured within 1% of normal weight — see the note on
    // TERMINAL_FONT_WEIGHTS. document.fonts.check('bold …') returns true either
    // way, so the descriptor itself is the only honest thing to assert on.
    expect(terminalTs).toMatch(/TERMINAL_FONT_WEIGHTS\s*=\s*'295 900'/)
    expect(terminalTs).toMatch(/new FontFace\([\s\S]{0,120}weight: TERMINAL_FONT_WEIGHTS/)
  })

  /**
   * Shift+Enter must preventDefault, or it sends a stray second CR.
   *
   * xterm returns early when a custom key handler returns false but does not
   * preventDefault, so the browser still delivers the Enter to xterm's hidden
   * textarea. Measured off a real pane: `1b 0a 0a` before, `1b 0a` after,
   * against `1b 0a` for Alt+Enter. An agent read the extra byte as "submit".
   *
   * There is no way to reach this from a unit test — it needs a real xterm, a
   * real browser default and a real pty — so the source is pinned instead. The
   * other two `return false` branches must NOT gain a preventDefault: the Cmd
   * branch needs the browser's own copy, and the kill-line branch deliberately
   * lets the erase through.
   */
  it('cancels the browser default on Shift+Enter, and only there', () => {
    // Comments are stripped first: the note on this very branch says the words
    // "return false", which a naive scan happily matched instead of the code.
    const code = terminalTs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    const handler = /attachCustomKeyEventHandler\(\(ev\) => \{[\s\S]*?\n    \}\)/.exec(code)?.[0] ?? ''
    expect(handler, 'could not find the custom key handler').not.toBe('')

    const shiftEnter = /ev\.key === 'Enter' && ev\.shiftKey[\s\S]*?return false/.exec(handler)?.[0] ?? ''
    expect(shiftEnter, 'could not find the Shift+Enter branch').not.toBe('')
    expect(shiftEnter).toContain('ev.preventDefault()')

    // Exactly one preventDefault in the whole handler.
    expect(handler.match(/ev\.preventDefault\(\)/g) ?? []).toHaveLength(1)
  })

  it('does not force grayscale font smoothing on the chrome', () => {
    // `-webkit-font-smoothing: antialiased` measured ~70% fewer fully-covered
    // pixels on a 1x display, i.e. visibly lighter text than any native window.
    expect(css).not.toMatch(/-webkit-font-smoothing:\s*antialiased/)
  })
})
