import { describe, expect, it } from 'vitest'
import { pluginInstalledInManifest } from '../../src/main/lookout/plugin-detect.js'

const manifest = (plugins: Record<string, unknown>): string =>
  JSON.stringify({ version: 2, plugins })

describe('pluginInstalledInManifest', () => {
  it('recognizes the standalone c-assistant install', () => {
    expect(
      pluginInstalledInManifest(manifest({ 'c-assistant@voidharbor': [{ version: '1.2.1' }] }))
    ).toBe(true)
  })
  it('recognizes the voidharbor bundle install — one install is enough', () => {
    expect(
      pluginInstalledInManifest(manifest({ 'voidharbor@voidharbor': [{ version: '1.1.0' }] }))
    ).toBe(true)
  })
  it('an empty install record is not an install', () => {
    expect(pluginInstalledInManifest(manifest({ 'c-assistant@voidharbor': [] }))).toBe(false)
  })
  it('other plugins alone are not it', () => {
    expect(pluginInstalledInManifest(manifest({ 'remotion@remotion': [{}] }))).toBe(false)
  })
  it('garbage input reads as absent', () => {
    expect(pluginInstalledInManifest('not json')).toBe(false)
  })
})
