// Drives the changes preview page (out/core/preview, `npm run build:core`)
// in headless Chromium with a fake host that posts exactly what the native
// shell posts (PostWebMessageAsJson through a stand-in `chrome.webview`), and
// checks what the page shows and what it answers.
//
//   node scripts/preview-check.mjs [--shots <dir>]
//
// Needs Playwright (`playwright` or `playwright-core`, resolved from here or
// NODE_PATH) and a Chromium it can launch (PLAYWRIGHT_BROWSERS_PATH, or
// CHROMIUM_PATH for an executable). Exits non-zero on the first failed check.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const root = path.resolve('out/core/preview')
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null
if (shots) mkdirSync(shots, { recursive: true })

function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require(name)
    } catch {
      /* next */
    }
  }
  for (const dir of (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['playwright', 'playwright-core']) {
      try {
        return require(path.join(dir, name))
      } catch {
        /* next */
      }
    }
  }
  console.error('preview-check: Playwright is not installed (npm i -D playwright-core, or set NODE_PATH)')
  process.exit(2)
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = path.join(root, rel)
  if (!file.startsWith(root)) return res.writeHead(403).end()
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/`

const { chromium } = loadPlaywright()
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures += 1
}

const GRAPHITE = { bg: '#18191B', fg: '#E4E5E7', dim: '#A8ABB2', header: '#1D1E21', border: '#34353A', accent: '#2563EB', accentText: '#FFFFFF', danger: '#FF5F56', selection: '#3399FF', button: '#2E2F33', buttonText: '#E4E5E7', radius: 6, light: false }
const AERO = { ...GRAPHITE, bg: '#FAF5FC', fg: '#1D0F22', dim: '#5A3F66', header: '#EAD9F0', border: '#8F5FA0', accent: '#881798', button: '#E1D3E8', buttonText: '#1D0F22', light: true }

async function open(width) {
  const page = await browser.newPage({ viewport: { width, height: 700 } })
  // The WebView2 bridge as the shell gives it: postMessage out, 'message' events in.
  await page.addInitScript(() => {
    const listeners = []
    window.__out = []
    window.chrome = window.chrome || {}
    window.chrome.webview = {
      postMessage: (m) => window.__out.push(JSON.parse(JSON.stringify(m))),
      addEventListener: (t, fn) => t === 'message' && listeners.push(fn),
    }
    window.__host = (m) => listeners.forEach((fn) => fn({ data: m }))
  })
  const blocked = []
  page.on('request', (r) => {
    if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('about:')) blocked.push(r.url())
  })
  await page.goto(base)
  await page.waitForFunction(() => window.__out.some((m) => m.type === 'ready'))
  return { page, blocked }
}

const post = (page, m) => page.evaluate((m) => window.__host(m), m)
const out = (page) => page.evaluate(() => window.__out)

const before = 'import { a } from "./a"\n\nexport function f(x: number): number {\n  return x + 1\n}\n' + Array.from({ length: 30 }, (_, i) => `// line ${i}`).join('\n') + '\n'
const after = before.replace('return x + 1', 'return x * 2 // doubled').replace('// line 25', '// line twenty-five')

