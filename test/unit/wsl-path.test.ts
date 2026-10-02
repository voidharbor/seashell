import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WSL_DISTRO,
  isLinuxPath,
  isWindowsPath,
  linuxToUnc,
  linuxToWindows,
  mntToWindows,
  uncToLinux,
  windowsToLinux,
  windowsToMnt,
  wslDistro,
} from '../../src/shared/wsl-path.js'
import { fromHostPath, toHostPath } from '../../src/main/fs/host-path.js'

const D = 'Ubuntu-24.04'

describe('linuxToUnc / uncToLinux', () => {
  it('maps a home path onto the distro share', () => {
    expect(linuxToUnc(D, '/Users/joshwald/x')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\x')
  })
  it('maps the root', () => {
    expect(linuxToUnc(D, '/')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\')
  })
  it('drops trailing and duplicate slashes', () => {
    expect(linuxToUnc(D, '/Users//joshwald/')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald')
  })
  it('normalizes dot segments before mapping, clamped at the root', () => {
    expect(linuxToUnc(D, '/Users/./joshwald/../../../etc/passwd')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\etc\\passwd')
  })
  it('keeps spaces and unicode intact', () => {
    const p = '/Users/joshwald/My Docs/caf\u00e9 \u2603/r\u00e9sum\u00e9 1.pdf'
    const unc = linuxToUnc(D, p)
    expect(unc).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\My Docs\\caf\u00e9 \u2603\\r\u00e9sum\u00e9 1.pdf')
    expect(uncToLinux(unc)).toEqual({ distro: D, path: p })
  })
  it('round-trips', () => {
    for (const p of ['/', '/Users/joshwald', '/Users/joshwald/Desktop/seashell/package.json', '/etc/hosts']) {
      expect(uncToLinux(linuxToUnc(D, p))?.path).toBe(p)
    }
  })
  it('reads the wsl$ alias, forward slashes, any host case and a \\\\?\\UNC prefix', () => {
    expect(uncToLinux('\\\\wsl$\\Ubuntu-24.04\\Users\\joshwald')?.path).toBe('/Users/joshwald')
    expect(uncToLinux('//wsl.localhost/Ubuntu-24.04/Users/joshwald/')?.path).toBe('/Users/joshwald')
    expect(uncToLinux('\\\\WSL.LOCALHOST\\Ubuntu-24.04\\tmp')?.path).toBe('/tmp')
    expect(uncToLinux('\\\\?\\UNC\\wsl.localhost\\Ubuntu-24.04\\tmp\\a')?.path).toBe('/tmp/a')
    expect(uncToLinux('\\\\wsl.localhost\\Ubuntu-24.04')).toEqual({ distro: D, path: '/' })
  })
  it('refuses every other path', () => {
    expect(uncToLinux('\\\\server\\share\\x')).toBeNull()
    expect(uncToLinux('C:\\Users\\josh')).toBeNull()
    expect(uncToLinux('/Users/joshwald')).toBeNull()
  })
})

describe('mntToWindows / windowsToMnt', () => {
  it('maps any drive letter', () => {
    expect(mntToWindows('/mnt/c/Users/josh/x')).toBe('C:\\Users\\josh\\x')
    expect(mntToWindows('/mnt/d/data')).toBe('D:\\data')
    expect(mntToWindows('/mnt/z')).toBe('Z:\\')
    expect(mntToWindows('/mnt/c/')).toBe('C:\\')
  })
  it('keeps spaces and unicode', () => {
    expect(mntToWindows('/mnt/c/Program Files/\u00e9t\u00e9/a b.txt')).toBe('C:\\Program Files\\\u00e9t\u00e9\\a b.txt')
  })
  it('leaves non-drive mounts and other paths to the distro', () => {
    expect(mntToWindows('/mnt/wsl/x')).toBeNull()
    expect(mntToWindows('/mnt/cdrom')).toBeNull()
    expect(mntToWindows('/mnt')).toBeNull()
    expect(mntToWindows('/Users/joshwald')).toBeNull()
    expect(mntToWindows('C:\\x')).toBeNull()
  })
  it('cannot climb out of the drive with ..', () => {
    expect(mntToWindows('/mnt/c/../../etc')).toBeNull()
    expect(linuxToWindows('/mnt/c/../../etc', D)).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\etc')
    expect(mntToWindows('/mnt/c/Users/../Windows')).toBe('C:\\Windows')
  })
  it('reverses, either separator, lowercasing the letter', () => {
    expect(windowsToMnt('C:\\Users\\josh\\x')).toBe('/mnt/c/Users/josh/x')
    expect(windowsToMnt('d:/data/')).toBe('/mnt/d/data')
    expect(windowsToMnt('C:\\')).toBe('/mnt/c')
    expect(windowsToMnt('C:')).toBe('/mnt/c')
    expect(windowsToMnt('/mnt/c/x')).toBeNull()
    expect(windowsToMnt('\\\\wsl.localhost\\U\\x')).toBeNull()
  })
  it('round-trips', () => {
    for (const p of ['/mnt/c', '/mnt/c/Users/josh/My File.txt', '/mnt/e/\u65e5\u672c/x']) {
      expect(windowsToMnt(mntToWindows(p)!)).toBe(p)
    }
  })
})

describe('shape tests', () => {
  it('isLinuxPath', () => {
    expect(isLinuxPath('/Users/joshwald')).toBe(true)
    expect(isLinuxPath('/')).toBe(true)
    expect(isLinuxPath('//wsl.localhost/U/x')).toBe(false)
    expect(isLinuxPath('C:\\x')).toBe(false)
    expect(isLinuxPath('relative/x')).toBe(false)
    expect(isLinuxPath('~/x')).toBe(false)
  })
  it('isWindowsPath', () => {
    expect(isWindowsPath('C:\\x')).toBe(true)
    expect(isWindowsPath('c:/x')).toBe(true)
    expect(isWindowsPath('\\\\wsl.localhost\\U\\x')).toBe(true)
    expect(isWindowsPath('/Users/x')).toBe(false)
  })
})

describe('linuxToWindows / windowsToLinux', () => {
  it('drive mounts go to the letter, everything else to the share', () => {
    expect(linuxToWindows('/mnt/c/Users/josh', D)).toBe('C:\\Users\\josh')
    expect(linuxToWindows('/Users/joshwald', D)).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald')
  })
  it('leaves a path that is already Windows-shaped, or relative, alone', () => {
    expect(linuxToWindows('C:\\Users\\josh', D)).toBe('C:\\Users\\josh')
    expect(linuxToWindows('\\\\wsl.localhost\\Ubuntu-24.04\\x', D)).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\x')
    expect(linuxToWindows('src/app.tsx', D)).toBe('src/app.tsx')
  })
  it('reverses both forms and passes the rest through', () => {
    expect(windowsToLinux('C:\\Users\\josh')).toBe('/mnt/c/Users/josh')
    expect(windowsToLinux('\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald')).toBe('/Users/joshwald')
    expect(windowsToLinux('/Users/joshwald')).toBe('/Users/joshwald')
    expect(windowsToLinux('\\\\server\\share\\x')).toBe('\\\\server\\share\\x')
  })
})

describe('wslDistro', () => {
  it('falls back to the build distro', () => {
    expect(wslDistro({})).toBe(DEFAULT_WSL_DISTRO)
    expect(DEFAULT_WSL_DISTRO).toBe('Ubuntu-24.04')
  })
  it('takes SEASHELL_WSL_DISTRO', () => {
    expect(wslDistro({ SEASHELL_WSL_DISTRO: 'Debian' })).toBe('Debian')
  })
  it('ignores a value that is not one path segment', () => {
    expect(wslDistro({ SEASHELL_WSL_DISTRO: '..\\..\\x' })).toBe(DEFAULT_WSL_DISTRO)
    expect(wslDistro({ SEASHELL_WSL_DISTRO: '  ' })).toBe(DEFAULT_WSL_DISTRO)
  })
})

describe('host-path seam', () => {
  it('is the identity off Windows', () => {
    expect(toHostPath('/Users/joshwald', 'linux', D)).toBe('/Users/joshwald')
    expect(toHostPath('/mnt/c/x', 'darwin', D)).toBe('/mnt/c/x')
    expect(fromHostPath('C:\\x', 'linux')).toBe('C:\\x')
  })
  it('translates both ways on win32', () => {
    expect(toHostPath('/Users/joshwald', 'win32', D)).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald')
    expect(toHostPath('/mnt/c/x', 'win32', D)).toBe('C:\\x')
    expect(fromHostPath('\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald', 'win32')).toBe('/Users/joshwald')
    expect(fromHostPath('C:\\x', 'win32')).toBe('/mnt/c/x')
  })
})
