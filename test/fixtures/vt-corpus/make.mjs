#!/usr/bin/env node
// Writes the VT corpus: NN-name.bin (the bytes a pane receives) and
// NN-name.json ({cols, rows} and, for 13, the resize). 12-captured.bin is a
// recording and is committed as is; this script never touches it. It was made
// with util-linux script -q at 80x24 (TERM=xterm-256color), the header and
// footer lines cut off, the two recordings joined and trimmed to 20 KB:
//   zsh -f -c 'eval "$(dircolors -b)"; stty cols 80 rows 24; ls --color /usr/lib; ls -l --color /usr/lib | head -25'
//   claude started in an empty directory under /tmp, no input, stopped by timeout after 9 s
//   (its first frame: the workspace trust prompt) test/dom/vt-corpus.test.ts records what xterm.js makes of each
// file and scripts/vt-parity.mjs checks the native grid against that.
// Usage: node test/fixtures/vt-corpus/make.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const ESC = '\x1b'
const CSI = `${ESC}[`
const OSC = `${ESC}]`
const ST = `${ESC}\\`
const BEL = '\x07'

function write(name, size, text) {
  writeFileSync(join(DIR, `${name}.bin`), Buffer.from(text, 'utf8'))
  writeFileSync(join(DIR, `${name}.json`), `${JSON.stringify(size)}\n`)
}

// 01: plain lines and wrapping at 40 columns, including a line of exactly 40.
{
  let s = 'plain line one\r\nsecond line\r\n'
  s += 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ wraps here\r\n'
  s += 'x'.repeat(40) + '\r\n'
  s += 'y'.repeat(95) + '\r\n'
  s += 'last'
  write('01-wrap', { cols: 40, rows: 12 }, s)
}

// 02: CR, LF, BS, TAB.
{
  let s = 'overwrite me\rOVER\r\n'
  s += 'down\nand on\r\n'
  s += 'abc\b\bXY\r\n'
  s += 'a\tb\tc\td\r\n'
  s += '\t\tdeep tab\r\n'
  s += 'tail\b\b\b\b\bfront'
  write('02-controls', { cols: 40, rows: 10 }, s)
}

// 03: CUP, CUU/CUD/CUF/CUB, ED 0/1/2, EL 0/1/2. ED 2 first wipes what was
// there (without moving the cursor), then the rows are drawn and cut up.
{
  let s = 'gone\r\ngone too'
  s += `${CSI}2J${CSI}H`
  for (let i = 0; i < 8; i++) s += `row ${i} ${'0123456789'.repeat(3)}\r\n`
  s += `${CSI}2;5H[A]`
  s += `${CSI}2B[B]${CSI}3C[C]${CSI}1A[D]${CSI}6D[E]`
  s += `${CSI}5;10H${CSI}K`
  s += `${CSI}6;10H${CSI}1K`
  s += `${CSI}7;1H${CSI}2K`
  s += `${CSI}3;20H${CSI}1J`
  s += `${CSI}8;15H${CSI}0J`
  s += `${CSI}9;1Hafter erase`
  write('03-cursor-erase', { cols: 40, rows: 10 }, s)
}

// 04: SGR 16, 256 and truecolor, bold, underline, reverse, reset.
{
  let s = ''
  for (let i = 30; i < 38; i++) s += `${CSI}${i}mfg${i}${CSI}0m `
  s += '\r\n'
  for (let i = 90; i < 98; i++) s += `${CSI}${i}mhi${i}${CSI}0m `
  s += '\r\n'
  for (let i = 0; i < 16; i++) s += `${CSI}38;5;${i * 16}m#${CSI}48;5;${255 - i}m@`
  s += `${CSI}0m\r\n`
  s += `${CSI}38;2;255;100;0mtruecolor${CSI}48;2;0;40;80m on blue${CSI}0m\r\n`
  s += `${CSI}1mbold${CSI}22m ${CSI}4munder${CSI}24m ${CSI}7mreverse${CSI}27m ${CSI}3mitalic${CSI}23m ${CSI}9mstrike${CSI}0m\r\n`
  s += `${CSI}1;4;31mall at once${CSI}mreset`
  write('04-sgr', { cols: 60, rows: 8 }, s)
}

