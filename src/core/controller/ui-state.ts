/**
 * The renderer's localStorage preferences, as one file the core owns:
 * `<userData>/ui-state.json` (native design spec section 3). A missing or
 * malformed file gives exactly the defaults a fresh renderer starts with.
 */
import fs from 'node:fs'
import { clampIndex, DEFAULT_ZOOM_INDEX } from '../../renderer/term/zoom.js'
import { coerceSettings, type Settings } from '../../renderer/settings/settings.js'
import { clampSidebar, SIDEBAR_DEFAULT } from '../../renderer/layout/sidebar.js'
import { clampDrawer, DRAWER_DEFAULT } from '../../renderer/layout/drawer.js'

export interface UiState {
  zoomIndex: number
  settings: Settings
  sidebarWidth: number
  drawerHeight: number
  tutorialSeen: boolean
  dismissedUpdate: string | null
  /** The changes column's width, a fraction of the grid area. */
  changesWidth: number
}

/** The changes column: about 38 percent of the area, and never under a fifth or over 70 percent. */
export const CHANGES_WIDTH_DEFAULT = 0.38
export function clampChangesWidth(w: number): number {
  return Number.isFinite(w) ? Math.min(0.7, Math.max(0.2, w)) : CHANGES_WIDTH_DEFAULT
}

export function defaultUiState(): UiState {
  return {
    zoomIndex: DEFAULT_ZOOM_INDEX,
    settings: coerceSettings(undefined),
    sidebarWidth: SIDEBAR_DEFAULT,
    drawerHeight: DRAWER_DEFAULT,
    tutorialSeen: false,
    dismissedUpdate: null,
    changesWidth: CHANGES_WIDTH_DEFAULT,
  }
}

/** Every field is checked on its own, so one bad value never resets the rest. */
export function coerceUiState(value: unknown): UiState {
  const out = defaultUiState()
  if (typeof value !== 'object' || value === null) return out
  const raw = value as Record<string, unknown>
  if (typeof raw['zoomIndex'] === 'number') out.zoomIndex = clampIndex(raw['zoomIndex'])
  out.settings = coerceSettings(raw['settings'])
  if (typeof raw['sidebarWidth'] === 'number') out.sidebarWidth = clampSidebar(raw['sidebarWidth'])
  if (typeof raw['drawerHeight'] === 'number') out.drawerHeight = clampDrawer(raw['drawerHeight'])
  if (typeof raw['tutorialSeen'] === 'boolean') out.tutorialSeen = raw['tutorialSeen']
  if (typeof raw['dismissedUpdate'] === 'string') out.dismissedUpdate = raw['dismissedUpdate']
  if (typeof raw['changesWidth'] === 'number') out.changesWidth = clampChangesWidth(raw['changesWidth'])
  return out
}

export function loadUiState(file: string): UiState {
  try {
    return coerceUiState(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return defaultUiState()
  }
}

/**
 * Write `<file>.tmp`, then rename over the real file, so a crash mid-write
 * never leaves a half file. Never creates the directory and never throws: a
 * preference that fails to persist still applies for this session.
 */
export function saveUiState(file: string, s: UiState): boolean {
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* nothing to clean up */
    }
    return false
  }
}
