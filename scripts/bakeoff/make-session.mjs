// Builds the W10 workload (spec section 2): 9 tabs, 10 plain zsh panes.
// Pure except for main(), which writes two files into a SCRATCH userData dir.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function pane(cwd) {
  return { label: 'zsh', labelIsCustom: false, kind: 'term', command: 'zsh', cwd }
}

function tab(i, cwd, paneIds) {
  const children = paneIds.map((id) => ({ type: 'pane', paneId: id }))
  return {
    id: `w10-tab-${i}`,
    name: `Tab ${i}`,
    nameIsCustom: false,
    cwd,
    zoomedPaneId: null,
    focusedPaneId: paneIds[0],
    tree: { type: 'row', ratios: [1], children: [{ type: 'col', ratios: paneIds.map(() => 1 / paneIds.length), children }] },
    panes: Object.fromEntries(paneIds.map((id) => [id, pane(cwd)])),
    sessionIdsVerified: true,
  }
}

export function buildW10(cwd = '/Users/joshwald') {
  const tabs = []
  tabs.push(tab(1, cwd, ['w10-p1a', 'w10-p1b']))
  for (let i = 2; i <= 9; i++) tabs.push(tab(i, cwd, [`w10-p${i}`]))
  return { schemaVersion: 1, savedAt: new Date().toISOString(), tabs }
}

function main() {
  const [outDir, cwd] = process.argv.slice(2)
  if (!outDir) { console.error('usage: make-session.mjs <outDir> [cwd]'); process.exit(1) }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'last-session.json'), JSON.stringify(buildW10(cwd), null, 2))
  writeFileSync(join(outDir, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [] }, null, 2))
  console.log(`wrote W10 session into ${outDir}`)
}

if (process.argv[1] && process.argv[1].endsWith('make-session.mjs')) main()