// 05: a scroll region with DECSTBM, then IL and DL inside it.
{
  let s = ''
  for (let i = 0; i < 10; i++) s += `line ${i}${i < 9 ? '\r\n' : ''}`
  s += `${CSI}3;7r`
  s += `${CSI}7;1H\r\nscrolled in region`
  s += `${CSI}4;1H${CSI}2Linserted A\r\ninserted B`
  s += `${CSI}5;1H${CSI}1M`
  s += `${CSI}r${CSI}10;1Hbottom`
  write('05-scroll-region', { cols: 30, rows: 10 }, s)
}

// 06: the alt screen, entered, drawn on, and left (?1049h/l).
{
  let s = 'primary one\r\nprimary two\r\n$ '
  s += `${CSI}?1049h${CSI}H${CSI}2J`
  s += 'ALT SCREEN\r\nfull screen app'
  s += `${CSI}5;5Hmiddle`
  s += `${CSI}?1049l`
  s += 'back'
  write('06-altscreen', { cols: 30, rows: 8 }, s)
}

// 07: DECSCUSR shapes and cursor visibility; the text is what matters to the
// corpus, the shape and visibility to the grid's own state.
{
  let s = `${CSI}1 qblink block\r\n${CSI}2 qsteady block\r\n${CSI}4 qunderline\r\n${CSI}6 qbar\r\n`
  s += `${CSI}?25lhidden${CSI}?25h shown${CSI}0 q`
  write('07-cursor-shape', { cols: 30, rows: 8 }, s)
}

// 08: 60 rows streamed into a 10-row grid; 50 go to scrollback.
{
  let s = ''
  for (let i = 0; i < 60; i++) s += `stream ${String(i).padStart(2, '0')}\r\n`
  s += 'prompt'
  write('08-scrollback', { cols: 30, rows: 10 }, s)
}

// 09: wide CJK and emoji at the right edge: a wide char that does not fit in
// the last column wraps whole.
{
  const cjk = '中文字'
  let s = `${'a'.repeat(19)}${cjk}\r\n`
  s += `${'b'.repeat(18)}${cjk}\r\n`
  s += `${'c'.repeat(19)}\u{1F600}x\r\n`
  s += `\u{1F468}‍\u{1F469}‍\u{1F467} family \u{1F1EF}\u{1F1F5} flag ❤️ heart\r\n`
  s += `한국어 こんにちは é`
  write('09-wide-edge', { cols: 20, rows: 10 }, s)
}

// 10: OSC 0 title, OSC 7 cwd, OSC 8 link on and off (BEL and ST terminated).
{
  let s = `${OSC}0;the title${BEL}`
  s += `${OSC}7;file://host/Users/joshwald/src${ST}`
  s += `before ${OSC}8;;https://example.com/a${ST}link text${OSC}8;;${ST} after\r\n`
  s += `${OSC}8;id=x;https://example.com/b${BEL}second${OSC}8;;${BEL} plain\r\n`
  s += `${OSC}2;second title${ST}done`
  write('10-osc', { cols: 40, rows: 6 }, s)
}

// 11: bracketed paste and mouse modes set, a mode query, then text.
{
  let s = `${CSI}?2004h${CSI}?1000h${CSI}?1006h`
  s += `${CSI}?2004$p`
  s += 'modes on\r\n'
  s += `${CSI}?1000l${CSI}?1006l${CSI}?2004l`
  s += 'modes off'
  write('11-modes', { cols: 30, rows: 6 }, s)
}

// 13: 20 rows at 80 columns, then resized to 40 columns (reflow). The cursor
// ends on a short prompt line: xterm.js leaves the cursor's own line unreflowed
// (the shell redraws it) where libvterm reflows it, so a long cursor line
// would compare that policy rather than the reflow.
{
  let s = ''
  for (let i = 0; i < 20; i++) {
    const len = 10 + ((i * 7) % 70)
    s += `${String(i).padStart(2, '0')}:${'abcdefghij'.repeat(8).slice(0, len)}\r\n`
  }
  s += '$ '
  write('13-resize', { cols: 80, rows: 24, resize: { cols: 40, rows: 24 } }, s)
}
