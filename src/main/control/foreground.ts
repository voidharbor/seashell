/**
 * Decides whether the foreground process group on a pane's tty is a main
 * claude process, from the output of `ps -t <ttyName> -o stat=,command=`.
 *
 * This module is [pure]: the caller runs `ps` and hands the text in.
 *
 * A `+` in STAT marks membership in the tty's foreground process group. The
 * claude test matches on argv[0] only — basename `claude` (the usual launch)
 * or the versions binary (`.../share/claude/versions/2.1.216`, how resumed
 * sessions appear) — so an MCP helper with `.claude` somewhere in its
 * arguments can never pass. If nothing claude-shaped owns the foreground,
 * typed text would land in whatever does (usually zsh, where it would
 * execute), so the caller must refuse.
 */
export function foregroundIsClaude(psOutput: string): boolean {
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const [stat, ...command] = trimmed.split(/\s+/)
    if (!stat || !stat.includes('+') || command.length === 0) continue
    const argv0 = command[0] ?? ''
    const base = argv0.split('/').pop() ?? ''
    if (base === 'claude' || argv0.includes('/share/claude/versions/')) return true
  }
  return false
}
