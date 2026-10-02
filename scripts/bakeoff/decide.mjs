// The spec section 3 decision rule over the bake-off results file.
import { readFileSync } from 'node:fs'
import { parseResults } from '../win/measure-ram-parse.mjs'

export function decide(rows) {
  const get = (l) => { const r = rows.findLast((x) => x.label === l); if (!r) throw new Error(`no row labelled ${l}`); return r }
  const b = get('B-webview2').wsMB, c = get('C-sidecar').wsMB
  const bPlusC = b + c, bPlus25 = b + 25
  if (bPlusC < 200) return { rule: 'R1', chosen: 'WebView2 host + Node sidecar', bPlusC, bPlus25 }
  if (bPlus25 < 200) return { rule: 'R2', chosen: 'WebView2 host + C++ main', bPlusC, bPlus25 }
  return { rule: 'R3', chosen: 'native', bPlusC, bPlus25 }
}

export function table(rows) {
  const want = ['A-electron', 'B-webview2', 'C-sidecar', 'D-native']
  const lines = ['| Candidate | processes | WS median MB | private median MB |', '|---|---|---|---|']
  for (const l of want) { const r = rows.findLast((x) => x.label === l); lines.push(r ? `| ${l} | ${r.processes} | ${r.wsMB} | ${r.privateMB} |` : `| ${l} | not measured | | |`) }
  // No B or C row means the rule has no input; say so instead of throwing.
  let d
  try { d = decide(rows) } catch (e) { d = null; lines.push('| B + C | | not measured | |', '', `Rule applied: none (${e.message}). Chosen: none.`) }
  if (d) lines.push(`| B + C | | ${Math.round(d.bPlusC * 10) / 10} | |`, '', `Rule applied: ${d.rule}. Chosen: ${d.chosen}.`)
  return lines.join('\n')
}

if (process.argv[1]?.endsWith('decide.mjs')) {
  let text = ''
  try { text = readFileSync(process.argv[2], 'utf8') } catch { text = '' }
  console.log(table(parseResults(text)))
}
