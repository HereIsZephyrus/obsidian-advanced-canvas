// Implemented by Codex (LLM agent): serialize routing jobs and render persisted paths.
import { Notice } from 'obsidian'
import type AdvancedCanvasPlugin from '../main'
import type { Canvas, CanvasEdge } from '../@types/Canvas'
import {orderedTypes, splitPath, styleFor} from '../literature-navigation/presentation'
import {
  type Drawing,
  type Edge,
  type Route,
  type Point,
  geometry,
  hasRouteGeometry
} from './router'

type Result = { routes: Record<string, Route>; report: Record<string, unknown> }
type State = {
  file?: string
  revision: number
  timer?: number
  running: boolean
  applying: boolean
  last?: Drawing
  error?: string
  report?: Record<string, unknown>
}
type RoutedEdge = CanvasEdge & { literatureLeader?: SVGPathElement; literatureSpectrum?: SVGGElement }
export default class LiteratureRoutingController {
  private states = new Map<Canvas, State>()
  private worker?: Worker
  private ready?: Promise<Worker>
  private urls: string[] = []
  private sequence = 0
  private disposed = false
  private jobs = new Map<
    number,
    { resolve: (r: Result) => void; reject: (e: Error) => void }
  >()
  constructor(private plugin: AdvancedCanvasPlugin) {
    for (const name of [
      'canvas-changed',
      'node-added',
      'node-removed',
      'node-moved',
      'node-resized',
      'edge-added',
      'edge-removed',
      'dragging-state-changed'
    ] as const)
      plugin.registerEvent(
        plugin.app.workspace.on(`advanced-canvas:${name}`, (canvas: Canvas) =>
          this.schedule(canvas)
        )
      )
    plugin.registerEvent(
      plugin.app.workspace.on(
        'advanced-canvas:canvas-view-unloaded:before',
        (view) => {
          const state = this.states.get(view.canvas)
          if (state?.timer) window.clearTimeout(state.timer)
          this.states.delete(view.canvas)
        }
      )
    )
    plugin.registerEvent(plugin.app.workspace.on('advanced-canvas:selection-changed', canvas => {
      for (const edge of canvas.edges.values()) {
        this.render(canvas, edge)
      }
    }))
    // Register after the built-in edge styles so persisted paths remain authoritative.
    plugin.registerEvent(
      plugin.app.workspace.on(
        'advanced-canvas:edge-changed',
        (canvas, edge) => {
          this.render(canvas, edge)
          if (edge.isDirty) this.schedule(canvas)
        }
      )
    )
    plugin.registerEvent(
      plugin.app.workspace.on(
        'advanced-canvas:edge-center-requested',
        (_canvas, edge, center) => {
          const route = (edge.getData() as unknown as Edge).literatureRoute
          if (route?.labelBox) {
            center.x = route.labelBox.x + route.labelBox.width / 2
            center.y = route.labelBox.y + route.labelBox.height / 2
          }
        }
      )
    )
    plugin.register(() => this.destroy())
    plugin.app.workspace.onLayoutReady(() =>
      plugin.getCanvases().forEach((canvas) => this.schedule(canvas))
    )
  }
  private managed(canvas: Canvas) {
    // Added by Codex (LLM agent): overview edges use the overview renderer.
    const navigation = (canvas.getData() as unknown as {
      metadata?: {literatureNavigation?: {kind?: string; presentationVersion?: number}}
    }).metadata?.literatureNavigation
    if (navigation?.kind === 'overview') return (navigation.presentationVersion || 1) >= 2
    const routed = [...canvas.edges.values()].some(
      (e) =>
        (e.getData() as unknown as Edge).literatureRoute?.engine ===
        'libavoid-orthogonal-v1'
    )
    if (routed) return true
    const data = canvas.getData() as Drawing & {
      literatureCanvas?: { routing_engine?: string }
    }
    return data.literatureCanvas?.routing_engine === 'libavoid-orthogonal-v1'
  }
  private snapshot(canvas: Canvas): Drawing {
    return JSON.parse(JSON.stringify(canvas.getData())) as Drawing
  }
  private signature(canvas: Drawing) {
    return JSON.stringify({
      kind: canvas.metadata?.literatureNavigation?.kind,
      nodes: canvas.nodes.map((n) => [n.id, ...geometry(n)]).sort(),
      edges: canvas.edges
        .map((e) => [e.id, e.fromNode, e.toNode, e.label ?? ''])
        .sort()
    })
  }
  private state(canvas: Canvas) {
    let state = this.states.get(canvas)
    if (!state) {
      state = { revision: 0, running: false, applying: false }
      this.states.set(canvas, state)
    }
    const file = canvas.view.file?.path
    if (state.file !== file) {
      state.file = file
      state.last = undefined
      state.report = undefined
      state.revision++
    }
    return state
  }
  schedule(canvas: Canvas) {
    if (
      this.disposed ||
      !canvas?.nodes ||
      !canvas.edges ||
      canvas.isClearing ||
      !this.managed(canvas)
    )
      return
    const state = this.state(canvas)
    if (state.applying) return
    state.revision++
    if (state.timer) window.clearTimeout(state.timer)
    state.timer = window.setTimeout(() => {
      state.timer = undefined
      void this.run(canvas)
    }, 180)
  }
  private async getWorker() {
    this.ready ??= (async () => {
      const dir = this.plugin.manifest.dir!
      const source = await this.plugin.app.vault.adapter.read(
        dir + '/literature-worker.js'
      )
      const wasm = await this.plugin.app.vault.adapter.readBinary(
        dir + '/libavoid.wasm'
      )
      if (this.disposed) throw new Error('Routing worker unloaded')
      this.urls = [
        URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
        URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }))
      ]
      const worker = new Worker(this.urls[0])
      this.worker = worker
      worker.onmessage = ({
        data
      }: MessageEvent<{ id: number; error?: string; result: Result }>) => {
        const job = this.jobs.get(data.id)
        if (!job) return
        this.jobs.delete(data.id)
        if (data.error) job.reject(new Error(data.error))
        else job.resolve(data.result)
      }
      worker.onerror = (event) => {
        for (const job of this.jobs.values())
          job.reject(new Error(event.message))
        this.jobs.clear()
      }
      return worker
    })()
    return this.ready
  }
  private async compute(canvas: Drawing, previous?: Drawing): Promise<Result> {
    const worker = await this.getWorker(),
      id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject })
      worker.postMessage({ id, canvas, previous, wasmUrl: this.urls[1] })
    })
  }
  private async run(canvas: Canvas) {
    const state = this.state(canvas)
    if (state.running || state.applying || canvas.isDragging || this.disposed || !this.managed(canvas))
      return
    const snapshot = this.snapshot(canvas),
      signature = this.signature(snapshot),
      revision = state.revision
    if (state.last && this.signature(state.last) === signature) return
    state.running = true
    try {
      const result = await this.compute(snapshot, state.last)
      if (this.disposed || !this.states.has(canvas) || !this.managed(canvas)) return
      if (
        state.revision !== revision ||
        canvas.isDragging ||
        this.signature(this.snapshot(canvas)) !== signature
      )
        return
      state.applying = true
      let changed = false
      for (const [id, route] of Object.entries(result.routes)) {
        const edge = canvas.edges.get(id)
        if (!edge) continue
        const data = edge.getData() as unknown as Edge
        if (JSON.stringify(data.literatureRoute) !== JSON.stringify(route)) {
          edge.setData({
            ...edge.getData(),
            fromSide: route.fromSide,
            toSide: route.toSide,
            literatureRoute: route
          } as Parameters<CanvasEdge['setData']>[0])
          changed = true
        }
        canvas.markMoved(edge)
        canvas.markDirty(edge)
      }
      state.last = this.snapshot(canvas)
      state.report = result.report
      state.error = undefined
      if (changed) {
        // Routing belongs to the existing edit, not a separate undo step.
        const current = canvas.history.data[canvas.history.current]
        if (current && this.signature(current) === signature)
          canvas.history.replace(canvas.getData())
        canvas.view.requestSave()
      }
    } catch (error) {
      if (this.disposed || !this.states.has(canvas)) return
      state.error = String(error)
      console.error('Literature routing failed:', error)
      new Notice(
        'Literature routing could not find a clear path. The previous routes were retained.'
      )
    } finally {
      state.applying = false
      state.running = false
      if (
        state.revision !== revision &&
        !this.disposed &&
        this.states.has(canvas)
      )
        this.schedule(canvas)
    }
  }
  render(canvas: Canvas, edge: RoutedEdge) {
    if (this.disposed || !canvas?.nodes || !canvas.edges || canvas.isClearing || !edge.path || !edge.lineGroupEl)
      return
    const route = (edge.getData() as unknown as Edge).literatureRoute
    if (!hasRouteGeometry(route)) {
      this.clearSegments(edge)
      return
    }
    const a = canvas.nodes.get(edge.from.node.id),
      b = canvas.nodes.get(edge.to.node.id)
    if (
      !a ||
      !b ||
      JSON.stringify(route.endpoints) !==
        JSON.stringify([geometry(a), geometry(b)])
    ) {
      edge.literatureLeader?.remove()
      this.clearSegments(edge)
      return
    }
    const path = (points: Point[]) =>
      points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')
    edge.path.interaction.setAttribute('d', path(route.points))
    edge.path.display.setAttribute('d', path(route.points))
    this.colorSegments(canvas, edge, route)
    if (route.leader) {
      if (!edge.literatureLeader) {
        edge.literatureLeader = createSvg('path')
        edge.literatureLeader.setAttribute('class', 'literature-label-leader')
      }
      edge.lineGroupEl.appendChild(edge.literatureLeader)
      edge.literatureLeader.setAttribute('d', path(route.leader))
    } else edge.literatureLeader?.remove()
    if (edge.labelElement && route.labelBox) {
      const wrapper = edge.labelElement.wrapperEl
      wrapper.classList.add('literature-route-label')
      wrapper.style.setProperty(
        '--literature-label-width',
        `${route.labelBox.width}px`
      )
      wrapper.style.setProperty(
        '--literature-label-height',
        `${route.labelBox.height}px`
      )
    }
    edge.labelElement?.render()
  }
  status(canvas: Canvas) {
    const s = this.states.get(canvas)
    return s
      ? {
          running: s.running,
          pending: !!s.timer,
          revision: s.revision,
          error: s.error,
          report: s.report
        }
      : null
  }
  private colorSegments(canvas: Canvas, edge: RoutedEdge, route: Route) {
    const data = edge.getData() as unknown as Edge
    const evidence = data.literatureEvidence as {type?: string} | undefined
    const types = orderedTypes(data.literatureNavigation?.types || (evidence?.type ? [evidence.type] : []))
    if (!types.length) {
      this.clearSegments(edge)
      return
    }
    const pieces = splitPath(route.points, types.length)
    if (pieces.length !== types.length) return
    edge.literatureSpectrum ??= document.createElementNS('http://www.w3.org/2000/svg', 'g')
    const group = edge.literatureSpectrum
    group.setAttribute('class', 'literature-spectrum')
    group.setAttribute('pointer-events', 'none')
    edge.lineGroupEl.appendChild(group)
    edge.path.display.classList.add('literature-spectrum-base')
    edge.lineGroupEl.style.setProperty('--canvas-color', styleFor(types[0])!.color)
    while (group.children.length > pieces.length) group.lastElementChild?.remove()
    for (let i=0; i<pieces.length; i++) {
      let segment = group.children[i] as SVGPathElement | undefined
      if (!segment) {segment=document.createElementNS('http://www.w3.org/2000/svg','path');group.appendChild(segment)}
      segment.setAttribute('class','literature-spectrum-segment')
      segment.setAttribute('data-relation-type',types[i])
      segment.setAttribute('d',pieces[i].map((p,j)=>`${j?'L':'M'}${p.x},${p.y}`).join(' '))
      segment.style.setProperty('stroke',styleFor(types[i])!.color,'important')
      segment.style.setProperty('stroke-width',canvas.selection.has(edge)?'4':'2.5','important')
    }
  }
  private clearSegments(edge: RoutedEdge) {
    edge.literatureSpectrum?.remove()
    edge.path?.display.classList.remove('literature-spectrum-base')
    edge.lineGroupEl?.style.removeProperty('--canvas-color')
  }
  destroy() {
    this.disposed = true
    for (const [canvas, state] of this.states) {
      if (state.timer) window.clearTimeout(state.timer)
      for (const e of canvas.edges.values()) {
        (e as RoutedEdge).literatureLeader?.remove()
        this.clearSegments(e)
      }
    }
    this.states.clear()
    this.worker?.terminate()
    this.urls.forEach((url) => URL.revokeObjectURL(url))
    for (const job of this.jobs.values())
      job.reject(new Error('Routing worker unloaded'))
    this.jobs.clear()
  }
}
