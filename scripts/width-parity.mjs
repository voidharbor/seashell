#!/usr/bin/env node
// Compares the native shell's libvterm widths with xterm.js's. Runs
// width-test.exe from the Windows build tree on test/fixtures/width-corpus.txt
// through powershell.exe and checks every line against width-expected.json
// (written by test/dom/width-corpus.test.ts). Prints each mismatch and the
// count; exits 1 on any. Build first: scripts/win/sync-tree.sh, then
// scripts/win/build-shell.cmd.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS = join(ROOT, 'test', 'fixtures', 'width-corpus.txt')
const EXPECTED = join(ROOT, 'test', 'fixtures', 'width-expected.json')
const BUILD_LINUX = '/mnt/c/seashell-build/redesign'
const BUILD_WIN = 'C:\\seashell-build\\redesign'
const RELEASE_WIN = `${BUILD_WIN}\\shell-build\\Release`

// The build tree's copy of the corpus may predate a sync; refresh just this file.
mkdirSync(`${BUILD_LINUX}/test/fixtures`, { recursive: true })
copyFileSync(CORPUS, `${BUILD_LINUX}/test/fixtures/width-corpus.txt`)

// Windows PowerShell pipes to native programs in $OutputEncoding (ASCII by
// default) and reads files in the ANSI code page; both are set to UTF-8 here.
const ps = [
  `Set-Location ${RELEASE_WIN}`,
  '$OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  `Get-Content -Encoding UTF8 ${BUILD_WIN}\\test\\fixtures\\width-corpus.txt | .\\width-test.exe`,
].join('; ')
const stdout = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
  cwd: '/mnt/c',
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
})
const got = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0)

const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'))
const raw = readFileSync(CORPUS, 'utf8').split('\n')
let k = 0
let mismatches = 0
for (let n = 0; n < raw.length; n++) {
  const line = raw[n].replace(/\r$/, '')
  if (line.length === 0 || line.startsWith('#')) continue
  const want = expected[line]
  const have = got[k++]
  const wantText = want ? JSON.stringify(want) : '(missing from width-expected.json)'
  const haveText = have === undefined ? '(no output)' : have.replace(/\s/g, '')
  if (wantText !== haveText) {
    mismatches++
    console.log(`line ${n + 1}: expected ${wantText} got ${haveText} ${line}`)
  }
}
if (got.length !== k) {
  mismatches++
  console.log(`width-test printed ${got.length} lines for ${k} corpus lines`)
}
console.log(`${mismatches} mismatches`)
process.exit(mismatches === 0 ? 0 : 1)
