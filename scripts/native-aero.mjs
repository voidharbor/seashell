#!/usr/bin/env node
// The Aero exactness pass (Phase 3 plan Task 6 step 1): the Win7 chrome's
// pixels against redesign spec 6.3, read back through the test driver's
// `pixels` (one PrintWindow capture with PW_RENDERFULLCONTENT per call),
// against scratch l6 on the second display (bounds 1028, -979, as the matrix
// and scripts/native-colors.mjs, so nothing shoots black), never focused.
//
// Usage (from WSL): node scripts/native-aero.mjs
//
// The colorization override #FF881798 and a light tab strip, so the expected
// values are the spec's. One line per sampled point:
//   aero: <control> <point> ok
//   aero: <control> <point> got #xxxxxx want #yyyyyy
//   aero: <control> <point> open (got #xxxxxx, spec silent on AA)
// with a tolerance of 3 per channel. A gradient's expected value is the spec
// stops interpolated at the sampled pixel's centre. Controls and points:
//   button        the Settings sheet's Done: border-left (left edge, mid
//                 height), face-25 and face-75 (mid width), pressed-25,
//                 pressed-75 and pressed-border (the same points while the
//                 driver holds the left button on it; released on the card's
//                 face, so it activates nothing; the pressed border is Win7's,
//                 as 6.3 gives none). Hover is not drivable (the real pointer is
//                 elsewhere, so its WM_MOUSELEAVE ends it at once).
//   tab-inactive  face-20 and face-80 (5 DIP in from the right edge, clear
//                 of the label), border-top (mid width)
//   tab-active    face-20, bottom-row (equal to the body token: the join)
//   status        line-top, face-20 and face-80 (4 DIP in from the right)
//   scrollbar     the explorer's: track-mid (the free track under the thumb),
//                 up-25 and up-75 (the up arrow's button face, mid width),
//                 thumb-mid (mid width, halfway between the thumb's top and
//                 its grip lines)
//   menu          the explorer's context menu on a row of Home's listing (the
//                 root row binds none): face, border-left, then after key
//                 Down highlight and highlight-border
//   card          the Settings sheet's card (the restore card's stand-in):
//                 face, border-top, corner (the top-left pixel, outside the
//                 6 DIP radius, equal to the dimmed pixel beside it)
//   checkbox      the first Panes check box: border-left
// Shots at 1x: P3-settings.png, P3-menu.png, P3-button-states.png (Done
// (the default), Done pressed, a plain option button, a disabled option
// button (CRT glass), left to right on the card face) and the crops in bakeoff\p3-crops\<control>-<state>.png. Types
// nothing into a pane (the keys are the explorer chord and the menu's Down
// and Escape, which the shell takes). Colours change only through the
// scratch's own driver override. Always quits l6 through its driver, removes
// its pid folder once the pid is gone, and exits non-zero on any got/want or
// failure (open lines do not fail the run).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import {
  BUILD_WIN,
  PIDS,
  SCRATCH_WIN,
  drive,
  launchShell,
  model,
  must,
  pidAlive,
  quitShell,
  sleep,
  toLocal,
  waitFile,
  writeBounds,
} from './native-gates.mjs'

const NAME = 'l6'
const UD = `${SCRATCH_WIN}\\${NAME}`
const UD_LINUX = toLocal(UD)
const BAKEOFF = `${BUILD_WIN}\\bakeoff`
const CROPS_LINUX = toLocal(`${BAKEOFF}\\p3-crops`)
const TOL = 3
const now = () => Date.now()

