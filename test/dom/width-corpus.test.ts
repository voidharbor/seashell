import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

/**
 * The width contract between the native shell's libvterm and xterm.js. xterm.js
 * with the graphemes addon (what the Electron renderer runs) is the reference:
 * each corpus line is written into a fresh terminal and the width of every
 * cell that starts a cluster is the expected output. native/shell's width-test
 * prints the same shape and scripts/width-parity.mjs compares the two.
 *
 * WRITE_EXPECTED=1 regenerates test/fixtures/width-expected.json; otherwise the
 * committed file must equal what xterm.js produces now, so an addon upgrade
 * that moves a width fails here before it reaches the parity run.
 */

const FIXTURES = join(__dirname, '..', 'fixtures')
const CORPUS = join(FIXTURES, 'width-corpus.txt')
const EXPECTED = join(FIXTURES, 'width-expected.json')

/** Corpus strings in order; `#` lines are group comments. */
function corpusLines(): string[] {
  return readFileSync(CORPUS, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

async function clusterWidths(line: string): Promise<number[]> {
  const term = new Terminal({ allowProposedApi: true, cols: 200, rows: 4 })
  term.loadAddon(new UnicodeGraphemesAddon())
  term.unicode.activeVersion = '15-graphemes'
  await new Promise<void>((resolve) => term.write(line, resolve))
  const row = term.buffer.active.getLine(0)
  const widths: number[] = []
  if (row) {
    for (let x = 0; x < row.length; x++) {
      const cell = row.getCell(x)
      if (cell && cell.getWidth() > 0 && cell.getChars().length > 0) widths.push(cell.getWidth())
    }
  }
  term.dispose()
  return widths
}

describe('width corpus', () => {
  it('has 302 distinct lines', () => {
    const lines = corpusLines()
    expect(lines).toHaveLength(302)
    expect(new Set(lines).size).toBe(302)
  })

  it('width-expected.json matches xterm.js with the graphemes addon', async () => {
    const actual: Record<string, number[]> = {}
    for (const line of corpusLines()) actual[line] = await clusterWidths(line)
    if (process.env.WRITE_EXPECTED === '1') {
      // One entry per line, so a moved width shows as a one-line diff.
      const body = Object.entries(actual).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      writeFileSync(EXPECTED, `{\n${body.join(',\n')}\n}\n`)
    }
    const committed = JSON.parse(readFileSync(EXPECTED, 'utf8')) as Record<string, number[]>
    expect(Object.keys(committed)).toHaveLength(302)
    expect(committed).toEqual(actual)
  })
})
