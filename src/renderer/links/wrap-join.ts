/**
 * Candidates to try when a path may have been hard-wrapped by the program
 * that printed it. [pure]
 *
 * Claude Code (Ink) writes each screen row with its own newline, so xterm never
 * marks the continuation row as wrapped and the logical line is one row. The
 * only evidence a path continues is that the token reaches the right edge, or
 * starts at column 0 with a non-space run at the end of the row above.
 *
 * Order matters: the caller stats every candidate in one round trip and takes
 * the FIRST hit, so the plain token comes first and the fully joined form last.
 */
export interface JoinInput {
  candidate: string
  /** Columns the candidate occupied on its row, [startCol, endCol). */
  startCol: number
  endCol: number
  cols: number
  prevRow: string | null
  nextRow: string | null
}

const LEADING_RUN = /^[^\s]+/
const TRAILING_RUN = /[^\s]+$/

export function joinCandidates(input: JoinInput): string[] {
  const out = [input.candidate]
  const touchesRight = input.endCol >= input.cols - 1
  const touchesLeft = input.startCol === 0

  const next = touchesRight && input.nextRow ? (LEADING_RUN.exec(input.nextRow)?.[0] ?? null) : null
  const prev = touchesLeft && input.prevRow ? (TRAILING_RUN.exec(input.prevRow)?.[0] ?? null) : null

  if (next) out.push(input.candidate + next)
  if (prev) out.push(prev + input.candidate)
  if (prev && next) out.push(prev + input.candidate + next)
  return out
}

/** A path Claude Code shortened with an ellipsis: `…/renderer/app.tsx`. */
export function isSuffixCandidate(p: string): boolean {
  return p.startsWith('…/') || p.startsWith('.../')
}

/** The suffix to search for, anchored at a path-segment boundary. */
export function normaliseSuffix(p: string): string {
  const rest = p.startsWith('…/') ? p.slice(1) : p.slice(3)
  return rest.startsWith('/') ? rest : `/${rest}`
}