// Redesign spec 6.3. Gradients are [position, colour] stops, top to bottom
// (the thumb's left to right); a repeated position is a hard stop.
const SPEC = {
  btnBorder: '#707070',
  btnFace: [[0, '#F2F2F2'], [0.5, '#EBEBEB'], [0.5, '#DDDDDD'], [1, '#CFCFCF']],
  btnPressed: [[0, '#E5F4FC'], [0.5, '#C4E5F6'], [0.5, '#98D1EF'], [1, '#68B3DB']],
  btnPressedBorder: '#2C628B', // 6.3 gives none; the Win7 PBS_PRESSED border (win7-ref SAMPLES.txt)
  tabBorder: '#8E8F8F',
  tabInactive: [[0, '#F2F2F2'], [1, '#DCDCDC']],
  tabActive: [[0, '#FFFFFF'], [1, '#F3F3F3']],
  status: [[0, '#F7F7F7'], [1, '#ECECEC']],
  statusLine: '#A0A0A0',
  track: '#F0F0F0',
  thumb: [[0, '#F0F0F0'], [1, '#E3E3E3']],
  menuFace: '#F0F0F0',
  menuBorder: '#979797',
  menuHi: '#DCEBFC',
  menuHiBorder: '#7DA2CE',
  cardFace: '#F0F0F0',
  cardBorder: '#A0A0A0',
  checkBorder: '#8E8F8F', // the plan's check box border (6.3 has no check box line)
}

// ------------------------------------------------------------- colour helpers

const rgbOf = (hex) => {
  const m = /^#(?:[0-9a-fA-F]{2})?([0-9a-fA-F]{6})$/.exec(String(hex))
  if (!m) throw new Error(`not a colour: ${hex}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const hexOf = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`
const near = (a, b, tol = TOL) => rgbOf(a).every((v, i) => Math.abs(v - rgbOf(b)[i]) <= tol)
const lerp = (a, b, t) => hexOf(rgbOf(a).map((v, i) => v + (rgbOf(b)[i] - v) * t))
// The stops at t (0 to 1); at a hard stop, below it takes the upper segment.
function grad(stops, t) {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 0; i + 1 < stops.length; i++) {
    const [p0, c0] = stops[i]
    const [p1, c1] = stops[i + 1]
    if (p1 === p0) continue
    if (x <= p1 || i + 2 === stops.length) return lerp(c0, c1, (x - p0) / (p1 - p0))
  }
  return stops[stops.length - 1][1]
}

// --------------------------------------------------------------- the driver

const M = () => model(UD)
async function until(what, timeoutMs, pred) {
  const end = now() + timeoutMs
  for (;;) {
    const m = await M()
    if (pred(m)) return m
    if (now() >= end) throw new Error(what)
    await sleep(100)
  }
}
const click = (target, extra = {}) => must(UD, { cmd: 'click', target, ...extra }, `click ${target}`)
const key = (chord) => must(UD, { cmd: 'key', chord }, `key ${chord}`)
const rect = (target) => must(UD, { cmd: 'rect', target }, `rect ${target}`)
async function tryRect(target) {
  const r = await drive(UD, { cmd: 'rect', target })
  return r.ok ? r : null
}

async function shot(file) {
  rmSync(toLocal(`${BAKEOFF}\\${file}`), { force: true })
  await sleep(500) // the repaint after the last model lands within a frame or two
  const s = await must(UD, { cmd: 'shot', path: `${BAKEOFF}\\${file}` }, `shot ${file}`)
  return s.path
}

// The pixel at a client DIP point is the device pixel floor(DIP * scale);
// its centre is what a gradient's expected value is taken at.
let SCALE = 1
const rowT = (r, y) => (Math.floor(y * SCALE) + 0.5 - r.y * SCALE) / (r.h * SCALE)
const colT = (x0, w, x) => (Math.floor(x * SCALE) + 0.5 - x0 * SCALE) / (w * SCALE)

// ----------------------------------------------------------------- results

const results = { ok: 0, bad: 0, open: 0, fail: 0 }
// Samples are { control, point, x, y, want } (want a hex, or { same: index }
// for the colour read at another sample of the same call), aa when the point
// sits in an anti-aliased edge the spec leaves open.
async function sample(samples, extra = {}) {
  const r = await must(UD, { cmd: 'pixels', points: samples.map(({ x, y }) => ({ x, y })), ...extra }, 'pixels')
  SCALE = r.scale || 1
  samples.forEach((s, i) => {
    if (s.ref) return // a reference point, compared through another sample
    const got = r.colors[i]
    const want = s.want && typeof s.want === 'object' ? r.colors[s.want.same] : s.want
    if (!got || !want) {
      console.log(`aero: ${s.control} ${s.point} got ${got ?? 'nothing'} want ${want ?? 'nothing'} (off the capture)`)
      results.bad++
    } else if (near(got, want)) {
      console.log(`aero: ${s.control} ${s.point} ok`)
      results.ok++
    } else if (s.aa) {
      console.log(`aero: ${s.control} ${s.point} open (got ${got}, spec silent on AA)`)
      results.open++
    } else {
      console.log(`aero: ${s.control} ${s.point} got ${got} want ${hexOf(rgbOf(want))}`)
      results.bad++
    }
  })
  return r
}

// --------------------------------------------------------------- PNG output

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
// An 8-bit RGB PNG from w * h * 3 bytes.
function writePng(path, w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1))
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  writeFileSync(path, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
const regionOf = (reply) => {
  const g = reply.region
  return { w: g.w, h: g.h, rgb: Buffer.from(g.hex, 'hex') }
}
const crops = []
function saveCrop(name, region) {
  mkdirSync(CROPS_LINUX, { recursive: true })
  writePng(`${CROPS_LINUX}/${name}.png`, region.w, region.h, region.rgb)
  crops.push(`${BAKEOFF}\\p3-crops\\${name}.png (${region.w}x${region.h})`)
}
const grow = (r, d) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d })

