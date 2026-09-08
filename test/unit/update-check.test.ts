import { describe, expect, it } from 'vitest'
import { isNewer, parseRelease, RELEASE_ORIGIN } from '../../src/main/update/check.js'

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.6.0',
  html_url: 'https://github.com/voidharbor/seashell/releases/tag/v0.6.0',
  assets: [
    { name: 'SeaShell-0.6.0-universal.dmg', size: 10, browser_download_url: `${RELEASE_ORIGIN}v0.6.0/SeaShell-0.6.0-universal.dmg` },
    { name: 'SeaShell-0.6.0-universal.zip', size: 20, browser_download_url: `${RELEASE_ORIGIN}v0.6.0/SeaShell-0.6.0-universal.zip` },
  ],
  ...over,
})

describe('parseRelease', () => {
  it('picks the universal zip', () => {
    expect(parseRelease(release())).toEqual({
      version: '0.6.0',
      zipUrl: `${RELEASE_ORIGIN}v0.6.0/SeaShell-0.6.0-universal.zip`,
      zipBytes: 20,
      pageUrl: 'https://github.com/voidharbor/seashell/releases/tag/v0.6.0',
    })
  })
  it('refuses a zip from any other origin', () => {
    const r = release()
    ;(r.assets[1] as { browser_download_url: string }).browser_download_url = 'https://evil.example/SeaShell-0.6.0-universal.zip'
    expect(parseRelease(r)).toBeNull()
  })
  it('refuses a malformed tag or missing zip', () => {
    expect(parseRelease(release({ tag_name: 'latest' }))).toBeNull()
    expect(parseRelease(release({ assets: [] }))).toBeNull()
    expect(parseRelease(null)).toBeNull()
  })
})

describe('isNewer', () => {
  it('compares numerically', () => {
    expect(isNewer('0.6.0', '0.5.0')).toBe(true)
    expect(isNewer('0.5.10', '0.5.9')).toBe(true)
    expect(isNewer('0.5.0', '0.5.0')).toBe(false)
    expect(isNewer('0.4.9', '0.5.0')).toBe(false)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
  })
  it('never trusts garbage', () => {
    expect(isNewer('x.y.z', '0.5.0')).toBe(false)
    expect(isNewer('0.6.0', 'dev')).toBe(false)
  })
})