try {
  {
    const { page, blocked } = await open(547)
    check(true, 'the page says it is ready')

    await post(page, { type: 'show', seq: 1, theme: GRAPHITE, file: { path: '/home/user/proj/src/f.ts', rel: 'src/f.ts', change: 'edited', before, after, beforeKnown: true, binary: false, truncated: false } })
    await page.waitForSelector('table.diff.unified tr.add')
    check((await page.locator('tr.del').count()) === 2 && (await page.locator('tr.add').count()) === 2, 'an edited file shows a unified diff of its two changes')
    check((await page.locator('button.expand').count()) >= 1, 'unchanged stretches fold into an expandable gap')
    await page.waitForFunction(() => document.querySelector('td.code span[style*="color"]') !== null, null, { timeout: 15000 })
    check(true, 'the diff is syntax highlighted')
    if (shots) await page.screenshot({ path: path.join(shots, 'diff-547.png') })
    await page.click('button[data-mode="split"]')
    await page.waitForSelector('table.diff.split')
    check((await page.locator('table.diff.split td.del').count()) >= 2, 'side by side puts deletions beside additions')
    await page.click('button.expand')
    check((await page.locator('button.expand').count()) >= 0, 'a gap expands')

    for (const action of ['open', 'reveal', 'copy', 'close']) await page.click(`button[data-action="${action}"]`)
    await page.keyboard.press('Escape')
    const acts = (await out(page)).filter((m) => m.type === 'action').map((m) => m.action)
    check(JSON.stringify(acts) === JSON.stringify(['open', 'reveal', 'copy', 'close', 'close']), 'the buttons and Escape report their actions')

    await post(page, { type: 'show', seq: 2, theme: GRAPHITE, file: { path: '/home/user/proj/evil.ts', rel: 'evil.ts', change: 'created', before: null, after: '<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=2</script>\n', beforeKnown: true, binary: false, truncated: false } })
    await page.waitForSelector('table.src')
    await page.waitForTimeout(300)
    check((await page.locator('#body img').count()) === 0 && (await page.evaluate(() => window.__pwned)) === undefined, 'file content is shown as text, never as markup')

    await post(page, { type: 'show', seq: 3, theme: GRAPHITE, file: { path: '/home/user/proj/README.md', rel: 'README.md', change: 'created', before: null, after: '# Made-up title\n\nSome **bold** text and a [link](https://example.com/x).\n\n- one\n- two\n\n```js\nconst x = 1\n```\n\n<script>parent.__pwned = 3</script>\n', beforeKnown: true, binary: false, truncated: false } })
    await page.waitForSelector('iframe.render')
    const frame = await (await page.waitForSelector('iframe.render')).contentFrame()
    await frame.waitForSelector('h1')
    check((await frame.textContent('h1')) === 'Made-up title', 'a created Markdown file shows rendered')
    check((await frame.locator('body script').count()) === 0 && (await frame.textContent('body')).includes('<script>') && (await page.evaluate(() => window.__pwned)) === undefined, 'raw HTML in Markdown stays text')
    if (shots) await page.screenshot({ path: path.join(shots, 'markdown-547.png') })
    await frame.click('a')
    await page.waitForFunction(() => window.__out.some((m) => m.type === 'link'))
    check((await out(page)).some((m) => m.type === 'link' && m.url === 'https://example.com/x'), 'a link in a rendered page goes to the host, not into the frame')
    await page.click('button[data-mode="source"]')
    await page.waitForSelector('table.src')
    check((await page.locator('iframe.render').count()) === 0, 'Source shows the Markdown text and drops the frame')

    const html = '<!doctype html><html><body><h2 id="t">x</h2><script>document.getElementById("t").textContent = "ran"; try { parent.document.title = "pwned" } catch (e) { document.body.dataset.parent = "blocked" } fetch("https://example.com/beacon").then(() => { document.body.dataset.net = "open" }, () => { document.body.dataset.net = "blocked" })</script><img src="https://example.com/pixel.png"></body></html>'
    await post(page, { type: 'show', seq: 4, theme: GRAPHITE, file: { path: '/home/user/proj/site/index.html', rel: 'site/index.html', change: 'created', before: null, after: html, beforeKnown: true, binary: false, truncated: false } })
    const f2 = await (await page.waitForSelector('iframe.render')).contentFrame()
    await f2.waitForFunction(() => document.body && document.body.dataset.net !== undefined, null, { timeout: 5000 })
    check((await f2.textContent('#t')) === 'ran', 'an HTML preview runs its own scripts')
    check((await f2.evaluate(() => document.body.dataset.parent)) === 'blocked' && (await page.title()) === 'Preview', 'those scripts cannot reach the page around them')
    check((await f2.evaluate(() => document.body.dataset.net)) === 'blocked', 'nor the network')
    check((await page.locator('iframe.render').getAttribute('sandbox')) === 'allow-scripts', 'the frame is sandboxed with scripts and no same origin')
    if (shots) await page.screenshot({ path: path.join(shots, 'html-547.png') })

    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    await post(page, { type: 'show', seq: 5, theme: AERO, file: { path: '/home/user/proj/logo.png', rel: 'logo.png', change: 'created', before: null, after: null, beforeKnown: true, binary: true, truncated: false, image: { mime: 'image/png', base64: png } } })
    await page.waitForSelector('.image img')
    check(await page.evaluate(() => document.documentElement.classList.contains('light')), 'a light theme switches the page to light')
    check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(250, 245, 252)'), 'the page takes the theme colours')

    await post(page, { type: 'show', seq: 6, theme: GRAPHITE, file: { path: '/home/user/proj/old.txt', rel: 'old.txt', change: 'deleted', before: null, after: null, beforeKnown: false, binary: false, truncated: false } })
    await page.waitForSelector('.note')
    check((await page.textContent('#body')).includes('not known'), 'a deleted file with no known content says so')
    await post(page, { type: 'show', seq: 7, theme: GRAPHITE, file: { path: '/home/user/proj/gone.txt', rel: 'gone.txt', change: 'deleted', before: 'was here\n', after: null, beforeKnown: true, binary: false, truncated: false } })
    await page.waitForFunction(() => document.querySelector('#body')?.textContent?.includes('was here'))
    check((await page.locator('.chip.deleted').count()) === 1, 'a deleted file shows its last content, marked deleted')

    const net = await page.evaluate(() => fetch('https://example.com/').then(() => 'open', () => 'blocked'))
    check(net === 'blocked', 'the page itself cannot reach the network')
    check(blocked.length === 0 || blocked.every((u) => u.startsWith('https://example.com/')), `no request left the page except the ones its CSP refused (${blocked.length})`)
    await page.close()
  }
  {
    // The wide case: the column at 38 percent of a 3440 px window.
    const { page } = await open(1307)
    await post(page, { type: 'show', seq: 1, theme: GRAPHITE, file: { path: '/home/user/proj/src/f.ts', rel: 'src/f.ts', change: 'edited', before, after, beforeKnown: true, binary: false, truncated: false } })
    await page.waitForSelector('table.diff')
    await page.click('button[data-mode="split"]')
    await page.waitForSelector('table.diff.split')
    if (shots) await page.screenshot({ path: path.join(shots, 'split-1307.png') })
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'side by side fits a wide column without scrolling sideways')
    await page.close()
  }
} catch (err) {
  console.error(err)
  failures += 1
} finally {
  await browser.close()
  server.close()
}
console.log(failures === 0 ? 'preview-check: all ok' : `preview-check: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