// Crops side by side, top-aligned, on a background colour, 8 px apart.
function composite(path, regions, bg) {
  const pad = 8
  const w = regions.reduce((a, r) => a + r.w, 0) + pad * (regions.length + 1)
  const h = Math.max(...regions.map((r) => r.h)) + 2 * pad
  const out = Buffer.alloc(w * h * 3)
  const [br, bgc, bb] = rgbOf(bg)
  for (let i = 0; i < w * h; i++) {
    out[i * 3] = br
    out[i * 3 + 1] = bgc
    out[i * 3 + 2] = bb
  }
  let x0 = pad
  for (const r of regions) {
    for (let y = 0; y < r.h; y++) r.rgb.copy(out, ((pad + y) * w + x0) * 3, y * r.w * 3, (y + 1) * r.w * 3)
    x0 += r.w + pad
  }
  writePng(path, w, h, out)
  return `${w}x${h}`
}

// ------------------------------------------------------------------ checks

async function checkTabs() {
  const m = await M()
  const inactive = m.tabs.find((t) => !t.active)
  const active = m.tabs.find((t) => t.active)
  if (!inactive || !active) throw new Error(`tabs ${JSON.stringify(m.tabs.map((t) => [t.id, t.active]))}`)
  const ri = await rect(`tab:${inactive.id}`)
  const ra = await rect(`tab:${active.id}`)
  const xi = ri.x + ri.w - 5, xa = ra.x + ra.w - 5
  const at = (r, f) => r.y + r.h * f
  const body = m.tokens.body
  await sample([
    { control: 'tab-inactive', point: 'face-20', x: xi, y: at(ri, 0.2), want: grad(SPEC.tabInactive, rowT(ri, at(ri, 0.2))) },
    { control: 'tab-inactive', point: 'face-80', x: xi, y: at(ri, 0.8), want: grad(SPEC.tabInactive, rowT(ri, at(ri, 0.8))) },
    { control: 'tab-inactive', point: 'border-top', x: ri.x + ri.w / 2, y: ri.y + 0.5, want: SPEC.tabBorder },
    { control: 'tab-active', point: 'face-20', x: xa, y: at(ra, 0.2), want: grad(SPEC.tabActive, rowT(ra, at(ra, 0.2))) },
    { control: 'tab-active', point: 'bottom-row', x: xa, y: ra.y + ra.h - 0.5, want: body },
  ])
  saveCrop('tab-inactive', regionOf(await must(UD, { cmd: 'pixels', points: [], rect: ri }, 'pixels tab')))
  saveCrop('tab-active', regionOf(await must(UD, { cmd: 'pixels', points: [], rect: ra }, 'pixels tab')))
}

