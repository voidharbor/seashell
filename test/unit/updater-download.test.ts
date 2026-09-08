import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RELEASE_ORIGIN } from '../../src/main/update/check.js'
import { Updater, type UpdaterDeps } from '../../src/main/update/updater.js'
import type { UpdateState } from '../../src/shared/ipc.js'

/**
 * The download half of the updater, with `fetch` injected. Nothing here talks
 * to GitHub or to Electron: the fake below answers the release JSON and then
 * the zip bytes, and the state the banner would show is read off `send`.
 */

const VERSION = '9.9.9'
const ZIP_URL = `${RELEASE_ORIGIN}v${VERSION}/SeaShell-${VERSION}-universal.zip`

const releaseJson = (size: number): unknown => ({
  tag_name: `v${VERSION}`,
  html_url: `https://github.com/voidharbor/seashell/releases/tag/v${VERSION}`,
  assets: [{ name: `SeaShell-${VERSION}-universal.zip`, size, browser_download_url: ZIP_URL }],
})

const jsonResponse = (value: unknown): Response =>
  ({ ok: true, status: 200, json: async () => value }) as unknown as Response

const bodyResponse = (chunks: Uint8Array[]): Response =>
  ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk)
        c.close()
      },
    }),
  }) as unknown as Response

/** A body that stays open until the test lets it finish. */
function heldBody(): { res: Response; push: (b: Uint8Array) => void; end: () => void } {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
    },
  })
  return {
    res: { ok: true, status: 200, body } as unknown as Response,
    push: (b) => ctl.enqueue(b),
    end: () => ctl.close(),
  }
}

let dir = ''
let states: UpdateState[] = []
let zipCalls = 0

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seashell-up-'))
  states = []
  zipCalls = 0
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function makeUpdater(
  advertisedBytes: number,
  zip: () => Response
): { updater: Updater; target: string } {
  const deps: UpdaterDeps = {
    currentVersion: '0.0.1',
    isPackaged: true,
    exePath: '/Applications/SeaShell.app/Contents/MacOS/SeaShell',
    userData: dir,
    platform: 'darwin',
    send: (s) => {
      states.push(s)
    },
    pid: 4242,
    quit: () => {},
    fetch: async (url: string): Promise<Response> => {
      if (url === ZIP_URL) {
        zipCalls += 1
        return zip()
      }
      return jsonResponse(releaseJson(advertisedBytes))
    },
  }
  return {
    updater: new Updater(deps),
    target: path.join(dir, 'updates', `SeaShell-${VERSION}-universal.zip`),
  }
}

const last = (): UpdateState => states[states.length - 1]!
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('Updater.download', () => {
  it('writes the zip and goes ready when the size matches', async () => {
    const bytes = new Uint8Array(64).fill(7)
    const { updater, target } = makeUpdater(bytes.byteLength, () => bodyResponse([bytes]))
    await updater.start()
    expect(last().phase).toBe('available')
    await updater.download()
    expect(last()).toEqual({ phase: 'ready', version: VERSION })
    expect((await fs.stat(target)).size).toBe(bytes.byteLength)
  })

  it('reports the download as errored and removes a short file', async () => {
    // The advertised size is the only integrity check there is without a
    // signing key, so a truncated download must not be left installable.
    const { updater, target } = makeUpdater(1024, () => bodyResponse([new Uint8Array(8)]))
    await updater.start()
    await updater.download()
    const state = last()
    expect(state.phase).toBe('error')
    expect(state.phase === 'error' && state.message).toContain('size mismatch')
    await expect(fs.stat(target)).rejects.toThrow()
  })

  it('may be started again from error', async () => {
    const good = new Uint8Array(32).fill(1)
    let short = true
    const { updater, target } = makeUpdater(good.byteLength, () =>
      bodyResponse([short ? new Uint8Array(4) : good])
    )
    await updater.start()
    await updater.download()
    expect(last().phase).toBe('error')
    short = false
    await updater.download()
    expect(last()).toEqual({ phase: 'ready', version: VERSION })
    expect((await fs.stat(target)).size).toBe(good.byteLength)
    expect(zipCalls).toBe(2)
  })

  it('ignores a second click while a download is in flight', async () => {
    const held = heldBody()
    const { updater } = makeUpdater(16, () => held.res)
    await updater.start()
    const first = updater.download()
    await tick()
    await updater.download()
    expect(zipCalls).toBe(1)
    held.push(new Uint8Array(16))
    held.end()
    await first
    expect(last().phase).toBe('ready')
  })

  it('does not send a state for every chunk', async () => {
    // 1,000 one-byte chunks are 1,000 renderer messages if nothing throttles
    // them, and each one re-renders the whole app.
    const chunks = Array.from({ length: 1000 }, () => new Uint8Array(1))
    const { updater } = makeUpdater(1000, () => bodyResponse(chunks))
    await updater.start()
    await updater.download()
    const downloading = states.filter((s) => s.phase === 'downloading')
    expect(downloading.length).toBeLessThanOrEqual(102)
    expect(downloading.length).toBeGreaterThan(1)
    expect(last().phase).toBe('ready')
  })
})
