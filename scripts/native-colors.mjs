#!/usr/bin/env node
// The colorization edge cases and the no-glass fallback (Phase 3 plan Task 5,
// Review Focus 5), against scratch l5 driven through its own test driver.
//
// Usage (from WSL): node scripts/native-colors.mjs
//
// Launches scratch l5 on the second display (bounds 1028, -979, as the matrix
// and the walk, so its shots are not black), never focused, and prints one
// line per check:
//   1 blue    colorization #FF0078D7: accent, frame the 43 percent blend over
//             #D9D9D9, frameText by the WCAG contrast rule; P3-color-blue.png
//   2 yellow  #FFFFB900: tabText and frameText are the dark text, never white;
//             P3-color-yellow.png
//   3 black   #FF000000: every *Text token reaches WCAG 4.5 on the token it is
//             painted on (the pairs below, from the painter code)
//   4 null    {argb:null} after an override: the desktop's own table again
//             (the 6.2 table when the desktop is #881798)
//   5 accent  the Settings accent survives a colorization; Theme default
//             restores the colorization's accent
//   6 setting settingChange null and Policy change nothing; ImmersiveColorSet
//             re-reads the app theme the driver armed without sending it
//   7 noglass composition off, light and dark strip: the opaque frame stops
//             138 DIP short of the right edge; P3-noglass-light.png and
//             P3-noglass-dark.png; composition back on
//   8 dpi     a note: window.uiScale and the shot's pixels per DIP
// Colours, appsDark and composition change only through the scratch's own
// driver overrides; the desktop, the registry and every other window are
// never written. Types nothing into a pane. Always quits l5 through its
// driver, removes its pid folder once the pid is gone, and exits non-zero on
// any failure.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
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

const NAME = 'l5'
const UD = `${SCRATCH_WIN}\\${NAME}`
const UD_LINUX = toLocal(UD)
const LOG = `${UD_LINUX}/shell.log`
const BAKEOFF = `${BUILD_WIN}\\bakeoff`
const CAPTION_DIP = 138 // the DWM caption buttons (tabs.cpp kCaptionDip, ui.cpp drawStrip)
const TOL = 3 // per channel, for pixels read back from a shot
const now = () => Date.now()

// colorization.ts: the derivation's dark text and white; 6.2's --text.
const DARK_TEXT = '#1E1E1E'
const WHITE = '#FFFFFF'
// Redesign spec 6.2 for #881798 (tokens.h / colorization.ts SPEC_TABLE keys).
const SPEC_62 = {
  accent: '#881798', // --accent
  accentText: '#FFFFFF', // --onAccent
  body: '#ECE2F0', // --chrome
  badge: '#E1D3E8', // --chromeAlt
  divider: '#B48FC0', // --line
  frameText: '#1D0F22', // --text
  tabText: '#1D0F22',
  titleText: '#1D0F22',
  badgeText: '#5A3F66', // --dim
  panel: '#FAF5FC', // --cardBg
  panelBorder: '#8F5FA0', // --paneBorder
  titleBar: '#EAD9F0', // --paneTitleBg
  frame: '#B685BD', // #881798 at 43 percent over #D9D9D9
  glassTint: '#38881798', // --barBg
}
// Each *Text token and the token it is painted on (native/shell/src/ui):
// frameText the strip's glyphs on the frame (tabs.cpp, ui.cpp drawStrip);
// tabText the tab label on the active and inactive faces (tabs.cpp);
// titleText the pane title (panes.cpp), the sidebar rows and drawer header on
// panel (sidebar.cpp, drawer.cpp) and "No tabs open" on body (overlays.cpp);
// badgeText the zoom badge and sidebar strip on badge, the pane title's meta
// on titleBar, the sidebar's notes on panel, the sheet's notes on the card
// (toastBg); statusText the status bar (status.cpp, statusBg its darker stop);
// toastText cards, toasts and the sheet (overlays.cpp, sheet.cpp);
// accentText the text on an accent fill.
const TEXT_PAIRS = [
  ['frameText', 'frame'],
  ['tabText', 'tabActive'],
  ['tabText', 'tabInactive'],
  ['titleText', 'titleBar'],
  ['titleText', 'panel'],
  ['titleText', 'body'],
  ['badgeText', 'badge'],
  ['badgeText', 'titleBar'],
  ['badgeText', 'panel'],
  ['badgeText', 'toastBg'],
  ['statusText', 'statusBg'],
  ['toastText', 'toastBg'],
  ['accentText', 'accent'],
]
const WCAG_AA = 4.5

