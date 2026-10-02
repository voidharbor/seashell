// Bundles the core for WSL's node. node-pty stays external (native module, staged beside the bundle).
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const version = require('../package.json').version

await build({
  entryPoints: ['src/core/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'out/core/index.cjs',
  external: ['node-pty'],
  alias: { electron: './src/core/electron-shim-default.ts' },
  // src/main/index.ts reads import.meta.url at the top level; cjs has no import.meta, so
  // it becomes the bundle's own file URL.
  define: { 'process.env.SEASHELL_CORE_VERSION': JSON.stringify(version), 'import.meta.url': '__seashellImportMetaUrl' },
  banner: { js: "const __seashellImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  sourcemap: false,
  logLevel: 'info',
})
mkdirSync('out/core', { recursive: true })
writeFileSync('out/core/VERSION', version + '\n')
console.log(`built out/core/index.cjs (${version})`)
