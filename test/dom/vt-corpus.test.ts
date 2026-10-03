import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Terminal, type IBufferCell } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

/**
 * The VT contract between the native shell's grid (libvterm) and xterm.js.
 * Each test/fixtures/vt-corpus/NN-name.bin is written into an xterm.js
 * Terminal of the size in NN-name.json, with the graphemes addon as the
 * Electron renderer runs it, and the resulting screen is recorded in the shape
 * native/shell/tools/grid-test prints: the text, every screen cell's colours,
 * attributes and OSC 8 target, the cursor and its shape, the OSC 0/2 title and
 * the mode flags. scripts/vt-parity.mjs compares the two.
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

/**
 * One screen cell's pen, defaults left out: fg and bg are `p<index>` for a
 * palette colour (SGR 30-37, 90-97, 38;5), `#rrggbb` for truecolor, absent for
 * the default; underline is the style (1 single, 2 double, 3 curly); link is
 * the OSC 8 uri.
 */
interface CellPen {
  fg?: string
  bg?: string
  bold?: true
  italic?: true
  underline?: number
  strike?: true
  inverse?: true
  dim?: true
  blink?: true
  link?: string
}

interface ScreenShot {
  text: string[]
  cursor: { row: number; col: number }
  scrollback: number
  wrapped: boolean[]
  widths: number[][]
  /** Every row from the oldest scrollback row to the last non-empty screen row. */
  all: string[]
  /** Per screen row, per cell. */
  cells: CellPen[][]
  cursorStyle: { shape: 'block' | 'underline' | 'bar'; blink: boolean; visible: boolean }
  title: string
  modes: {
    appCursor: boolean
    bracketedPaste: boolean
    mouse: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
    altScreen: boolean
    origin: boolean
    autowrap: boolean
  }
}

// The renderer's own cursor options (src/renderer/term/terminal.ts): what
// DECSCUSR 0 returns to.
const CURSOR_STYLE = 'block'
const CURSOR_BLINK = true

/** What the public IBufferCell is at runtime (a CellData), as far as used here. */
interface CellData extends IBufferCell {
  getUnderlineStyle(): number
  extended: { urlId: number }
}

function color(mode: 'fg' | 'bg', cell: IBufferCell): string | undefined {
  const isDefault = mode === 'fg' ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault) return undefined
  const isRgb = mode === 'fg' ? cell.isFgRGB() : cell.isBgRGB()
  const value = mode === 'fg' ? cell.getFgColor() : cell.getBgColor()
  return isRgb ? `#${value.toString(16).padStart(6, '0')}` : `p${value}`
}

function pen(cell: IBufferCell, linkUri: (id: number) => string | undefined): CellPen {
  const c = cell as CellData
  const p: CellPen = {}
  const fg = color('fg', c)
  const bg = color('bg', c)
  if (fg) p.fg = fg
  if (bg) p.bg = bg
  if (c.isBold()) p.bold = true
  if (c.isItalic()) p.italic = true
  // The SGR underline style, not on the public type; CellData has it. Not
  // isUnderline(): xterm.js 6 reports an OSC 8 cell as underlined (dashed)
  // without SGR 4, which the link field below covers.
  const underline = c.getUnderlineStyle()
  if (underline) p.underline = underline
  if (c.isStrikethrough()) p.strike = true
  if (c.isInverse()) p.inverse = true
  if (c.isDim()) p.dim = true
  if (c.isBlink()) p.blink = true
  const uri = c.extended.urlId ? linkUri(c.extended.urlId) : undefined
  if (uri) p.link = uri
  return p
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
  const term = new Terminal({
    allowProposedApi: true,
    cols: size.cols,
    rows: size.rows,
    scrollback: 20_000,
    cursorStyle: CURSOR_STYLE,
    cursorBlink: CURSOR_BLINK,
  })
  term.loadAddon(new UnicodeGraphemesAddon())
  term.unicode.activeVersion = '15-graphemes'
  let title = ''
  term.onTitleChange((t) => {
    title = t
  })
  await new Promise<void>((resolve) => term.write(new Uint8Array(bytes), resolve))
  if (size.resize) {
    term.resize(size.resize.cols, size.resize.rows)
    await new Promise<void>((resolve) => term.write('', resolve))
  }
  // Private state, read because the public API has no getter for it: the OSC 8
  // uri behind a cell's link id, DECSCUSR's shape and blink (undefined after
  // DECSCUSR 0, meaning the options above), and DECTCEM.
  const core = (term as unknown as {
    _core: {
      _oscLinkService: { getLinkData(id: number): { uri: string } | undefined }
      coreService: {
        isCursorHidden: boolean
        decPrivateModes: { cursorStyle?: 'block' | 'underline' | 'bar'; cursorBlink?: boolean }
      }
    }
  })._core
  const linkUri = (id: number): string | undefined => core._oscLinkService.getLinkData(id)?.uri
  const buf = term.buffer.active
  const text: string[] = []
  const cells: CellPen[][] = []
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
    const pens: CellPen[] = []
    for (let x = 0; x < term.cols; x++) {
      const cell = line?.getCell(x)
      w.push(cell?.getWidth() ?? 1)
      pens.push(cell ? pen(cell, linkUri) : {})
    }
    widths.push(w)
    cells.push(pens)
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
    cells,
    cursorStyle: {
      shape: core.coreService.decPrivateModes.cursorStyle ?? CURSOR_STYLE,
      blink: core.coreService.decPrivateModes.cursorBlink ?? CURSOR_BLINK,
      visible: !core.coreService.isCursorHidden,
    },
    title,
    modes: {
      appCursor: term.modes.applicationCursorKeysMode,
      bracketedPaste: term.modes.bracketedPasteMode,
      mouse: term.modes.mouseTrackingMode,
      altScreen: buf.type === 'alternate',
      origin: term.modes.originMode,
      autowrap: term.modes.wraparoundMode,
    },
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
