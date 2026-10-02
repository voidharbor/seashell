/**
 * Restores the execute bit on node-pty's spawn-helper inside the packaged app.
 *
 * Two separate things strip it: npm's tarball extraction on install, and
 * electron-builder's own copy step when it unpacks node-pty out of the asar.
 * The postinstall script fixes the first; only this hook fixes the second.
 *
 * Without it the packaged .app launches fine, shows its window, and then every
 * single pane fails with "posix_spawnp failed.", which says nothing about
 * permissions and sends you hunting in entirely the wrong place.
 */
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  try {
    await fixSpawnHelpers(context)
  } catch (err) {
    // Never fail a package over this: report it and let the build finish.
    console.warn(`[afterPack] could not fix spawn-helper permissions: ${err && err.message}`)
  }
}

async function fixSpawnHelpers(context) {
  const platform = context.electronPlatformName
  // Windows has no execute bit and node-pty's win32 prebuilds carry no
  // spawn-helper (ConPTY needs none), so there is nothing to fix.
  if (platform === 'win32') return

  // macOS keeps resources inside the .app bundle; Linux next to the binary.
  const resources =
    platform === 'darwin' || platform === 'mas'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : path.join(context.appOutDir, 'resources')
  const unpacked = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds')

  if (!fs.existsSync(unpacked)) {
    console.warn(`[afterPack] node-pty prebuilds not found at ${unpacked}: PTYs will not work`)
    return
  }

  let fixed = 0
  for (const dir of fs.readdirSync(unpacked)) {
    const helper = path.join(unpacked, dir, 'spawn-helper')
    if (!fs.existsSync(helper)) continue
    fs.chmodSync(helper, 0o755)
    fixed += 1
  }
  console.log(`[afterPack] chmod +x on ${fixed} spawn-helper binary(ies)`)
}