async function checkStatus() {
  const r = await rect('status')
  const x = r.x + r.w - 4
  const y20 = r.y + r.h * 0.2, y80 = r.y + r.h * 0.8
  await sample([
    { control: 'status', point: 'line-top', x: r.x + r.w / 2, y: r.y + 0.5, want: SPEC.statusLine },
    { control: 'status', point: 'face-20', x, y: y20, want: grad(SPEC.status, rowT(r, y20)) },
    { control: 'status', point: 'face-80', x, y: y80, want: grad(SPEC.status, rowT(r, y80)) },
  ])
}

// The explorer shown with Home's listing in (more rows than the root).
async function showSidebar() {
  let m = await M()
  if (!m.sidebar.visible) await key('Ctrl+Shift+B')
  m = await until('the explorer never listed Home', 10000, (x) => x.sidebar.visible && x.sidebar.rows.length > 1)
  await sleep(300)
  return m
}

async function checkScrollbar() {
  let m = await showSidebar()
  let up = await tryRect('sidebar:scroll:up')
  // The rows must overflow for the bar to show: open the first folders until they do.
  for (const row of m.sidebar.rows.filter((r) => r.isDir && !r.expanded && r.depth === 1).slice(0, 6)) {
    if (up) break
    await click(`sidebar:twisty:${row.path}`)
    await sleep(600)
    up = await tryRect('sidebar:scroll:up')
  }
  if (!up) throw new Error(`the explorer never overflowed (${(await M()).sidebar.rows.length} rows), so it has no scrollbar`)
  const track = await rect('sidebar:scroll:track')
  const thumb = await rect('sidebar:scroll:thumb')
  // The free track: the longer part above or below the thumb.
  const above = thumb.y - track.y, below = track.y + track.h - (thumb.y + thumb.h)
  const ty = below >= above ? thumb.y + thumb.h + below / 2 : track.y + above / 2
  const mx = up.x + up.w / 2
  const u25 = up.y + up.h * 0.25, u75 = up.y + up.h * 0.75
  // The grip lines sit at the thumb's middle, 3 px either side of it.
  const cy = Math.round(thumb.y + thumb.h / 2)
  const gy = thumb.h >= 14 ? thumb.y + (cy - 3 - thumb.y) / 2 : thumb.y + thumb.h / 2
  const tx = thumb.x + thumb.w / 2
  await sample([
    { control: 'scrollbar', point: 'track-mid', x: track.x + track.w / 2, y: ty, want: SPEC.track },
    { control: 'scrollbar', point: 'up-25', x: mx, y: u25, want: grad(SPEC.btnFace, rowT(up, u25)) },
    { control: 'scrollbar', point: 'up-75', x: mx, y: u75, want: grad(SPEC.btnFace, rowT(up, u75)) },
    // The thumb face is inset 1 px from the bar on each side (scrollbar.cpp).
    { control: 'scrollbar', point: 'thumb-mid', x: tx, y: gy, want: grad(SPEC.thumb, colT(thumb.x + 1, thumb.w - 2, tx)) },
  ])
  saveCrop('scrollbar-up-normal', regionOf(await must(UD, { cmd: 'pixels', points: [], rect: up }, 'pixels up')))
  saveCrop('scrollbar-thumb-normal', regionOf(await must(UD, { cmd: 'pixels', points: [], rect: thumb }, 'pixels thumb')))
}

