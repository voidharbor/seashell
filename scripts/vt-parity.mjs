#!/usr/bin/env node
// Compares the native shell's grid (libvterm) with xterm.js on the VT corpus.
// Runs grid-test.exe from the Windows build tree on every
// test/fixtures/vt-corpus/NN-name.bin through powershell.exe and checks its
// screen against NN-name.expected.json (written by test/dom/vt-corpus.test.ts).
// Prints the first ten mismatches (file, row, column, field) and the count;
// exits 1 on any. Build first:
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

// Known differences between libvterm and xterm.js that are cosmetic, each
// with the reason. 13-resize's is the viewport offset only: its screen fields
// (text, wrapped, widths, cells, the cursor row) are compared against
// xterm.js's shifted by the difference in scrollback length, which must be the
// one row named here, and `all` (every row, scrollback included) is compared
// as is, so the content is always checked.
const EXCEPTIONS = {
  '13-resize': {
    offset: 1,
    reason:
      'after a reflow libvterm keeps one blank row under the cursor where xterm.js pulls the text down to fill it; ' +
      'the screen window sits one row lower, the rows themselves (all) are identical',
  },
}

// A cell's pen with the defaults filled in; both dumps leave defaults out.
const PEN = { fg: 'default', bg: 'default', bold: false, italic: false, underline: 0, strike: false, inverse: false, dim: false, blink: false, link: '' }
const MAX_SHOWN = 10

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

const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v))

let mismatches = 0
function mismatch(name, row, col, field, want, have) {
  mismatches++
  if (mismatches <= MAX_SHOWN)
    console.log(`${name} row ${row} col ${col} ${field}: expected ${show(want)} got ${show(have)}`)
}

// The first column (in code points) where two row texts part.
function partCol(a = '', b = '') {
  const x = [...a]
  const y = [...b]
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return i
}

function compare(name, want, have) {
  const ex = EXCEPTIONS[name]
  // Screen row r of xterm.js is native row r - shift.
  let shift = 0
  if (ex) {
    shift = have.scrollback - want.scrollback
    if (shift !== ex.offset) mismatch(name, '-', '-', 'scrollback', want.scrollback + ex.offset, have.scrollback)
    else console.log(`${name}: viewport offset ${shift} row (known difference: ${ex.reason})`)
  } else if (want.scrollback !== have.scrollback) {
    mismatch(name, '-', '-', 'scrollback', want.scrollback, have.scrollback)
  }
  const rows = want.text.length
  for (let r = 0; r < rows; r++) {
    const h = r - shift
    // Rows the offset pushes off the native screen are in its scrollback, and
    // checked through all.
    if (h < 0 || h >= have.text.length) continue
    if (want.text[r] !== have.text[h]) mismatch(name, r, partCol(want.text[r], have.text[h]), 'text', want.text[r], have.text[h])
    if (want.wrapped[r] !== have.wrapped[h]) mismatch(name, r, '-', 'wrapped', want.wrapped[r], have.wrapped[h])
    const cols = want.widths[r].length
    for (let c = 0; c < cols; c++) {
      if (want.widths[r][c] !== have.widths[h]?.[c]) mismatch(name, r, c, 'width', want.widths[r][c], have.widths[h]?.[c])
      const a = { ...PEN, ...want.cells[r][c] }
      const b = { ...PEN, ...have.cells?.[h]?.[c] }
      for (const f of Object.keys(PEN)) if (a[f] !== b[f]) mismatch(name, r, c, f, a[f], b[f])
    }
  }
  if (want.text.length !== have.text.length) mismatch(name, '-', '-', 'rows', want.text.length, have.text.length)
  const n = Math.max(want.all.length, have.all.length)
  for (let r = 0; r < n; r++)
    if (want.all[r] !== have.all[r]) mismatch(name, r, partCol(want.all[r], have.all[r]), 'all', want.all[r], have.all[r])
  if (want.cursor.row !== have.cursor.row + shift) mismatch(name, want.cursor.row, want.cursor.col, 'cursor.row', want.cursor.row, have.cursor.row + shift)
  if (want.cursor.col !== have.cursor.col) mismatch(name, want.cursor.row, want.cursor.col, 'cursor.col', want.cursor.col, have.cursor.col)
  for (const f of ['shape', 'blink', 'visible'])
    if (want.cursorStyle[f] !== have.cursorStyle?.[f]) mismatch(name, '-', '-', `cursor.${f}`, want.cursorStyle[f], have.cursorStyle?.[f])
  if (want.title !== have.title) mismatch(name, '-', '-', 'title', want.title, have.title)
  for (const f of Object.keys(want.modes))
    if (want.modes[f] !== have.modes?.[f]) mismatch(name, '-', '-', `mode.${f}`, want.modes[f], have.modes?.[f])
}

for (const name of names) {
  const size = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'))
  const want = JSON.parse(readFileSync(join(DIR, `${name}.expected.json`), 'utf8'))
  let have
  try {
    have = JSON.parse(run(name, size).trim())
  } catch (e) {
    mismatch(name, '-', '-', 'grid-test', 'a screen', String(e.message || e).split('\n')[0])
    continue
  }
  compare(name, want, have)
}
if (mismatches > MAX_SHOWN) console.log(`(first ${MAX_SHOWN} shown)`)
console.log(`${mismatches} mismatches`)
process.exit(mismatches === 0 ? 0 : 1)
