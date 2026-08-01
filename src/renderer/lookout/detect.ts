/**
 * Which panes to scan this pass (Lookout Task 6).
 *
 * [pure] — a plan in, a plan out. No xterm, no DOM, no Electron: kept
 * separate from the React effect that calls it so the effect body stays a
 * dozen lines of "read the plan, act on it" and this file is what actually
 * carries the scan/re-arm logic and its tests.
 *
 * A pane is scanned once per waiting spell: the first pass that sees it
 * `waiting` and unfocused reads its buffer and reports it, then it sits in
 * `reported` so later passes leave it alone — re-scanning every tick would
 * mean re-extracting (and re-reporting) the same question over and over.
 * `reported` only ever shrinks a pane back out when that pane is no longer
 * `waiting` at all (finished, or focused away and reset by the reducer), so
 * the next waiting spell re-arms it from scratch.
 *
 * Focus is a standing block, not a membership test: a focused pane never
 * enters `toScan`, but if it was already `reported` from before it keeps
 * that membership regardless of focus — only leaving `waiting` clears it.
 */

export interface DetectPane {
  paneId: string
  attention: 'waiting' | 'done' | null | undefined
  focused: boolean
}

/** Which panes should be read + reported this pass, and the next reported-set. */
export function planDetections(
  panes: DetectPane[],
  reported: ReadonlySet<string>
): { toScan: string[]; nextReported: Set<string> } {
  const toScan: string[] = []
  const nextReported = new Set<string>()

  for (const pane of panes) {
    if (pane.attention !== 'waiting') continue // not waiting: drops out of nextReported

    if (reported.has(pane.paneId)) {
      nextReported.add(pane.paneId) // still waiting, already reported: carry forward
      continue
    }
    if (pane.focused) continue // never scan the focused pane, and it isn't reported yet either

    toScan.push(pane.paneId)
    nextReported.add(pane.paneId)
  }

  return { toScan, nextReported }
}