async function checkMenu() {
  const m = await showSidebar()
  // The root row binds no menu (controller rowEvent, Explorer.tsx:384-401):
  // the first file in Home's listing that is on screen, else its first folder.
  const kids = m.sidebar.rows.filter((r) => r.depth === 1)
  let row = null
  for (const r of [...kids.filter((k) => !k.isDir), ...kids.filter((k) => k.isDir)]) {
    if (await tryRect(`sidebar:${r.id}`)) {
      row = r
      break
    }
  }
  if (!row) throw new Error('no row of Home on screen')
  await click(`sidebar:${row.id}`, { button: 2 })
  const y = await until('no context menu', 5000, (x) => x.sidebar.menu)
  const items = y.sidebar.menu.items
  const first = items.find((i) => i.enabled)
  if (!first) throw new Error(`no enabled item: ${JSON.stringify(items)}`)
  const other = items.find((i) => i !== first)
  await key('Down')
  await sleep(300)
  const r = await rect('sidebar:menu')
  const hi = await rect(`sidebar:menu:${first.id}`)
  const plain = other ? await rect(`sidebar:menu:${other.id}`) : null
  // The face beside a plain item's end, or the menu's top padding.
  const fy = plain ? plain.y + plain.h / 2 : r.y + 2.5
  await sample([
    { control: 'menu', point: 'face', x: r.x + r.w - 6, y: fy, want: SPEC.menuFace },
    { control: 'menu', point: 'border-left', x: r.x + 0.5, y: r.y + r.h / 2, want: SPEC.menuBorder },
    { control: 'menu', point: 'highlight', x: hi.x + hi.w - 4, y: hi.y + hi.h / 2, want: SPEC.menuHi },
    { control: 'menu', point: 'highlight-border', x: hi.x + 0.5, y: hi.y + hi.h / 2, want: SPEC.menuHiBorder },
  ])
  saveCrop('menu-highlight', regionOf(await must(UD, { cmd: 'pixels', points: [], rect: grow(hi, 1) }, 'pixels menu')))
  const path = await shot('P3-menu.png')
  await key('Escape')
  await until('Escape never closed the menu', 5000, (x) => !x.sidebar.menu)
  return `right-click on ${row.name}${row.isDir ? '/' : ''}: ${items.map((i) => `${i.id}${i.enabled ? '' : ' (off)'}`).join(', ')}, Down highlighted ${first.id}; ${path}`
}

async function openSettings() {
  const m = await M()
  if (m.sheet && m.sheet.kind === 'settings') return m
  await click('settings')
  return until('the Settings sheet never opened', 5000, (x) => x.sheet && x.sheet.kind === 'settings')
}

async function lightStrip() {
  await openSettings()
  await click('sheet:settings:tabStrip:light')
  await until('tabStrip light never applied', 5000, (x) => {
    const f = (x.sheet?.sections || []).flatMap((s) => s.fields).find((f) => f.id === 'tabStrip')
    return !!f && f.options.some((o) => o.id === 'light' && o.selected) && x.tokens?.stripDark === '0'
  })
  await click('sheet:settings:btn:done')
  await until('Done never closed the sheet', 5000, (x) => !x.sheet)
}

// Scrolls the sheet from its top, a notch at a time, until `target` sits
// wholly inside its body (`needH` DIP tall; the rects come clipped to it).
async function sheetShow(target, needH) {
  const card = await rect('sheet:settings:card')
  const top = card.y + 46, bottom = card.y + card.h - 56 // sheet.h kHead, kFoot
  await must(UD, { cmd: 'wheel', target: 'sheet:settings:card', dy: 40 }, 'wheel sheet to the top')
  await sleep(150)
  for (let i = 0; i < 40; i++) {
    const r = await tryRect(target)
    if (r && r.y > top + 1 && r.y + needH < bottom - 1) return r
    await must(UD, { cmd: 'wheel', target: 'sheet:settings:card', dy: -1 }, 'wheel sheet')
    await sleep(150)
  }
  throw new Error(`${target} never came into view`)
}

