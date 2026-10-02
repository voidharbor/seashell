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
  define: { 'process.env.SEASHELL_CORE_VERSION': JSON.stringify(version) },
  sourcemap: false,
  logLevel: 'info',
})
mkdirSync('out/core', { recursive: true })
writeFileSync('out/core/VERSION', version + '\n')
console.log(`built out/core/index.cjs (${version})`)
