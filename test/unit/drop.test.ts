import { describe, expect, it } from 'vitest'
import { dropText, shellQuote, windowsToWsl } from '../../src/renderer/panes/drop'

describe('file drop text', () => {
  it('quotes paths with spaces and quotes', () => {
    expect(shellQuote('/home/j/a.txt')).toBe('/home/j/a.txt')
    expect(shellQuote("/home/j/Zoe's file.pdf")).toBe(`'/home/j/Zoe'\\''s file.pdf'`)
  })
  it('maps Windows paths to WSL form wherever panes are WSL shells', () => {
    expect(windowsToWsl('C:\\Users\\josh\\a b.pdf', 'linux')).toBe('/mnt/c/Users/josh/a b.pdf')
    expect(windowsToWsl('C:\\x', 'win32')).toBe('/mnt/c/x')
    expect(windowsToWsl('C:\\x', 'darwin')).toBe('C:\\x')
    expect(windowsToWsl('/home/j/x', 'win32')).toBe('/home/j/x')
  })

  it('maps WSL share paths back to the Linux path, and leaves other shares alone', () => {
    expect(windowsToWsl('\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\x', 'win32')).toBe('/Users/joshwald/x')
    expect(windowsToWsl('\\\\wsl$\\Ubuntu-24.04\\tmp\\y', 'linux')).toBe('/tmp/y')
    expect(windowsToWsl('\\\\server\\share\\z', 'win32')).toBe('\\\\server\\share\\z')
  })

  it('pastes Explorer files, copied paths and the clipboard image as WSL paths on win32', () => {
    // A file dragged or copied from Explorer, and "Copy as path".
    expect(dropText({ paths: ['C:\\Users\\josh\\Downloads\\plan.pdf'] }, 'win32')).toBe('/mnt/c/Users/josh/Downloads/plan.pdf ')
    // Explorer's Linux view hands over the share path.
    expect(dropText({ paths: ['\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\a b'] }, 'win32')).toBe("'/Users/joshwald/a b' ")
    // The PNG saved under the Windows temp directory for a pasted screenshot.
    expect(
      dropText({ paths: ['C:\\Users\\josh\\AppData\\Local\\Temp\\seashell-paste-user\\clipboard-1.png'] }, 'win32')
    ).toBe('/mnt/c/Users/josh/AppData/Local/Temp/seashell-paste-user/clipboard-1.png ')
    // A share path dropped as plain text.
    expect(dropText({ paths: [], text: '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\q' }, 'win32')).toBe('/tmp/q ')
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