async function checkSheet() {
  await openSettings()
  const settingsShot = await shot('P3-settings.png')
  const card = await rect('sheet:settings:card')
  const done = await rect('sheet:settings:btn:done')
  const at = (f) => done.y + done.h * f
  const mid = done.x + done.w / 2
  const face = [
    { control: 'button', point: 'border-left', x: done.x + 0.5, y: done.y + done.h / 2, want: SPEC.btnBorder },
    { control: 'button', point: 'face-25', x: mid, y: at(0.25), want: grad(SPEC.btnFace, rowT(done, at(0.25))) },
    { control: 'button', point: 'face-75', x: mid, y: at(0.75), want: grad(SPEC.btnFace, rowT(done, at(0.75))) },
  ]
  const cardPts = [
    { control: 'card', point: 'face', x: card.x + card.w - 4, y: card.y + card.h / 2, want: SPEC.cardFace },
    { control: 'card', point: 'border-top', x: card.x + card.w / 2, y: card.y + 0.5, want: SPEC.cardBorder },
    { control: 'card', point: 'corner', x: card.x + 0.5, y: card.y + 0.5, want: { same: face.length + 3 } },
    { ref: true, x: card.x - 1.5, y: card.y - 1.5 },
  ]
  const normal = await sample([...face, ...cardPts], { rect: grow(done, 3) })
  const doneNormal = regionOf(normal)
  saveCrop('done-normal', doneNormal)
  // Pressed: the left button held on Done through the capture, released on
  // the card's left margin (no control there), so Done never activates.
  const releaseAt = { x: card.x + 4, y: card.y + card.h / 2 }
  const pressed = await sample(
    [
      { control: 'button', point: 'pressed-25', x: mid, y: at(0.25), want: grad(SPEC.btnPressed, rowT(done, at(0.25))) },
      { control: 'button', point: 'pressed-75', x: mid, y: at(0.75), want: grad(SPEC.btnPressed, rowT(done, at(0.75))) },
      { control: 'button', point: 'pressed-border', x: done.x + 0.5, y: done.y + done.h / 2, want: SPEC.btnPressedBorder },
    ],
    { press: 'sheet:settings:btn:done', releaseAt, rect: grow(done, 3) },
  )
  const donePressed = regionOf(pressed)
  saveCrop('done-pressed', donePressed)
  await sleep(300)
  const after = await M()
  if (!after.sheet || after.sheet.kind !== 'settings') throw new Error('the press on Done closed the sheet (it activated)')
  const pressNote = `pressed through pixels {press}, released at ${JSON.stringify(pressed.press?.releasedAt)}, the sheet still open`

  // The first Panes check box and a disabled option button, scrolled into view.
  const panes = after.sheet.sections.find((s) => s.fields.some((f) => f.kind === 'check'))
  const check = panes.fields.find((f) => f.kind === 'check')
  const row = await sheetShow(`sheet:settings:${check.id}`, 18)
  const box = { x: Math.round(row.x), y: Math.round(row.y + 3), w: 13, h: 13 } // sheet.cpp: kCheck at the row's top plus 3
  const cb = await sample([{ control: 'checkbox', point: 'border-left', x: box.x + 0.5, y: box.y + 6.5, want: SPEC.checkBorder }], { rect: grow(box, 2) })
  saveCrop(`checkbox-${check.value ? 'checked' : 'unchecked'}`, regionOf(cb))
  // A disabled option button, CRT glass's if it has one (a plain label).
  const withDisabled = after.sheet.sections.flatMap((s) => s.fields).filter((f) => f.kind === 'buttons' && f.options.some((o) => o.disabled))
  const disabledField = withDisabled.find((f) => f.id === 'crt') || withDisabled[0]
  let disabledRegion = null
  let disabledNote = 'no disabled option on the sheet'
  if (disabledField) {
    const opt = disabledField.options.find((o) => o.disabled && !o.selected) || disabledField.options.find((o) => o.disabled)
    const target = `sheet:settings:${disabledField.id}:${opt.id}`
    const r = await sheetShow(target, 24)
    disabledRegion = regionOf(await must(UD, { cmd: 'pixels', points: [], rect: grow(r, 3) }, 'pixels disabled'))
    saveCrop('option-disabled', disabledRegion)
    disabledNote = `disabled: ${disabledField.id} ${JSON.stringify(opt.label)}`
  }
  // A plain option button (enabled, not selected, no swatch, not under the
  // pointer): the Normal state, which Done (the default, with its ring) is not.
  const normalField = after.sheet.sections
    .flatMap((s) => s.fields)
    .find((f) => f.kind === 'buttons' && f.options.some((o) => !o.disabled && !o.selected && !o.swatch))
  let normalRegion = null
  let normalNote = 'no plain option on the sheet'
  if (normalField) {
    const opt = normalField.options.find((o) => !o.disabled && !o.selected && !o.swatch)
    const r = await sheetShow(`sheet:settings:${normalField.id}:${opt.id}`, 24)
    normalRegion = regionOf(await must(UD, { cmd: 'pixels', points: [], rect: grow(r, 3) }, 'pixels normal'))
    saveCrop('option-normal', normalRegion)
    normalNote = `normal: ${normalField.id} ${JSON.stringify(opt.label)}`
  }
  const statesPath = `${BAKEOFF}\\P3-button-states.png`
  const size = composite(
    toLocal(statesPath),
    [doneNormal, donePressed, ...(normalRegion ? [normalRegion] : []), ...(disabledRegion ? [disabledRegion] : [])],
    SPEC.cardFace,
  )
  await click('sheet:settings:btn:done')
  await until('Done never closed the sheet', 5000, (x) => !x.sheet)
  return `${settingsShot}; ${statesPath} (${size}: Done (the default), Done pressed, ${normalNote}, ${disabledNote}); ${pressNote}`
}

