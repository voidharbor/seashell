// Builds the W10 workload (spec section 2): 9 tabs, 10 plain zsh panes.
// Pure except for main(), which writes three files into a SCRATCH userData
// dir: the session, an empty projects list, and a ui-state.json that says the
// tutorial was seen (plan Task 14), so no first-run tutorial sheet sits over
// the restored window.
//
// --previews (the restore gate only, plan Task 20 step 1.3) adds one file pane
// and one web pane to tab 1, after its two zsh panes: 9 tabs, 12 panes, of
// which the same 10 are terminals. The W10 measurement never passes it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function pane(cwd) {
  return { label: 'zsh', labelIsCustom: false, kind: 'term', command: 'zsh', cwd }
}

function filePane(cwd, filePath) {
  return { label: filePath.split('/').pop(), labelIsCustom: false, kind: 'file', command: 'zsh', cwd, filePath }
}

function webPane(cwd, url) {
  return { label: new URL(url).host, labelIsCustom: false, kind: 'web', command: 'zsh', cwd, url }
}

function tab(i, cwd, paneIds, extra = {}) {
  const children = [...paneIds, ...Object.keys(extra)].map((id) => ({ type: 'pane', paneId: id }))
  return {
    id: `w10-tab-${i}`,
    name: `Tab ${i}`,
    nameIsCustom: false,
    cwd,
    zoomedPaneId: null,
    focusedPaneId: paneIds[0],
    tree: { type: 'row', ratios: [1], children: [{ type: 'col', ratios: children.map(() => 1 / children.length), children }] },
    panes: { ...Object.fromEntries(paneIds.map((id) => [id, pane(cwd)])), ...extra },
    sessionIdsVerified: true,
  }
}

// The file and web panes --previews adds (never opened: a restored preview is
// a placeholder in this build, plan amendment 10/03).
export const PREVIEW_FILE = 'README.md'
export const PREVIEW_URL = 'https://example.com/w10-preview'

export function buildW10(cwd = '/Users/joshwald', { previews = false } = {}) {
  const tabs = []
  const extra = previews ? { 'w10-p1-file': filePane(cwd, `${cwd}/${PREVIEW_FILE}`), 'w10-p1-web': webPane(cwd, PREVIEW_URL) } : {}
  tabs.push(tab(1, cwd, ['w10-p1a', 'w10-p1b'], extra))
  for (let i = 2; i <= 9; i++) tabs.push(tab(i, cwd, [`w10-p${i}`]))
  return { schemaVersion: 1, savedAt: new Date().toISOString(), tabs }
}

function main() {
  const args = process.argv.slice(2)
  const previews = args.includes('--previews')
  const [outDir, cwd] = args.filter((a) => a !== '--previews')
  if (!outDir) { console.error('usage: make-session.mjs <outDir> [cwd] [--previews]'); process.exit(1) }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'last-session.json'), JSON.stringify(buildW10(cwd, { previews }), null, 2))
  writeFileSync(join(outDir, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [] }, null, 2))
  writeFileSync(join(outDir, 'ui-state.json'), JSON.stringify({ tutorialSeen: true }, null, 2))
  console.log(`wrote W10 session${previews ? ' plus a file and a web pane' : ''} into ${outDir}`)
}

if (process.argv[1] && process.argv[1].endsWith('make-session.mjs')) main()
