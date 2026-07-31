import { describe, expect, it } from 'vitest'
import { normalizeUrl } from '../../src/renderer/panes/WebPreview.js'

/**
 * The scheme check is a security boundary, not a convenience: a web preview
 * guest that could be pointed at file:// would get read access to the disk,
 * and custom schemes reach OS handlers. Rejection must be by allowlist.
 */
describe('normalizeUrl', () => {
  it('accepts http and https unchanged', () => {
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeUrl('https://example.com/a/b?c=1')).toBe('https://example.com/a/b?c=1')
  })

  it('assumes http for a bare host, which is how dev servers are written', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
  })

  it('expands a bare :port, the form a dev server actually prints', () => {
    expect(normalizeUrl(':3000')).toBe('http://localhost:3000/')
    expect(normalizeUrl(':8080')).toBe('http://localhost:8080/')
  })

  it('rejects every non-http scheme', () => {
    expect(normalizeUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(normalizeUrl('app://seashell/index.html')).toBeNull()
    expect(normalizeUrl('chrome://settings')).toBeNull()
  })

  it('rejects empty and whitespace-only input', () => {
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
  })

  it('trims surrounding whitespace from a pasted address', () => {
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com/')
  })
})
