#!/usr/bin/env node
/**
 * Restores the execute bit on node-pty's `spawn-helper`.
 *
 * node-pty forks through a small helper binary on macOS/Linux. npm's tarball
 * extraction does not reliably preserve the execute bit on it, and when it is
 * lost every single pty.spawn() fails with the extremely unhelpful
 * "posix_spawnp failed." — with no mention of permissions or of the helper.
 *
 * Runs on postinstall so a fresh clone works without anyone rediscovering this.
 */
const fs = require('node:fs')
const path = require('node:path')

const base = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')

let fixed = 0
try {
  for (const dir of fs.readdirSync(base)) {
    const helper = path.join(base, dir, 'spawn-helper')
    if (!fs.existsSync(helper)) continue
    const mode = fs.statSync(helper).mode
    if ((mode & 0o111) === 0o111) continue
    fs.chmodSync(helper, 0o755)
    fixed += 1
  }
} catch (err) {
  // A missing node-pty is not this script's problem to report.
  if (err && err.code !== 'ENOENT') {
    console.warn('[seashell] could not fix spawn-helper permissions:', err.message)
  }
  process.exit(0)
}

if (fixed > 0) console.log(`[seashell] restored execute bit on ${fixed} spawn-helper binary(ies)`)
