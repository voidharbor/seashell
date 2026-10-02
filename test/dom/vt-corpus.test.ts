import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

/**
 * The VT contract between the native shell's grid (libvterm) and xterm.js.
 * Each test/fixtures/vt-corpus/NN-name.bin is written into an xterm.js
 * Terminal of the size in NN-name.json, with the graphemes addon as the
 * Electron renderer runs it, and the resulting screen is recorded in the shape
 * native/shell/tools/grid-test prints. scripts/vt-parity.mjs compares the two.
 *
 * WRITE_EXPECTED=1 regenerates the NN-name.expected.json files; otherwise each
 * committed file must equal what xterm.js produces now.
 */

const DIR = join(__dirname, '..', 'fixtures', 'vt-corpus')

interface Size {
  cols: number
  rows: number
  resize?: { cols: number; rows: number }
}

interface ScreenShot {
  text: string[]
  cursor: { row: number; col: number }
  scrollback: number
  wrapped: boolean[]
  widths: number[][]
  /** Every row from the oldest scrollback row to the last non-empty screen row. */
  all: string[]
}

function corpus(): string[] {
  return readdirSync(DIR)
    .filter((f) => /^\d\d-[\w-]+\.bin$/.test(f))
    .map((f) => f.slice(0, -4))
    .sort()
}

async function screen(name: string): Promise<ScreenShot> {
  const size = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as Size
  const bytes = readFileSync(join(DIR, `${name}.bin`))
  const term = new Terminal({ allowProposedApi: true, cols: size.cols, rows: size.rows, scrollback: 20_000 })
  term.loadAddon(new UnicodeGraphemesAddon())
  term.unicode.activeVersion = '15-graphemes'
  await new Promise<void>((resolve) => term.write(new Uint8Array(bytes), resolve))
  if (size.resize) {
    term.resize(size.resize.cols, size.resize.rows)
    await new Promise<void>((resolve) => term.write('', resolve))
  }
  const buf = term.buffer.active
  const text: string[] = []
  const wrapped: boolean[] = []
  const widths: number[][] = []
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.baseY + y)
    const next = buf.getLine(buf.baseY + y + 1)
    text.push(line ? line.translateToString(true) : '')
    // grid-test's flag means "continues on the next row"; xterm.js marks the
    // next row instead.
    wrapped.push(y + 1 < term.rows && !!next?.isWrapped)
    const w: number[] = []
    for (let x = 0; x < term.cols; x++) w.push(line?.getCell(x)?.getWidth() ?? 1)
    widths.push(w)
  }
  const all: string[] = []
  let last = buf.length - 1
  while (last >= buf.baseY && (buf.getLine(last)?.translateToString(true) ?? '') === '') last--
  for (let y = 0; y <= last; y++) all.push(buf.getLine(y)?.translateToString(true) ?? '')
  const shot: ScreenShot = {
    text,
    // xterm.js parks the cursor one past the last column while a wrap is
    // pending; libvterm keeps it on the last column with a flag. Both are the
    // same cell on screen.
    cursor: { row: buf.cursorY, col: Math.min(buf.cursorX, term.cols - 1) },
    scrollback: buf.baseY,
    wrapped,
    widths,
    all,
  }
  term.dispose()
  return shot
}

describe('vt corpus', () => {
  it('has the 13 corpus files, each with its size', () => {
    const names = corpus()
    expect(names).toHaveLength(13)
    for (const n of names) expect(existsSync(join(DIR, `${n}.json`))).toBe(true)
  })

  for (const name of corpus()) {
    it(`${name} matches its expected screen`, async () => {
      const actual = await screen(name)
      const file = join(DIR, `${name}.expected.json`)
      if (process.env.WRITE_EXPECTED === '1') writeFileSync(file, `${JSON.stringify(actual)}\n`)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(actual)
    })
  }
})
