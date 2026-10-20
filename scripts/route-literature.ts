// Implemented by Codex (LLM agent): Node transport for the shared routing engine.
import { readFileSync } from 'node:fs'
import { AvoidLib } from 'libavoid-js'
import { type Drawing } from '../src/literature-routing/router'
import { routeCanvas } from '../src/literature-routing/dispatch'
import type { AvoidRuntime } from '../src/literature-routing/avoid-runtime'
async function main() {
  await AvoidLib.load(process.argv[2])
  const input = JSON.parse(readFileSync(0, 'utf8')) as {
    canvas: Drawing
    previous?: Drawing
  }
  const output = routeCanvas(
    AvoidLib.getInstance() as unknown as AvoidRuntime,
    input.canvas,
    input.previous
  )
  process.stdout.write(JSON.stringify(output) + '\n')
}
void main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
