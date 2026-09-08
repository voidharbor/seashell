/**
 * The swap script. [pure]
 *
 * Building it is a string operation with no side effects, which is what lets
 * the ordering guarantees below be tested without ever running it.
 */

export interface InstallScriptInput {
  pid: number
  zipPath: string
  stagingDir: string
  appPath: string
  expectedVersion: string
  logPath: string
}

/**
 * The swap, as a shell script run detached after the app quits. Every step
 * that can fail leaves the current install where it was: the old bundle is
 * moved aside, not deleted, until the new one is in place.
 */
export function buildInstallScript(o: InstallScriptInput): string {
  return [
    '#!/bin/sh',
    'set -u',
    `LOG="${o.logPath}"`,
    'exec >>"$LOG" 2>&1',
    'echo "install start $(date)"',
    'i=0',
    `while kill -0 ${o.pid} 2>/dev/null; do i=$((i+1)); if [ $i -ge 300 ]; then echo "app did not exit"; exit 1; fi; sleep 0.1; done`,
    `STAGE="${o.stagingDir}"`,
    `ZIP="${o.zipPath}"`,
    `APP="${o.appPath}"`,
    'rm -rf "$STAGE"; mkdir -p "$STAGE"',
    'ditto -x -k "$ZIP" "$STAGE" || { echo "unzip failed"; exit 1; }',
    'NEW="$STAGE/SeaShell.app"',
    `V=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$NEW/Contents/Info.plist" 2>/dev/null)`,
    `if [ "$V" != "${o.expectedVersion}" ]; then echo "version mismatch: $V"; exit 1; fi`,
    'OLD="$STAGE/previous.app"',
    'rm -rf "$OLD"',
    'mv "$APP" "$OLD" || { echo "could not move old app"; exit 1; }',
    'mv "$NEW" "$APP" || { mv "$OLD" "$APP"; echo "could not move new app"; exit 1; }',
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
    'rm -rf "$OLD" "$ZIP"',
    'open -a "$APP"',
    'echo "install done $(date)"',
    '',
  ].join('\n')
}
