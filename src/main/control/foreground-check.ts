/**
 * Runs the `ps`-based foreground check and classifies the result.
 *
 * Extracted out of `index.ts` so it composes `execFile` and
 * `foregroundIsClaude` in one place, for the control socket to use.
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
