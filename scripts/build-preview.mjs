// Bundles the changes preview page (src/preview) into a folder of its own:
// out/core/preview for the native shell (scripts/build-core.mjs calls this),
// out/renderer/preview for the Electron window (`npm run build`). ES modules
// split by language, so a file only loads the grammar it needs.
//
//   node scripts/build-preview.mjs <outdir>
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function buildPreview(outdir) {
  rmSync(outdir, { recursive: true, force: true })
  mkdirSync(outdir, { recursive: true })
  await build({
    entryPoints: { preview: 'src/preview/main.ts' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outdir,
    chunkNames: 'chunks/[name]-[hash]',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  })
  for (const f of ['index.html', 'render.html', 'preview.css']) copyFileSync(path.join('src/preview', f), path.join(outdir, f))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: node scripts/build-preview.mjs <outdir>')
    process.exit(2)
  }
  await buildPreview(out)
  console.log(`built ${out}`)
}
