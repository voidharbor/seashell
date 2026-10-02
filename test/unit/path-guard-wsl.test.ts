import { describe, expect, it } from 'vitest'
import { denyOpenPath } from '../../src/main/fs/path-guard.js'

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