// ------------------------------------------------------------- colour helpers

const rgbOf = (hex) => {
  const m = /^#(?:[0-9a-fA-F]{2})?([0-9a-fA-F]{6})$/.exec(String(hex))
  if (!m) throw new Error(`not a colour: ${hex}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const hexOf = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && rgbOf(a).join() === rgbOf(b).join()
const near = (a, b, tol = TOL) => rgbOf(a).every((v, i) => Math.abs(v - rgbOf(b)[i]) <= tol)
// WCAG 2.x relative luminance and contrast ratio.
const luminance = (hex) => {
  const lin = (v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = rgbOf(hex)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a, b) => {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const r2 = (n) => Math.floor(n * 100) / 100 // floored, so a printed 4.50 is never really 4.499
// The 43 percent blend over the Win7 base grey, floored per channel.
const blend43 = (hex) => hexOf(rgbOf(hex).map((v) => Math.floor(v * 0.43 + 0xd9 * 0.57)))

// --------------------------------------------------------------- PNG reading

// The shot's PNG (WIC, 8-bit RGB or RGBA, not interlaced): a pixel reader.
function readPng(path) {
  const buf = readFileSync(path)
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`)
  let off = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const kind = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      type = data[9]
      interlace = data[12]
    } else if (kind === 'IDAT') idat.push(data)
    else if (kind === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) throw new Error(`${path}: PNG depth ${depth} type ${type} interlace ${interlace} not read here`)
  const bpp = type === 6 ? 4 : 3
  const stride = w * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[row + i - bpp] : 0
      const b = y > 0 ? px[row - stride + i] : 0
      const c = i >= bpp && y > 0 ? px[row - stride + i - bpp] : 0
      let v = raw[src + i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[row + i] = v & 0xff
    }
  }
  const at = (x, y) => {
    const xi = Math.max(0, Math.min(w - 1, Math.round(x)))
    const yi = Math.max(0, Math.min(h - 1, Math.round(y)))
    const i = yi * stride + xi * bpp
    return hexOf([px[i], px[i + 1], px[i + 2]])
  }
  return { w, h, at }
}

// ------------------------------------------------------------ driver helpers

const M = () => model(UD)
async function until(what, timeoutMs, pred) {
  const end = now() + timeoutMs
  let m
  for (;;) {
    m = await M()
    if (pred(m)) return m
    if (now() >= end) throw new Error(`${what} (tokens ${JSON.stringify(pick(m.tokens || {}, ['accent', 'frame', 'frameText', 'stripDark', 'composition']))})`)
    await sleep(100)
  }
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]))
const color = (req) => must(UD, { cmd: 'colorization', ...req }, `colorization ${JSON.stringify(req)}`)
const click = (target) => must(UD, { cmd: 'click', target }, `click ${target}`)
const sentCount = () => (existsSync(LOG) ? (readFileSync(LOG, 'utf8').match(/colorization sent /g) || []).length : 0)

async function shot(file) {
  const linux = toLocal(`${BAKEOFF}\\${file}`)
  rmSync(linux, { force: true })
  await sleep(500) // the repaint after the last model lands within a frame or two
  const s = await must(UD, { cmd: 'shot', path: `${BAKEOFF}\\${file}` }, `shot ${file}`)
  return { path: s.path, linux, stamp: String(s.stamp || '').trim() }
}

async function openSettings() {
  const m = await M()
  if (m.sheet && m.sheet.kind === 'settings') return
  await click('settings') // the gear: the command app.settings
  await until('the Settings sheet never opened', 5000, (x) => x.sheet && x.sheet.kind === 'settings')
}
async function closeSettings() {
  const m = await M()
  if (!m.sheet) return
  await click('sheet:settings:btn:done')
  await until('Done never closed the sheet', 5000, (x) => !x.sheet)
}
async function setTabStrip(mode) {
  await openSettings()
  await click(`sheet:settings:tabStrip:${mode}`)
  await until(`tabStrip ${mode} never applied`, 5000, (x) => {
    const f = (x.sheet?.sections || []).flatMap((s) => s.fields).find((f) => f.id === 'tabStrip')
    return !!f && f.options.some((o) => o.id === mode && o.selected)
  })
  await closeSettings()
}

