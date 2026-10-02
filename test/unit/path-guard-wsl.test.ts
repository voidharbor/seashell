import { describe, expect, it } from 'vitest'
import { denyOpenPath, denyShellOpenOnWindows } from '../../src/main/fs/path-guard.js'

/**
 * On WSL, Windows drives are mounted as drvfs with no metadata, so every file
 * under /mnt/c reports the execute bit (`-r-xr-xr-x` on win.ini). The guard's
 * "exec bit + unrecognised extension = deny" rule then refused ordinary
 * documents with "That file is executable". The exec bit tells nothing there,
 * so what is safe has to be known by type, and Windows programs have to be
 * denied by type too.
 */
const onC = (name: string) => ({ resolvedPath: `/mnt/c/Users/j/Documents/${name}`, isDir: false, isExecutable: true })

describe('documents on a Windows drive open in their app', () => {
  for (const name of ['report.doc', 'sheet.xls', 'deck.ppt', 'notes.odt', 'photo.webp', 'scan.bmp', 'favicon.ico', 'song.wav', 'clip.mkv', 'clip.webm', 'backup.7z', 'backup.rar', 'mail.eml', 'plan.dwg', 'letter.rtf']) {
    it(name, () => expect(denyOpenPath(onC(name))).toBe(false))
  }
})

describe('Windows programs are never handed to the default app', () => {
  for (const name of ['setup.exe', 'run.bat', 'run.cmd', 'tool.com', 'installer.msi', 'script.ps1', 'script.vbs', 'app.hta', 'job.wsf', 'saver.scr', 'shortcut.lnk', 'tweak.reg', 'panel.cpl']) {
    it(name, () => {
      expect(denyOpenPath(onC(name))).toBe(true)
      // even where the file system reports no exec bit at all
      expect(denyOpenPath({ ...onC(name), isExecutable: false })).toBe(true)
    })
  }
})

/**
 * The Windows build hands the guard either form of the same file: the Windows
 * form it opened (`C:\...`, `\\wsl.localhost\<distro>\...`) or the Linux form
 * the renderer sent. The verdict has to be the same through both.
 */
describe('the verdict is the same through either path form', () => {
  const forms = (name: string) => [
    `/mnt/c/Users/j/Downloads/${name}`,
    `C:\\Users\\j\\Downloads\\${name}`,
    `c:/Users/j/Downloads/${name}`,
    `/Users/joshwald/${name}`,
    `\\\\wsl.localhost\\Ubuntu-24.04\\Users\\joshwald\\${name}`,
    `\\\\wsl$\\Ubuntu-24.04\\Users\\joshwald\\${name}`,
  ]
  for (const name of ['setup.exe', 'run.bat', 'run.cmd', 'script.ps1', 'installer.msi', 'shortcut.lnk', 'SETUP.EXE', 'My Setup.Exe', 'caf\u00e9.lnk']) {
    for (const p of forms(name)) {
      it(`denies ${p}`, () => {
        expect(denyOpenPath({ resolvedPath: p, isDir: false, isExecutable: true })).toBe(true)
        expect(denyOpenPath({ resolvedPath: p, isDir: false, isExecutable: false })).toBe(true)
      })
    }
  }
  for (const name of ['report.docx', 'notes.txt', 'photo.png', 'plan.pdf']) {
    for (const p of forms(name)) {
      it(`allows ${p} even with the drive's exec bit`, () => {
        expect(denyOpenPath({ resolvedPath: p, isDir: false, isExecutable: true })).toBe(false)
      })
    }
  }
  it('an unknown type with the exec bit stays denied in Windows form too', () => {
    expect(denyOpenPath({ resolvedPath: 'C:\\x\\payload', isDir: false, isExecutable: true })).toBe(true)
    expect(denyOpenPath({ resolvedPath: 'C:\\x\\payload.weird', isDir: false, isExecutable: true })).toBe(true)
  })
  it('/dev is /dev through the distro share', () => {
    expect(denyOpenPath({ resolvedPath: '\\\\wsl.localhost\\Ubuntu-24.04\\dev\\sda.txt', isDir: false, isExecutable: false })).toBe(true)
  })
  it('names Windows would open under a different name are refused', () => {
    for (const name of ['evil.exe.', 'evil.exe ', 'evil.exe. .', 'notes.txt.', 'run.js ']) {
      expect(denyOpenPath({ resolvedPath: `C:\\x\\${name}`, isDir: false, isExecutable: false })).toBe(true)
      expect(denyOpenPath({ resolvedPath: `/Users/joshwald/${name}`, isDir: false, isExecutable: false })).toBe(true)
    }
  })
})

describe('script-host types are never shell-opened on Windows', () => {
  it('.js / .ws / .vb in either form', () => {
    for (const p of ['C:\\x\\a.js', '/mnt/c/x/a.JS', '\\\\wsl.localhost\\Ubuntu-24.04\\a.ws', '/Users/j/a.vb']) {
      expect(denyShellOpenOnWindows(p)).toBe(true)
    }
  })
  it('but stay viewable everywhere', () => {
    expect(denyOpenPath({ resolvedPath: '/Users/j/app.js', isDir: false, isExecutable: false })).toBe(false)
    expect(denyShellOpenOnWindows('C:\\x\\report.docx')).toBe(false)
  })
})
