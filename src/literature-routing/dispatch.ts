// Implemented by Codex (LLM agent): choose a renderer's geometric routing contract explicitly.
import {routeDrawing, type Drawing} from './router'
import {routeOverview} from './overview-router'
import type {AvoidRuntime} from './avoid-runtime'
export function routeCanvas(runtime: AvoidRuntime, drawing: Drawing, previous?: Drawing) {
  return drawing.metadata?.literatureNavigation?.kind === 'overview'
    ? routeOverview(runtime,drawing,previous) : routeDrawing(runtime,drawing,previous)
}