// ------------------------------------------------------------------- checks

async function checkBlue() {
  const argb = '#FF0078D7'
  await color({ argb })
  const m = await until('accent never became #0078D7', 8000, (x) => same(x.tokens?.accent, '#0078D7'))
  const t = m.tokens
  const frame = blend43(argb)
  const dark = contrast(DARK_TEXT, frame), light = contrast(WHITE, frame)
  const bad = []
  if (!same(t.frame, frame)) bad.push(`frame ${t.frame} want ${frame}`)
  if (contrast(t.frameText, t.frame) < WCAG_AA) bad.push(`frameText ${t.frameText} on ${t.frame} is ${r2(contrast(t.frameText, t.frame))}`)
  const want = dark >= light ? DARK_TEXT : WHITE
  if (Math.max(dark, light) >= WCAG_AA && !same(t.frameText, want)) bad.push(`frameText ${t.frameText} want ${want}`)
  const s = await shot('P3-color-blue.png')
  if (bad.length) throw new Error(bad.join('; '))
  return `accent ${t.accent}, frame ${t.frame} (#0078D7 at 43 percent over #D9D9D9), frameText ${t.frameText} (contrast ${r2(contrast(t.frameText, t.frame))}; dark ${r2(dark)}, white ${r2(light)}), composition ${t.composition}; shot ${s.path}`
}

async function checkYellow() {
  await color({ argb: '#FFFFB900' })
  const m = await until('accent never became #FFB900', 8000, (x) => same(x.tokens?.accent, '#FFB900'))
  const t = m.tokens
  const bad = []
  for (const k of ['tabText', 'frameText']) {
    if (same(t[k], WHITE)) bad.push(`${k} is white`)
    else if (!same(t[k], DARK_TEXT)) bad.push(`${k} ${t[k]} want the dark text ${DARK_TEXT}`)
  }
  const s = await shot('P3-color-yellow.png')
  if (bad.length) throw new Error(bad.join('; '))
  return `tabText ${t.tabText} on ${t.tabInactive}/${t.tabActive} (${r2(contrast(t.tabText, t.tabInactive))}), frameText ${t.frameText} on frame ${t.frame} (${r2(contrast(t.frameText, t.frame))}), never white; the dark text is the derivation's ${DARK_TEXT} (the plan's #1D0F22 is 6.2's --text for #881798 only); shot ${s.path}`
}

async function checkBlack() {
  await color({ argb: '#FF000000' })
  const m = await until('accent never became #000000', 8000, (x) => same(x.tokens?.accent, '#000000'))
  const t = m.tokens
  const rows = TEXT_PAIRS.map(([fg, bg]) => ({ fg, bg, a: t[fg], b: t[bg], r: contrast(t[fg], t[bg]) }))
  const low = rows.filter((x) => x.r < WCAG_AA)
  const table = rows.map((x) => `${x.fg} ${x.a}/${x.bg} ${x.b} ${r2(x.r)}`).join(', ')
  if (low.length) throw new Error(`under ${WCAG_AA}: ${low.map((x) => `${x.fg} ${x.a} on ${x.bg} ${x.b} ${r2(x.r)}`).join('; ')} (all: ${table})`)
  return `every *Text token at least ${WCAG_AA}: ${table}`
}

async function checkNull() {
  // An override first, so the null visibly undoes one.
  await color({ argb: '#FF107C10' })
  await until('the override never applied', 8000, (x) => same(x.tokens?.accent, '#107C10'))
  const r = await color({ argb: null })
  const dwm = r.dwm || {}
  const desk = typeof dwm.argb === 'string' ? hexOf(rgbOf(dwm.argb)) : null
  if (desk === null || same(desk, SPEC_62.accent)) {
    const m = await until('the 6.2 accent never came back', 8000, (x) => same(x.tokens?.accent, SPEC_62.accent))
    const off = Object.entries(SPEC_62).filter(([k, v]) => !same(m.tokens[k], v))
    if (off.length) throw new Error(`not the 6.2 table: ${off.map(([k, v]) => `${k} ${m.tokens[k]} want ${v}`).join(', ')}`)
    return `{argb:null} after #FF107C10 read the desktop again (${dwm.argb ?? 'none'}): the 6.2 table, ${Object.keys(SPEC_62).length} tokens match (accent ${m.tokens.accent}, frame ${m.tokens.frame}, body ${m.tokens.body}, frameText ${m.tokens.frameText})`
  }
  // The desktop is not #881798 right now: its own derivation, not 6.2's table.
  const m = await until(`the desktop accent ${desk} never came back`, 8000, (x) => same(x.tokens?.accent, desk))
  if (!same(m.tokens.frame, blend43(desk))) throw new Error(`frame ${m.tokens.frame} want ${blend43(desk)}`)
  return `{argb:null} after #FF107C10 read the desktop again: ${dwm.argb}, not #881798 at this moment, so its derivation (accent ${m.tokens.accent}, frame ${m.tokens.frame}), not the 6.2 table`
}

