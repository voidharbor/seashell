import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Writes a ZDOTDIR shim once per app launch.
 *
 * Panes spawn `/bin/zsh -l`, so the user's real dotfiles must still load —
 * that is how tools like `claude` end up on PATH. The shim sources the user's
 * own config FIRST and only then appends our own hook, so a user's `precmd`
 * cannot clobber ours (and ours cannot silently replace theirs).
 *
 * The hook emits OSC 7 on every prompt, which is how a pane learns its current
 * working directory after the user cd's around. Without it we would be reduced
 * to polling `lsof`.
 */
export function ensureZdotdirShim(): string | null {
  const dir = path.join(app.getPath('userData'), 'zdotdir')
  try {
    fs.mkdirSync(dir, { recursive: true })

    for (const name of ['.zshenv', '.zprofile', '.zlogin']) {
      fs.writeFileSync(
        path.join(dir, name),
        `# SeaShell shim — sources your real ${name} and nothing else.\n` +
          `[ -r "$SEASHELL_USER_ZDOTDIR/${name}" ] && . "$SEASHELL_USER_ZDOTDIR/${name}"\n`,
        'utf8'
      )
    }

    // .zshrc sources the user's first, then installs the cwd reporter. The
    // percent-encoding matches what macOS ships in /etc/zshrc_Apple_Terminal.
    fs.writeFileSync(
      path.join(dir, '.zshrc'),
      [
        '# SeaShell shim — your .zshrc runs first, then SeaShell adds a cwd hook.',
        '[ -r "$SEASHELL_USER_ZDOTDIR/.zshrc" ] && . "$SEASHELL_USER_ZDOTDIR/.zshrc"',
        '',
        'autoload -Uz add-zsh-hook 2>/dev/null && {',
        '  _seashell_osc7() {',
        `    printf '\\e]7;file://%s%s\\a' "\${HOST}" "\${(j::)\${(@)\${(s::)PWD}/(#b)([^A-Za-z0-9_.!~*\\'\\-\\/])/%$(([##16]#match[1]))}}"`,
        '  }',
        '  add-zsh-hook precmd _seashell_osc7',
        '}',
        '',
      ].join('\n'),
      'utf8'
    )

    return dir
  } catch (err) {
    // Not fatal: without the shim we lose live cwd reporting, nothing else.
    console.warn('[seashell] could not write ZDOTDIR shim:', err)
    return null
  }
}