// --------------------------------------------------------------------- main

async function main() {
  let pid = 0
  let corePid = 0
  let failed = 0
  try {
    rmSync(UD_LINUX, { recursive: true, force: true })
    mkdirSync(UD_LINUX, { recursive: true })
    writeBounds(UD_LINUX, { x: 1028, y: -979 }) // the second display, as the matrix
    pid = launchShell(NAME)
    console.log(`launched scratch ${NAME} (pid ${pid})`)
    if (!(await waitFile(`${UD_LINUX}/test.json`, 30000))) throw new Error('no test.json in 30 s')
    await must(UD, { cmd: 'wait', path: '/panes/0/status', equals: 'live', timeoutMs: 60000 }, 'first pane live')
    await must(UD, { cmd: 'wait', path: '/tokens/accent', timeoutMs: 20000 }, 'tokens')
    try {
      corePid = Number(JSON.parse(readFileSync(`${UD_LINUX}/control.json`, 'utf8')).corePid) || 0
    } catch {}
    // The spec's colorization and a light strip (the override, read only).
    await must(UD, { cmd: 'colorization', argb: '#FF881798', appsDark: false }, 'colorization')
    await until('the #881798 tokens never applied', 8000, (x) => /^#881798$/i.test(x.tokens?.accent || '') && x.tokens?.stripDark === '0')
    await lightStrip()
    // A second tab, so one is inactive.
    await click('tab:new')
    const m = await until('the second tab never came', 15000, (x) => x.tabs.length >= 2 && x.panes.every((p) => p.status === 'live'))
    console.log(`colorization #FF881798, tab strip light, ${m.tabs.length} tabs, body ${m.tokens.body}, composition ${m.tokens.composition}`)
    const checks = [
      ['tabs', checkTabs],
      ['status', checkStatus],
      ['scrollbar', checkScrollbar],
      ['menu', checkMenu],
      ['sheet', checkSheet],
    ]
    for (const [label, fn] of checks) {
      try {
        const note = await fn()
        if (note) console.log(`${label}: ${note}`)
      } catch (e) {
        console.log(`aero: ${label} fail ${e.message}`)
        results.fail++
      }
    }
    console.log(`crops: ${crops.join(', ')}`)
  } catch (e) {
    console.log(`aero: fail ${e.message}`)
    results.fail++
  } finally {
    if (pid) {
      try {
        await drive(UD, { cmd: 'colorization', argb: null, appsDark: null })
      } catch {}
      let how = 'not stopped'
      try {
        how = await quitShell(UD, pid, NAME)
      } catch (e) {
        how = `not stopped: ${e.message}`
      }
      let coreGone = !corePid
      for (const end = now() + 10000; corePid && !coreGone && now() < end; ) {
        coreGone = !existsSync(`/proc/${corePid}`)
        if (!coreGone) await sleep(250)
      }
      const gone = !pidAlive(pid)
      if (gone) rmSync(`${PIDS}/${pid}`, { recursive: true, force: true })
      console.log(`scratch ${NAME}: ${how}${corePid ? `; core ${corePid} ${coreGone ? 'gone' : 'STILL RUNNING'}` : ''}; pid folder ${gone ? 'removed' : 'kept (pid alive)'}`)
      if (how !== 'quit' || !coreGone) failed++
    }
  }
  console.log(`aero: ${results.ok} ok, ${results.bad} got/want, ${results.open} open, ${results.fail} failed`)
  process.exit(failed || results.bad || results.fail ? 1 : 0)
}

await main()