async function checkAccent() {
  await openSettings()
  await click('sheet:settings:accent:0a84ff')
  await until('the accent override never applied', 5000, (x) => same(x.tokens?.accent, '#0a84ff'))
  await color({ argb: '#FF0078D7' })
  // The colorization's frame proves it landed; the accent must not move.
  const m = await until('the blue colorization never landed', 8000, (x) => same(x.tokens?.frame, blend43('#FF0078D7')))
  const kept = m.tokens.accent
  const bad = []
  if (!same(kept, '#0a84ff')) bad.push(`accent ${kept} after the colorization, want #0a84ff`)
  if (!same(m.tokens.selection, '#0a84ff')) bad.push(`selection ${m.tokens.selection}`)
  await click('sheet:settings:accent:default')
  const d = await until('Theme default never restored the colorization accent', 5000, (x) => same(x.tokens?.accent, '#0078D7'))
  await closeSettings()
  if (bad.length) throw new Error(bad.join('; '))
  return `accent:0a84ff then colorization #FF0078D7: frame ${m.tokens.frame} (landed), accent still ${kept}, selection ${m.tokens.selection}; accent:default gave ${d.tokens.accent}, selection ${d.tokens.selection}`
}

async function checkSettingChange(pid) {
  // A known light start, then appsDark armed without a send: only a re-read
  // of the app theme (the ImmersiveColorSet path) can turn the strip dark.
  await color({ appsDark: false })
  await until('stripDark never 0', 5000, (x) => x.tokens?.stripDark === '0')
  const seqArm = (await M()).seq
  await color({ appsDark: true, send: false })
  await sleep(600)
  const armed = await M()
  if (armed.tokens.stripDark !== '0') throw new Error(`stripDark ${armed.tokens.stripDark} right after the armed override (it was sent)`)
  const steps = []
  for (const lparam of [null, 'Policy']) {
    const sent0 = sentCount()
    const r = await must(UD, { cmd: 'settingChange', lparam }, `settingChange ${lparam}`)
    await sleep(800)
    if (!pidAlive(pid)) throw new Error(`the shell is gone after settingChange ${JSON.stringify(lparam)}`)
    const x = await M()
    const sent = sentCount() - sent0
    if (x.tokens.stripDark !== '0' || sent !== 0) throw new Error(`settingChange ${JSON.stringify(lparam)}: stripDark ${x.tokens.stripDark}, ${sent} colorization sends`)
    steps.push(`${JSON.stringify(r.lparam)} stripDark 0, 0 sends, shell up`)
  }
  const sent0 = sentCount()
  await must(UD, { cmd: 'settingChange', lparam: 'ImmersiveColorSet' }, 'settingChange ImmersiveColorSet')
  const d = await until('ImmersiveColorSet never turned the strip dark', 5000, (x) => x.tokens?.stripDark === '1')
  const sent = sentCount() - sent0
  // Back to the registry's own app theme (read only).
  await color({ appsDark: null })
  if (sent !== 1) throw new Error(`ImmersiveColorSet made ${sent} colorization sends, want 1`)
  return `appsDark true armed unsent (seq ${seqArm} -> ${armed.seq}, stripDark 0); ${steps.join('; ')}; "ImmersiveColorSet" stripDark 1 (frame ${d.tokens.frame}), 1 send; appsDark back to the registry`
}

