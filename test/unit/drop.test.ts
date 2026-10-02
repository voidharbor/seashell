import { describe, expect, it } from 'vitest'
import { dropText, shellQuote, windowsToWsl } from '../../src/renderer/panes/drop'

describe('file drop text', () => {
  it('quotes paths with spaces and quotes', () => {
    expect(shellQuote('/home/j/a.txt')).toBe('/home/j/a.txt')
    expect(shellQuote("/home/j/Zoe's file.pdf")).toBe(`'/home/j/Zoe'\\''s file.pdf'`)
  })
  it('maps Windows paths to /mnt on linux only', () => {
    expect(windowsToWsl('C:\\Users\\josh\\a b.pdf', 'linux')).toBe('/mnt/c/Users/josh/a b.pdf')
    expect(windowsToWsl('C:\\x', 'win32')).toBe('C:\\x')
  })
  it('uses File paths first, joined with a trailing space', () => {
    expect(dropText({ paths: ['/a', '/b c'] }, 'linux')).toBe("/a '/b c' ")
  })
  it('falls back to a file:// uri-list', () => {
    expect(dropText({ paths: [], uriList: 'file:///home/j/x%20y.png\r\nfile:///C:/Users/josh/z.txt' }, 'linux'))
      .toBe("'/home/j/x y.png' /mnt/c/Users/josh/z.txt ")
  })
  it('accepts plain-text paths but ignores ordinary text', () => {
    expect(dropText({ paths: [], text: 'C:\\Users\\josh\\Desktop\\q.xlsx' }, 'linux')).toBe('/mnt/c/Users/josh/Desktop/q.xlsx ')
    expect(dropText({ paths: [], text: 'hello world' }, 'linux')).toBe('')
  })
})
