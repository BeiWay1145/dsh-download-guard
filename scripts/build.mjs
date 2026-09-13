import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  bundle: true, format: 'esm', platform: 'node', target: 'node20',
  packages: 'external', logLevel: 'warning',
})
console.log('built lib/index.js')
