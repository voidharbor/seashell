import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * An image on the clipboard, saved as a PNG so it can be pasted as a path.
 *
 * A terminal can only paste text, and Claude Code turns a pasted path to an
 * image into an attachment, so a file on disk is how a screenshot reaches it
 * through SeaShell's own paste. Claude's Ctrl+V fetches the clipboard itself,
 * but that is a separate route, and this one also leaves a usable path in a
 * plain shell.
 *
 * Two sources, first hit wins: the Linux clipboard, which is the whole story on
 * a Linux desktop, and then Windows itself for WSL, where WSLg bridges clipboard
 * text but not images.
 */
export interface ClipboardImageDeps {
  /** PNG bytes from the Linux clipboard, or null. */
  readLinux(): Buffer | null
  /** PNG bytes from the Windows clipboard, or null. Only asked under WSL. */
  readWindows(): Promise<Buffer | null>
  dir: string
  now(): number
}

/** Pasted images older than this are cleared out on the next paste. */
export const KEEP_MS = 24 * 60 * 60 * 1000

export async function saveClipboardImage(deps: ClipboardImageDeps): Promise<string> {
  const png = deps.readLinux() ?? (await deps.readWindows())
  if (!png || png.length === 0) return ''
  await fs.mkdir(deps.dir, { recursive: true, mode: 0o700 })
  await prune(deps.dir, deps.now())
  const file = path.join(deps.dir, `clipboard-${deps.now()}.png`)
  await fs.writeFile(file, png, { mode: 0o600 })
  return file
}

async function prune(dir: string, now: number): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((n) => /^clipboard-\d+\.png$/.test(n))
      .map(async (n) => {
        const p = path.join(dir, n)
        try {
          if (now - (await fs.stat(p)).mtimeMs > KEEP_MS) await fs.unlink(p)
        } catch {
          /* gone already */
        }
      })
  )
}

/** PowerShell that prints the clipboard image as base64 PNG, or exits 1. */
export const WINDOWS_IMAGE_SCRIPT =
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
  '$i = [System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $i) { exit 1 }; ' +
  '$ms = New-Object System.IO.MemoryStream; $i.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); ' +
  '[Convert]::ToBase64String($ms.ToArray())'

/** Base64 as PowerShell prints it (CRLF, maybe wrapped) to bytes; null if empty. */
export function decodeBase64Output(stdout: string): Buffer | null {
  const b64 = stdout.replace(/\s+/g, '')
  if (!b64) return null
  const buf = Buffer.from(b64, 'base64')
  return buf.length > 0 ? buf : null
}
