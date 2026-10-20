// Implemented by Codex (LLM agent): build the shared Node routing transport.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
await build({
  entryPoints: ['scripts/route-literature.ts'],
  outfile: 'dist/literature-router.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  banner: {
    js: '// Built by Codex (LLM agent) from shared literature routing sources.'
  }
})
copyFileSync(
  'node_modules/libavoid-js/dist/libavoid.wasm',
  'dist/libavoid.wasm'
)
copyFileSync('node_modules/libavoid-js/LICENSE', 'dist/libavoid-LICENSE')
// Added by Codex (LLM agent): Python and browser use the same ordered palette.
copyFileSync('src/literature-navigation/relation-style.json', 'dist/relation-style.json')

await build({
  entryPoints: ['src/literature-routing/worker.ts'],
  outfile: 'dist/literature-worker.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  define: { 'import.meta.url': '""' },
  banner: {
    js: '// Built by Codex (LLM agent) from shared literature routing sources.'
  }
})
await build({
  entryPoints: ['src/literature-routing/router.ts'],
  outfile: 'dist/literature-engine.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18'
})