// The strip in a shot: the frame paint ends 138 DIP short of the right edge.
function stripPixels(file, t, W, H, scale) {
  const png = readPng(file)
  const y = Math.round((H * 0.75) * scale) // below the caption buttons, above the strip's bottom edge
  const edge = (W - CAPTION_DIP) * scale
  const inside = png.at(edge - 3 * scale, y)
  const right = [edge + 3 * scale, (W - CAPTION_DIP / 2) * scale, (W - 3) * scale].map((x) => png.at(x, y))
  const ok = near(inside, t.frame) && right.every((c) => !near(c, t.frame))
  return { ok, desc: `x ${Math.round(W - CAPTION_DIP - 3)} DIP ${inside} (frame ${t.frame}), x ${Math.round(W - CAPTION_DIP + 3)}/${Math.round(W - CAPTION_DIP / 2)}/${Math.round(W - 3)} DIP ${right.join('/')}` }
}

async function checkNoGlass() {
  await color({ argb: null })
  await color({ appsDark: false })
  await must(UD, { cmd: 'composition', on: false }, 'composition off')
  let m = await until('composition never 0', 5000, (x) => x.tokens?.composition === '0')
  const strip = await must(UD, { cmd: 'rect', target: 'strip:empty' }, 'rect strip:empty')
  const gear = await must(UD, { cmd: 'rect', target: 'settings' }, 'rect settings')
  const W = strip.w, H = m.window.tabStripH
  const out = []
  const bad = []
  for (const mode of ['light', 'dark']) {
    await setTabStrip(mode)
    m = await until(`stripDark never ${mode === 'dark' ? 1 : 0}`, 5000, (x) => x.tokens?.stripDark === (mode === 'dark' ? '1' : '0') && x.tokens?.composition === '0')
    const s = await shot(`P3-noglass-${mode}.png`)
    const png = readPng(s.linux)
    const scale = png.w / W
    const px = stripPixels(s.linux, m.tokens, W, H, scale)
    if (!px.ok) bad.push(`${mode}: ${px.desc}`)
    out.push(`${mode} composition ${m.tokens.composition} stripDark ${m.tokens.stripDark}, ${px.desc}, shot ${s.path}`)
  }
  const gearGap = W - (gear.x + gear.w)
  if (gearGap < CAPTION_DIP) bad.push(`the gear ends ${r2(gearGap)} DIP from the right edge`)
  await setTabStrip('system')
  await must(UD, { cmd: 'composition', on: true }, 'composition on')
  const back = await until('composition never back to 1', 5000, (x) => x.tokens?.composition === '1')
  if (bad.length) throw new Error(`${bad.join('; ')} (${out.join('; ')})`)
  return `strip:empty ${r2(W)}x${r2(H)} DIP, the frame paint stops at ${r2(W - CAPTION_DIP)} = client width minus ${CAPTION_DIP} DIP, the gear's right edge ${r2(gear.x + gear.w)} (${r2(gearGap)} DIP from the edge); ${out.join('; ')}; composition back on (${back.tokens.composition}), tab strip System`
}

async function checkDpi() {
  const m = await M()
  const strip = await must(UD, { cmd: 'rect', target: 'strip:empty' }, 'rect strip:empty')
  const file = toLocal(`${BAKEOFF}\\P3-noglass-light.png`)
  const scale = existsSync(file) ? r2(readPng(file).w / strip.w) : null
  return `note only: window.uiScale ${m.window.uiScale} on the second display (bounds 1028,-979; the shots ${scale === null ? 'not read' : `${scale} px per DIP`}); per-monitor DPI beyond 1x stays deferred (spec 12)`
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
    // A light strip whatever the desktop's app theme (the override, read only).
    await color({ appsDark: false })
    const checks = [
      ['1 blue', checkBlue],
      ['2 yellow', checkYellow],
      ['3 black', checkBlack],
      ['4 null', checkNull],
      ['5 accent', checkAccent],
      ['6 settingChange', () => checkSettingChange(pid)],
      ['7 noglass', checkNoGlass],
      ['8 dpi', checkDpi],
    ]
    for (const [label, fn] of checks) {
      try {
        console.log(`${label}: ok ${await fn()}`)
      } catch (e) {
        console.log(`${label}: fail ${e.message}`)
        failed++
      }
    }
  } catch (e) {
    console.log(`colors: fail ${e.message}`)
    failed++
  } finally {
    if (pid) {
      try {
        await drive(UD, { cmd: 'composition', on: true })
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
  process.exit(failed ? 1 : 0)
}

await main()
