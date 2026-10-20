// Implemented by Codex (LLM agent): run the shared router outside Obsidian's UI thread.
import { AvoidLib } from 'libavoid-js'
import { type Drawing } from './router'
import { routeCanvas } from './dispatch'
import type { AvoidRuntime } from './avoid-runtime'
let ready: Promise<void> | undefined
self.onmessage = async ({
  data
}: MessageEvent<{
  id: number
  canvas: Drawing
  previous?: Drawing
  wasmUrl: string
}>) => {
  try {
    ready ??= AvoidLib.load(data.wasmUrl)
    await ready
    const result = routeCanvas(
      AvoidLib.getInstance() as unknown as AvoidRuntime,
      data.canvas,
      data.previous
    )
    self.postMessage({ id: data.id, result })
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) })
  }
}
