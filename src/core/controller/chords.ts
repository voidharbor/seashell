/**
 * The chord table the shell matches keys against.
 *
 * `src/main/menu.ts` stays the single place a binding is defined: the core
 * runs it against the Electron shim, which keeps the built template, and this
 * walks that template. The label-to-command map below is copied from the
 * `click: send('<command>')` bodies in menu.ts; keep the two in step.
 */
import { accelerator } from '../../shared/keys.js'
import type { ChordModel } from './model.js'

export interface MenuItemLike {
  label?: unknown
  accelerator?: unknown
  submenu?: MenuTemplateLike | ReadonlyArray<MenuItemLike> | undefined
  [key: string]: unknown
}

export interface MenuTemplateLike {
  items: ReadonlyArray<MenuItemLike>
}

const COMMAND_BY_LABEL: Readonly<Record<string, string>> = {
  'Settings…': 'app.settings',
  'New Tab': 'tab.new',
  'Rename Tab…': 'tab.rename',
  'Projects…': 'app.projects',
  'Save Project…': 'app.saveProject',
  'Save Tab as Project…': 'app.saveTab',
  'New Pane': 'pane.new',
  'New File Preview…': 'preview.file',
  'New Web Preview…': 'preview.web',
  'Close Pane': 'pane.close',
  'Close All Panes': 'pane.closeAll',
  'Close Tab': 'tab.close',
  Copy: 'edit.copy',
  Paste: 'edit.paste',
  'Select All': 'edit.selectAll',
  Find: 'edit.find',
  'Find Next': 'edit.findNext',
  'Find Previous': 'edit.findPrev',
  'Clear Pane': 'pane.clear',
  'Full-Screen Pane': 'pane.zoom',
  'Toggle Changes Panel': 'changes.toggle',
  'Rebalance Panes': 'layout.rebalance',
  'Toggle File Explorer': 'explorer.toggle',
  'Toggle Shell Drawer': 'drawer.toggle',
  'Refresh Explorer': 'explorer.refresh',
  'Next Pane': 'pane.next',
  'Previous Pane': 'pane.prev',
  'Next Tab': 'tab.next',
  'Previous Tab': 'tab.prev',
  'Show Tutorial': 'help.tutorial',
}

/** The `ui:command` a menu label sends, or null for an item with no command. */
export function commandForItem(label: string): string | null {
  const tab = /^Tab ([1-9])$/.exec(label)
  if (tab) return `tab.select.${Number(tab[1]) - 1}`
  return COMMAND_BY_LABEL[label] ?? null
}

/**
 * The zoom chords, bound in the renderer rather than the menu (see the zoom
 * note in menu.ts and app.tsx): Ctrl+= / Ctrl+- / Ctrl+0 for the global level,
 * and the shifted pair for the focused pane alone.
 */
const ZOOM_CHORDS: readonly ChordModel[] = [
  { chord: 'Ctrl+=', command: 'ui.zoomIn' },
  { chord: 'Ctrl+-', command: 'ui.zoomOut' },
  { chord: 'Ctrl+0', command: 'ui.zoomReset' },
  { chord: 'Ctrl+Shift+=', command: 'pane.zoomIn' },
  { chord: 'Ctrl+Shift+-', command: 'pane.zoomOut' },
]

export function chordTableFromMenu(menu: MenuTemplateLike | null | undefined, platform: string): ChordModel[] {
  const out: ChordModel[] = []
  const walk = (items: ReadonlyArray<MenuItemLike>): void => {
    for (const item of items) {
      const sub = item.submenu
      if (sub) walk(Array.isArray(sub) ? sub : (sub as MenuTemplateLike).items)
      if (typeof item.accelerator !== 'string' || typeof item.label !== 'string') continue
      const command = commandForItem(item.label)
      if (!command) continue
      // menu.ts has already respelled it for the platform it ran on; a template
      // that still holds the Mac form is respelled here.
      out.push({ chord: accelerator(item.accelerator, platform), command })
    }
  }
  if (menu) walk(menu.items)
  for (const z of ZOOM_CHORDS) out.push({ ...z })
  return out
}
