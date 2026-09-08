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
 *
 * Every failure also relaunches. The user clicked "Install and Relaunch", so
 * the one thing they are certain to notice is the app not coming back, and an
 * exit with only a line in the log tells them nothing until they start it by
 * hand and go looking. `fail` puts the reason in the log, puts the bundle back
 * if the swap had already moved it, and reopens whatever is now in place.
 */
export function buildInstallScript(o: InstallScriptInput): string {
  return [
    '#!/bin/sh',
    'set -u',
    `LOG="${o.logPath}"`,
    'exec >>"$LOG" 2>&1',
    'echo "install start $(date)"',
    `STAGE="${o.stagingDir}"`,
    `ZIP="${o.zipPath}"`,
    `APP="${o.appPath}"`,
    'OLD="$STAGE/previous.app"',
    'NEW="$STAGE/SeaShell.app"',
    // The restore is guarded on the app being gone: after a failed `mv "$APP"
    // "$OLD"` the old bundle is still in place and moving anything over it
    // would be the destructive step this whole script avoids.
    'fail() { echo "$1"; if [ -d "$OLD" ] && [ ! -d "$APP" ]; then mv "$OLD" "$APP"; fi; open -a "$APP"; exit 1; }',
    'i=0',
    `while kill -0 ${o.pid} 2>/dev/null; do i=$((i+1)); if [ $i -ge 300 ]; then fail "app did not exit"; fi; sleep 0.1; done`,
    'rm -rf "$STAGE"; mkdir -p "$STAGE"',
    'ditto -x -k "$ZIP" "$STAGE" || fail "unzip failed"',
    `V=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$NEW/Contents/Info.plist" 2>/dev/null)`,
    `if [ "$V" != "${o.expectedVersion}" ]; then fail "version mismatch: $V"; fi`,
    'rm -rf "$OLD"',
    'mv "$APP" "$OLD" || fail "could not move old app"',
    'mv "$NEW" "$APP" || fail "could not move new app"',
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
    'rm -rf "$OLD" "$ZIP"',
    // Logged before the relaunch, not after: `open` blocks until LaunchServices
    // has the app up, and a log that ends mid-swap is how this reads as having
    // died at the swap rather than finished it.
    'echo "install done $(date)"',
    'open -a "$APP"',
    '',
  ].join('\n')
}
