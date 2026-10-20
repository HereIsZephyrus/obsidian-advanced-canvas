// Implemented by Codex (LLM agent): retain the state-write queue across plugin reloads.
const key = Symbol.for('advanced-canvas.literature-navigation.save-queue')
const host = globalThis as unknown as Record<symbol, Map<string, Promise<void>>>
const tails = host[key] ??= new Map<string, Promise<void>>()
export const waitForWrites = (path: string) => (tails.get(path) || Promise.resolve()).catch(() => {})
export function serializeWrite(path: string, write: () => Promise<void>): Promise<void> {
  const operation = waitForWrites(path).then(write)
  tails.set(path, operation)
  void operation.finally(() => {if (tails.get(path) === operation) tails.delete(path)}).catch(() => {})
  return operation
}
