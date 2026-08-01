import { describe, expect, it } from 'vitest'
import { VIEWER_IMAGE_EXTENSIONS, decideRoute, VIEWER_MAX_BYTES, type RouteInput } from '../../src/main/fs/route.js'
import { denyOpenPath, isUnderDev, type OpenGuardInput } from '../../src/main/fs/path-guard.js'

type Over = Partial<Omit<RouteInput, 'resolvedPath'>> & { name: string; resolvedPath?: string }

function input(over: Over): RouteInput {
  const { name, ...rest } = over
  return {
    size: 1024,
    isDir: false,
    isExecutable: false,
    resolvedPath: `/repo/${name}`,
    ...rest,
  }
}

function guard(over: Partial<Omit<OpenGuardInput, 'resolvedPath'>> & { name: string; resolvedPath?: string }): OpenGuardInput {
  const { name, ...rest } = over
  return {
    isDir: false,
    isExecutable: false,
    resolvedPath: `/repo/${name}`,
    ...rest,
  }
}

describe('decideRoute — viewer extensions', () => {
  it('routes common text/code extensions to the viewer', () => {
    for (const name of ['a.txt', 'a.md', 'a.json', 'a.ts', 'a.tsx', 'a.py', 'a.sh', 'a.yaml', 'a.log']) {
      expect(decideRoute(input({ name }))).toBe('viewer')
    }
  })

  it('routes known extensionless basenames to the viewer', () => {
    for (const name of ['Makefile', 'Dockerfile', 'README', 'LICENSE', '.gitignore', '.zshrc']) {
      expect(decideRoute(input({ name }))).toBe('viewer')
    }
  })

  it('is case-insensitive on the extension', () => {
    expect(decideRoute(input({ name: 'A.TXT' }))).toBe('viewer')
    expect(decideRoute(input({ name: 'A.Md' }))).toBe('viewer')
  })
})

describe('decideRoute — size guard', () => {
  it('routes an over-limit viewer-eligible file to too-large', () => {
    const r = decideRoute(input({ name: 'huge.log', size: VIEWER_MAX_BYTES + 1 }))
    expect(r).toBe('too-large')
  })

  it('routes a file exactly at the limit to viewer, not too-large', () => {
    const r = decideRoute(input({ name: 'exact.log', size: VIEWER_MAX_BYTES }))
    expect(r).toBe('viewer')
  })

  it('does not apply the size guard to os-routed documents', () => {
    // .docx, not .pdf: PDFs preview in-pane now (PDFium streams, so they carry
    // no size gate either — asserted in the image/pdf routing suite below).
    const r = decideRoute(input({ name: 'huge.docx', size: VIEWER_MAX_BYTES * 10 }))
    expect(r).toBe('os')
  })

  it('applies the size guard to a sniffed-as-text extensionless file', () => {
    const r = decideRoute(input({ name: 'noext', size: VIEWER_MAX_BYTES + 1, sniff: 'text' }))
    expect(r).toBe('too-large')
  })
})

describe('decideRoute — extensionless sniffing', () => {
  it('routes a sniffed-text extensionless file to the viewer', () => {
    expect(decideRoute(input({ name: 'noext', sniff: 'text' }))).toBe('viewer')
  })

  it('routes a sniffed-binary extensionless file to binary', () => {
    expect(decideRoute(input({ name: 'noext', sniff: 'binary' }))).toBe('binary')
  })

  it('routes an un-sniffed extensionless file to binary by default', () => {
    expect(decideRoute(input({ name: 'noext' }))).toBe('binary')
  })
})

describe('decideRoute — default app fallback', () => {
  it('routes documents needing a heavy native app to os', () => {
    // pdf/png/jpg left this list when the in-pane preview took them over.
    for (const name of ['a.xlsx', 'a.docx', 'a.mp4', 'a.zip']) {
      expect(decideRoute(input({ name }))).toBe('os')
    }
  })

  it('routes an unrecognized extension to os (not viewer, not denied)', () => {
    expect(decideRoute(input({ name: 'a.weirdext' }))).toBe('os')
  })
})

describe('decideRoute — directories never reach OpenRoute', () => {
  it('conservatively refuses a directory rather than letting shell.openPath hit it', () => {
    // The real directory-routing behavior (spec §8.6: File explorer, never
    // Finder) happens client-side before this is ever consulted; this is
    // the defensive fallback if it somehow is.
    expect(decideRoute(input({ name: 'some-dir', isDir: true }))).toBe('reveal')
  })
})

