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

const PLUGIN_ID = 'c-assistant@voidharbor'

export async function lookoutPluginInstalled(): Promise<boolean> {
  try {
    const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> }
    const entry = parsed.plugins?.[PLUGIN_ID]
    return Array.isArray(entry) && entry.length > 0
  } catch {
    return false
  }
}
