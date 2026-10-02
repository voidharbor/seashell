#!/usr/bin/env node
// Compares the native shell's grid (libvterm) with xterm.js on the VT corpus.
// Runs grid-test.exe from the Windows build tree on every
// test/fixtures/vt-corpus/NN-name.bin through powershell.exe and checks its
// screen against NN-name.expected.json (written by test/dom/vt-corpus.test.ts).
// Prints each mismatch and the count; exits 1 on any. Build first:
// scripts/win/sync-tree.sh, then scripts/win/build-shell.cmd.
// GRID_TEST=<path> runs a locally built grid-test instead (a Linux build of
// the same sources, for quick iteration; the Windows run is the gate).
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'test', 'fixtures', 'vt-corpus')
const BUILD_LINUX = '/mnt/c/seashell-build/redesign'
const BUILD_WIN = 'C:\\seashell-build\\redesign'
const RELEASE_WIN = `${BUILD_WIN}\\shell-build\\Release`

// Known differences between libvterm and xterm.js that are cosmetic, keyed by
// corpus name and field, each with the reason. `all` (every row, scrollback
// included) is never excepted, so the content is always compared.
const WINDOW =
  'after a reflow libvterm keeps one blank row under the cursor where xterm.js pulls the text down to fill it; ' +
  'the screen window sits one row lower, the rows themselves (all) are identical'
const EXCEPTIONS = {
  '13-resize': { text: WINDOW, cursor: WINDOW, scrollback: WINDOW, wrapped: WINDOW },
}

const names = readdirSync(DIR)
  .filter((f) => /^\d\d-[\w-]+\.bin$/.test(f))
  .map((f) => f.slice(0, -4))
  .sort()

function run(name, size) {
  const extra = size.resize ? ['--resize', String(size.resize.cols), String(size.resize.rows)] : []
  if (process.env.GRID_TEST) {
    return execFileSync(process.env.GRID_TEST, [String(size.cols), String(size.rows), join(DIR, `${name}.bin`), ...extra], {
      encoding: 'utf8',
    })
  }
  const ps = [
    `Set-Location ${RELEASE_WIN}`,
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    `.\\grid-test.exe ${size.cols} ${size.rows} ${BUILD_WIN}\\test\\fixtures\\vt-corpus\\${name}.bin ${extra.join(' ')}`,
  ].join('; ')
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    cwd: '/mnt/c',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
}

// The build tree's copy of the corpus may predate a sync; refresh it.
if (!process.env.GRID_TEST) {
  mkdirSync(`${BUILD_LINUX}/test/fixtures/vt-corpus`, { recursive: true })
  for (const n of names) copyFileSync(join(DIR, `${n}.bin`), `${BUILD_LINUX}/test/fixtures/vt-corpus/${n}.bin`)
}

// JSON with object keys sorted: grid-test's json library sorts them, xterm.js's
// side writes them in insertion order.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

let mismatches = 0
for (const name of names) {
  const size = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'))
  const want = JSON.parse(readFileSync(join(DIR, `${name}.expected.json`), 'utf8'))
  let have
  try {
    have = JSON.parse(run(name, size).trim())
  } catch (e) {
    mismatches++
    console.log(`${name}: grid-test failed: ${String(e.message || e).split('\n')[0]}`)
    continue
  }
  for (const field of ['text', 'cursor', 'scrollback', 'wrapped', 'widths', 'all']) {
    const a = canon(want[field])
    const b = canon(have[field])
    if (a === b) continue
    const reason = EXCEPTIONS[name]?.[field]
    if (reason) {
      console.log(`${name} ${field}: known difference (${reason})`)
      continue
    }
    mismatches++
    if (Array.isArray(want[field])) {
      const n = Math.max(want[field].length, have[field]?.length ?? 0)
      for (let i = 0; i < n; i++) {
        const x = canon(want[field][i])
        const y = canon(have[field]?.[i])
        if (x !== y) console.log(`${name} ${field}[${i}]: expected ${x} got ${y}`)
      }
    } else {
      console.log(`${name} ${field}: expected ${a} got ${b}`)
    }
  }
}
console.log(`${mismatches} mismatches`)
process.exit(mismatches === 0 ? 0 : 1)