describe('decideRoute — DENY routes to reveal, never openPath', () => {
  it('denies every bundle/script-wrapper extension in the DENY list', () => {
    const denied = [
      'x.app',
      'x.command',
      'x.workflow',
      'x.scpt',
      'x.scptd',
      'x.terminal',
      'x.webloc',
      'x.url',
      'x.inetloc',
      'x.desktop',
      'x.pkg',
      'x.mpkg',
      'x.dmg',
      'x.jar',
      'x.action',
      'x.prefPane',
      'x.qlgenerator',
      'x.saver',
      'x.plugin',
      'x.bundle',
      'x.osax',
      'x.kext',
      'x.appex',
    ]
    for (const name of denied) {
      expect(decideRoute(input({ name }))).toBe('reveal')
    }
  })

  it('denies DENY extensions case-insensitively', () => {
    expect(decideRoute(input({ name: 'pwn.COMMAND' }))).toBe('reveal')
    expect(decideRoute(input({ name: 'Evil.App' }))).toBe('reveal')
    expect(decideRoute(input({ name: 'Installer.DMG' }))).toBe('reveal')
  })

  it('denies a hostile-repo scenario: an attacker-named .command file gets revealed, never opened', () => {
    expect(decideRoute(input({ name: 'pwn.command', isExecutable: true }))).toBe('reveal')
  })

  it('denies any executable-bit file whose extension is not a known-safe viewer/document type', () => {
    expect(decideRoute(input({ name: 'mystery.bin', isExecutable: true }))).toBe('reveal')
    expect(decideRoute(input({ name: 'a.bin', isExecutable: true }))).toBe('reveal')
  })

  it('does NOT deny a viewer-extension file just because it is executable (e.g. a .sh script)', () => {
    expect(decideRoute(input({ name: 'build.sh', isExecutable: true }))).toBe('viewer')
  })

  it('does NOT deny a known document-extension file just because it is executable', () => {
    // Now routes to the in-pane viewer, which is *stricter* than the old 'os'
    // answer this asserted: the viewer reads bytes over IPC and never touches
    // LaunchServices, so the execute bit has nothing left to fire.
    expect(decideRoute(input({ name: 'photo.png', isExecutable: true }))).toBe('viewer')
    // The un-previewable equivalent keeps the original property.
    expect(decideRoute(input({ name: 'sheet.xlsx', isExecutable: true }))).toBe('os')
  })

  it('does not deny a non-executable file with an unrecognized extension', () => {
    expect(decideRoute(input({ name: 'mystery.weirdext', isExecutable: false }))).toBe('os')
  })

  it('denies an extensionless executable file (no recognized extension to carve it out)', () => {
    expect(decideRoute(input({ name: 'mystery', isExecutable: true }))).toBe('reveal')
  })

  it('denies FIFO, socket, character-device, and block-device nodes regardless of extension', () => {
    expect(decideRoute(input({ name: 'a.txt', specialType: 'fifo' }))).toBe('reveal')
    expect(decideRoute(input({ name: 'a.txt', specialType: 'socket' }))).toBe('reveal')
    expect(decideRoute(input({ name: 'a.txt', specialType: 'char-device' }))).toBe('reveal')
    expect(decideRoute(input({ name: 'a.txt', specialType: 'block-device' }))).toBe('reveal')
  })

  it('denies anything whose realpath resolves under /dev', () => {
    expect(decideRoute(input({ name: 'null', resolvedPath: '/dev/null' }))).toBe('reveal')
    expect(decideRoute(input({ name: 'dev', resolvedPath: '/dev' }))).toBe('reveal')
  })

  it('does not treat a look-alike path as under /dev', () => {
    expect(isUnderDev('/devious/x')).toBe(false)
    expect(isUnderDev('/private/dev/x')).toBe(false)
    expect(isUnderDev('/dev/x')).toBe(true)
  })
})

describe('denyOpenPath — direct unit coverage of the guard itself', () => {
  it('is the sole source of reveal decisions decideRoute defers to', () => {
    expect(denyOpenPath(guard({ name: 'a.command' }))).toBe(true)
    expect(denyOpenPath(guard({ name: 'a.txt' }))).toBe(false)
    expect(denyOpenPath(guard({ name: 'a.txt', isExecutable: true }))).toBe(false)
    expect(denyOpenPath(guard({ name: 'a.unknownext', isExecutable: true }))).toBe(true)
  })

  it('denies a directory unconditionally', () => {
    expect(denyOpenPath(guard({ name: 'a-directory', isDir: true }))).toBe(true)
  })
})

describe('image routing', () => {
  const base = { isDir: false, isExecutable: false }

  it('sends images to the in-pane preview', () => {
    for (const name of ['/a/shot.png', '/a/photo.JPG', '/a/anim.gif', '/a/pic.webp']) {
      expect(decideRoute({ ...base, resolvedPath: name, size: 500_000 })).toBe('viewer')
    }
  })

  it('hands an image past the read ceiling to the OS instead', () => {
    // Matches IMAGE_MAX_BYTES in ipc-router: past it readImageFile would
    // refuse anyway, so routing to the viewer would open a broken pane.
    expect(decideRoute({ ...base, resolvedPath: '/a/huge.png', size: 17 * 1024 * 1024 })).toBe('os')
  })

  it('never treats SVG as a renderable image', () => {
    // Script-bearing document. Whatever else happens to it, it must not reach
    // the data-URL image path.
    const route = decideRoute({ ...base, resolvedPath: '/a/logo.svg', size: 1000 })
    expect(['viewer', 'os']).toContain(route)
    // and if it is 'viewer', that is the TEXT viewer via VIEWER_EXTENSIONS,
    // which the image test above cannot reach — asserted structurally by the
    // image set not containing svg:
    expect(VIEWER_IMAGE_EXTENSIONS.has('.svg')).toBe(false)
  })

  it('previews pdf in-pane, office documents with the OS', () => {
    expect(decideRoute({ ...base, resolvedPath: '/a/doc.pdf', size: 1000 })).toBe('viewer')
    for (const name of ['/a/sheet.xlsx', '/a/word.docx']) {
      expect(decideRoute({ ...base, resolvedPath: name, size: 1000 })).toBe('os')
    }
  })
})
