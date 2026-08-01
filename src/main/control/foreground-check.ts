/**
 * Runs the `ps`-based foreground check and classifies the result.
 *
 * Extracted out of `index.ts` so the control socket and the approve path
 * (`lookout/approve.ts`, Task 5) share one composition of `execFile` +
 * `foregroundIsClaude` rather than two copies that could drift.
 */
import { execFile } from 'node:child_process'
import { foregroundIsClaude } from './foreground.js'

export function checkTtyForeground(ttyName: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `+` in STAT marks the tty's foreground process group.
    execFile('ps', ['-t', ttyName, '-o', 'stat=,command='], (err, stdout) => {
      resolve(!err && foregroundIsClaude(stdout))
    })
  })
}
