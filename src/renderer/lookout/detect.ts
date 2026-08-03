/**
 * Which panes to scan this pass, and which readings are worth sending
 * (Lookout Task 6).
 *
 * [pure] — a plan in, a plan out. No xterm, no DOM, no Electron: kept
 * separate from the React effect that calls it so the effect body stays a
 * dozen lines of "read the plan, act on it" and this file is what actually
 * carries the scan/dedupe logic and its tests.
 *
 * Every waiting, unfocused pane is read on every pass. An earlier version read
 * a pane once per waiting spell and re-armed it only when the pane stopped
 * being `waiting` at all — so when an agent answered one question and asked
 * another, the pane never left `waiting` between two metrics ticks, the second
 * question was never read, and the card went on showing the FIRST one. A card
 * naming the wrong question is worse than no card: the point of it is
 * answering without going to look.
 *
 * What that re-arm was protecting against — re-reporting the same question over
 * and over — is now `changedQuestions`, which compares against what was last
 * SENT for each pane. Reading is a regex over a few dozen buffer lines; it was
 * the IPC round trip and the card churn worth avoiding, and those still happen
 * only when the question actually changes.
 *
 * Focus is a standing block: a focused pane is never scanned, because you are
 * already looking at it.
 */

export interface DetectPane {
  paneId: string
  attention: 'waiting' | 'done' | null | undefined
  focused: boolean
}

/** Panes whose buffer should be read this pass. */
export function planDetections(panes: DetectPane[]): { toScan: string[] } {
  const toScan: string[] = []
  for (const pane of panes) {
    if (pane.attention !== 'waiting') continue
    if (pane.focused) continue
    toScan.push(pane.paneId)
  }
  return { toScan }
}

/** One pane's freshly-read question, or null when nothing was extractable. */
export interface Reading {
  paneId: string
  question: string
  kind: 'input' | 'selector'
}

/**
 * Which readings are worth sending, and the next last-sent map.
 *
 * A pane that is no longer being read drops out of the map entirely, so the
 * same question asked again after an intervening turn still cards — by then it
 * is a genuinely new ask rather than a repeat of the one on screen.
 *
 * [pure] — exported for tests.
 */
export function changedQuestions(
  readings: Reading[],
  lastSent: ReadonlyMap<string, string>
): { toSend: Reading[]; nextSent: Map<string, string> } {
  const toSend: Reading[] = []
  const nextSent = new Map<string, string>()

  for (const reading of readings) {
    nextSent.set(reading.paneId, reading.question)
    if (lastSent.get(reading.paneId) === reading.question) continue
    toSend.push(reading)
  }

  return { toSend, nextSent }
}
