import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Best-effort read of the plugin manifest Claude Code maintains, used only to
 * decide whether Lookout's empty state shows the two install commands for the
 * brain lane. This never gates function — cards work regardless of what
 * pushed them — so any failure here (file missing, unreadable, not JSON, the
 * wrong shape) means only "assume absent," never a thrown error.
 */

/** Either install provides the lane: standalone c-assistant, or the
 *  voidharbor bundle, which ships the same hooks (self-deduplicating when
 *  both are present). */
const PLUGIN_IDS = ['c-assistant@voidharbor', 'voidharbor@voidharbor']

/** [pure] — parses the manifest text; exported for tests. */
export function pluginInstalledInManifest(raw: string): boolean {
  let parsed: { plugins?: Record<string, unknown> }
  try {
    parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> }
  } catch {
    return false
  }
  return PLUGIN_IDS.some((id) => {
    const entry = parsed.plugins?.[id]
    return Array.isArray(entry) && entry.length > 0
  })
}

export async function lookoutPluginInstalled(): Promise<boolean> {
  try {
    const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')
    return pluginInstalledInManifest(await fs.readFile(file, 'utf8'))
  } catch {
    return false
  }
}
