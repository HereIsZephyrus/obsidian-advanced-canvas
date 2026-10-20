// Implemented by Codex (LLM agent): shared obstacle routing and label placement.
import type {
  AvoidRuntime,
  RouterHandle,
  ShapeHandle,
  ConnectorHandle
} from './avoid-runtime'
export type Point = { x: number; y: number }
export type Box = Point & { width: number; height: number }
export type Node = Box & { id: string; type?: string }
export type Side = 'left' | 'right' | 'top' | 'bottom'
export type Route = {
  version: 1
  engine: string
  points: Point[]
  fromSide: Side
  toSide: Side
  endpoints: number[][]
  label: string
  labelBox?: Box
  leader?: Point[]
  fromPort?: Point
  toPort?: Point
}
export type Edge = {
  id: string
  fromNode: string
  toNode: string
  fromSide?: Side
  toSide?: Side
  label?: string
  literatureRoute?: Route
  literatureEvidence?: unknown
  literatureCanvas?: { kind?: string }
  literatureNavigation?: {types?: string[]; relations?: string[]; papers?: string[]}
}
export type Drawing = { nodes: Node[]; edges: Edge[]; metadata?: {literatureNavigation?: {kind?: string; presentationVersion?: number}} }
const EPS = 1e-5
const ENGINE = 'libavoid-orthogonal-v1'
const sides: Side[] = ['left', 'right', 'top', 'bottom']
const directions = [4, 8, 1, 2]
export const geometry = (n: Box) => [n.x, n.y, n.width, n.height]
export const port = (n: Box, s: Side): Point => ({
  x: n.x + n.width * (s === 'left' ? 0 : s === 'right' ? 1 : 0.5),
  y: n.y + n.height * (s === 'top' ? 0 : s === 'bottom' ? 1 : 0.5)
})
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const expand = (b: Box, d: number): Box => ({
  x: b.x - d,
  y: b.y - d,
  width: b.width + 2 * d,
  height: b.height + 2 * d
})
export const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width - EPS &&
  a.x + a.width > b.x + EPS &&
  a.y < b.y + b.height - EPS &&
  a.y + a.height > b.y + EPS
export function segmentHits(a: Point, b: Point, box: Box): boolean {
  let lo = 0,
    hi = 1
  for (const axis of ['x', 'y'] as const) {
    const d = b[axis] - a[axis],
      min = box[axis] + EPS,
      max = box[axis] + box[axis === 'x' ? 'width' : 'height'] - EPS
    if (Math.abs(d) < EPS) {
      if (a[axis] <= min || a[axis] >= max) return false
    } else {
      const t1 = (min - a[axis]) / d,
        t2 = (max - a[axis]) / d
      lo = Math.max(lo, Math.min(t1, t2))
      hi = Math.min(hi, Math.max(t1, t2))
      if (lo >= hi) return false
    }
  }
  return hi > lo
}
export const pathHits = (ps: Point[], box: Box) =>
  ps.slice(1).some((b, i) => segmentHits(ps[i], b, box))
const pathLength = (ps: Point[]) =>
  ps.slice(1).reduce((sum, b, i) => sum + distance(ps[i], b), 0)
// Implemented by Codex (LLM agent): managed edges have a center before native Bezier initialization.
export function routeCenter(route: Route): Point {
  if (route.labelBox) return {x:route.labelBox.x+route.labelBox.width/2,y:route.labelBox.y+route.labelBox.height/2}
  let remaining = pathLength(route.points)/2
  for(let i=1;i<route.points.length;i++) {
    const a=route.points[i-1],b=route.points[i],length=distance(a,b)
    if(length>0 && remaining<=length) {
      const t=remaining/length
      return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}
    }
    remaining-=length
  }
  return {...route.points[0]}
}
export function simplify(points: Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const q = {
      x: Math.round(p.x * 1000) / 1000,
      y: Math.round(p.y * 1000) / 1000
    }
    if (out.length && distance(out[out.length - 1], q) < EPS) continue
    if (out.length > 1) {
      const a = out[out.length - 2],
        b = out[out.length - 1]
      if (
        Math.abs((b.x - a.x) * (q.y - b.y) - (b.y - a.y) * (q.x - b.x)) < EPS &&
        (b.x - a.x) * (q.x - b.x) + (b.y - a.y) * (q.y - b.y) >= 0
      )
        out.pop()
    }
    out.push(q)
  }
  return out
}
export const clearPath = (ps: Point[], nodes: Node[], edge: Edge) =>
  nodes.every(
    (n) =>
      !pathHits(
        ps,
        expand(n, n.id === edge.fromNode || n.id === edge.toNode ? -0.05 : 3)
      )
  )
export function hasRouteGeometry(route: Route | undefined): route is Route {
  if (
    !route ||
    route.version !== 1 ||
    ![ENGINE, 'libavoid-polyline-v1'].includes(route.engine) ||
    !Array.isArray(route.points) ||
    route.points.length < 2 ||
    !sides.includes(route.fromSide) ||
    !sides.includes(route.toSide)
  )
    return false
  const finitePoint = (p: Point) =>
    p && Number.isFinite(p.x) && Number.isFinite(p.y)
  if (
    !route.points.every(finitePoint) ||
    (route.engine === ENGINE && route.points
      .slice(1)
      .some(
        (p, i) =>
          Math.abs(p.x - route.points[i].x) > EPS &&
          Math.abs(p.y - route.points[i].y) > EPS
      )) ||
    (route.engine === 'libavoid-polyline-v1' && (!finitePoint(route.fromPort!) || !finitePoint(route.toPort!)))
  )
    return false
  if (
    route.leader &&
    (!Array.isArray(route.leader) ||
      route.leader.length < 2 ||
      !route.leader.every(finitePoint))
  )
    return false
  if (
    route.labelBox &&
    (!geometry(route.labelBox).every(Number.isFinite) ||
      route.labelBox.width <= 0 ||
      route.labelBox.height <= 0)
  )
    return false
  return true
}
export function validRoute(
  route: Route | undefined,
  edge: Edge,
  nodes: Node[],
  byId: Map<string, Node>
): route is Route {
  if (!hasRouteGeometry(route)) return false
  const a = byId.get(edge.fromNode),
    b = byId.get(edge.toNode)
  return (
    !!a &&
    !!b &&
    same(route.endpoints, [geometry(a), geometry(b)]) &&
    route.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) &&
    distance(route.points[0], port(a, route.fromSide)) < 0.01 &&
    distance(route.points[route.points.length - 1], port(b, route.toSide)) <
      0.01 &&
    clearPath(route.points, nodes, edge)
  )
}
export function shape(A: AvoidRuntime, router: RouterHandle, b: Box) {
  const p = new A.Point(b.x, b.y),
    q = new A.Point(b.x + b.width, b.y + b.height),
    rect = new A.Rectangle(p, q),
    s = new A.ShapeRef(router, rect)
  p.delete()
  q.delete()
  rect.delete()
  return s
}
function sideAt(node: Node, p: Point): Side {
  return [...sides].sort(
    (a, b) => distance(port(node, a), p) - distance(port(node, b), p)
  )[0]
}
function sharedLength(a: Point[], b: Point[]): number {
  let length = 0
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++) {
      const p = a[i - 1],
        q = a[i],
        r = b[j - 1],
        s = b[j]
      if (
        Math.abs(p.y - q.y) < EPS &&
        Math.abs(r.y - s.y) < EPS &&
        Math.abs(p.y - r.y) < EPS
      )
        length += Math.max(
          0,
          Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) -
            Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x))
        )
      if (
        Math.abs(p.x - q.x) < EPS &&
        Math.abs(r.x - s.x) < EPS &&
        Math.abs(p.x - r.x) < EPS
      )
        length += Math.max(
          0,
          Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) -
            Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y))
        )
    }
  return length
}
export function nudge(
  route: Route,
  edge: Edge,
  occupied: Route[],
  nodes: Node[],
  labels: Box[]
) {
  const shared = (ps: Point[]) =>
    occupied.reduce((n, r) => n + sharedLength(ps, r.points), 0)
  for (let i = 1; i < route.points.length - 2; i++) {
    let best = route.points,
      score = shared(best)
    if (score < 24) break
    const a = route.points[i],
      b = route.points[i + 1],
      horizontal = Math.abs(a.y - b.y) < EPS
    for (const shift of [-6, 6, -12, 12, -18, 18]) {
      const ps = route.points.map((p) => ({ ...p }))
      ps[i][horizontal ? 'y' : 'x'] += shift
      ps[i + 1][horizontal ? 'y' : 'x'] += shift
      if (
        !clearPath(ps, nodes, edge) ||
        labels.some((box) => pathHits(ps, box))
      )
        continue
      const cost = shared(ps)
      if (cost < score - 1) {
        best = ps
        score = cost
      }
    }
    route.points = simplify(best)
  }
}
function labelSize(label: string) {
  return {
    width:
      Math.ceil(
        [...label].reduce((v, c) => v + (c.codePointAt(0)! > 127 ? 16 : 8), 0)
      ) + 16,
    height: 28
  }
}
export function placeLabel(
  A: AvoidRuntime,
  edge: Edge,
  route: Route,
  nodes: Node[],
  occupied: Box[],
  routes: Map<string, Route>,
  old?: Route
) {
  if (!edge.label) return
  const size = labelSize(edge.label),
    otherPaths = [...routes]
      .filter(([id]) => id !== edge.id)
      .flatMap(([, r]) => (r.leader ? [r.points, r.leader] : [r.points]))
  const clear = (box: Box) =>
    !nodes.some((n) => intersects(box, expand(n, 8))) &&
    !occupied.some((b) => intersects(box, expand(b, 5))) &&
    !otherPaths.some((ps) => pathHits(ps, expand(box, 3)))
  const oldLeader = old?.leader
  if (
    old?.labelBox &&
    old.label === edge.label &&
    same(old.points, route.points) &&
    clear(old.labelBox) &&
    (!oldLeader ||
      (!nodes.some((n) => pathHits(oldLeader, expand(n, 3))) &&
        !occupied.some((b) => pathHits(oldLeader, b))))
  ) {
    route.labelBox = { ...old.labelBox }
    route.leader = old.leader
    occupied.push(route.labelBox)
    return
  }
  const candidates: { box: Box; leader?: Point[]; cost: number }[] = []
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1],
      b = route.points[i],
      len = distance(a, b)
    const fractions = [
      0.5,
      0.25,
      0.75,
      ...Array.from(
        { length: Math.min(40, Math.floor(len / 32)) },
        (_, j) => (j + 0.5) / Math.min(40, Math.floor(len / 32))
      )
    ]
    for (const t of fractions) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      for (const offset of [
        0, 32, -32, 56, -56, 88, -88, 128, -128, 192, -192
      ]) {
        const horizontal = Math.abs(a.y - b.y) < EPS
        const center = {
          x: p.x + (horizontal ? 0 : offset),
          y: p.y + (horizontal ? offset : 0)
        }
        const box = {
          x: center.x - size.width / 2,
          y: center.y - size.height / 2,
          ...size
        }
        if (!clear(box)) continue
        const leader = offset ? [p, center] : undefined
        if (
          leader &&
          (nodes.some((n) => pathHits(leader, expand(n, 3))) ||
            occupied.some((b) => pathHits(leader, b)))
        )
          continue
        candidates.push({
          box,
          leader,
          cost: Math.abs(offset) * 4 + Math.abs(t - 0.5) * 40 - len * 0.01
        })
      }
    }
  }
  candidates.sort(
    (a, b) => a.cost - b.cost || a.box.x - b.box.x || a.box.y - b.box.y
  )
  if (!candidates.length) {
    const anchors = route.points
      .slice(1)
      .map((b, i) => ({
        x: (route.points[i].x + b.x) / 2,
        y: (route.points[i].y + b.y) / 2
      }))
      .filter(
        (p) =>
          !nodes.some(
            (n) =>
              p.x > n.x - 4 &&
              p.x < n.x + n.width + 4 &&
              p.y > n.y - 4 &&
              p.y < n.y + n.height + 4
          )
      )
    for (let step = 1; step <= 6000 && !candidates.length; step++) {
      const radius = 18 * Math.sqrt(step),
        angle = step * Math.PI * (3 - Math.sqrt(5))
      for (const anchor of anchors) {
        const center = {
          x: anchor.x + radius * Math.cos(angle),
          y: anchor.y + radius * Math.sin(angle)
        }
        const box = {
          x: center.x - size.width / 2,
          y: center.y - size.height / 2,
          ...size
        }
        if (!clear(box)) continue
        const router = new A.Router(2)
        try {
          router.setRoutingParameter(A.RoutingParameter.shapeBufferDistance, 3)
          router.setRoutingParameter(A.RoutingParameter.segmentPenalty, 35)
          for (const n of nodes) shape(A, router, n)
          for (const b of occupied) shape(A, router, b)
          const p = new A.Point(anchor.x, anchor.y),
            q = new A.Point(center.x, center.y),
            a = new A.ConnEnd(p),
            b = new A.ConnEnd(q),
            conn = new A.ConnRef(router, a, b)
          p.delete()
          q.delete()
          a.delete()
          b.delete()
          router.processTransaction()
          const line = conn.displayRoute(),
            ps: Point[] = []
          for (let j = 0; j < line.size(); j++) {
            const v = line.at(j)
            ps.push({ x: v.x, y: v.y })
            v.delete()
          }
          const leader = simplify(ps)
          if (
            leader.length >= 2 &&
            !nodes.some((n) => pathHits(leader, expand(n, 1))) &&
            !occupied.some((b) => pathHits(leader, b))
          )
            candidates.push({ box, leader, cost: pathLength(leader) })
        } finally {
          router.delete()
        }
        if (candidates.length) break
      }
    }
  }
  if (!candidates.length)
    throw new Error(`No collision-free label position for ${edge.id}`)
  route.labelBox = candidates[0].box
  route.leader = candidates[0].leader
  occupied.push(route.labelBox)
}
export function routeDrawing(
  A: AvoidRuntime,
  drawing: Drawing,
  previous?: Drawing
) {
  const nodes = drawing.nodes
    .filter((n) => n.type !== 'group')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const edges = [...drawing.edges].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ),
    byId = new Map(nodes.map((n) => [n.id, n]))
  const old = new Map(
      (previous?.edges ?? drawing.edges).map((e) => [e.id, e.literatureRoute])
    ),
    routes = new Map<string, Route>(),
    dirty: Edge[] = [],
    reserved: Box[] = []
  for (const edge of edges) {
    if (!byId.has(edge.fromNode) || !byId.has(edge.toNode))
      throw new Error(`Missing routing endpoint for ${edge.id}`)
    const r = old.get(edge.id)
    if (validRoute(r, edge, nodes, byId)) {
      routes.set(edge.id, JSON.parse(JSON.stringify(r)) as Route)
    } else {
      dirty.push(edge)
      old.delete(edge.id)
    }
  }
  // Existing valid labels reserve space before new connectors are routed.
  for (const edge of edges) {
    if (!routes.has(edge.id)) continue
    const r = old.get(edge.id),
      box = r?.labelBox
    if (
      box &&
      r?.label === edge.label &&
      !nodes.some((n) => intersects(box, expand(n, 8))) &&
      !reserved.some((b) => intersects(box, expand(b, 5))) &&
      ![...routes].some(
        ([id, path]) => id !== edge.id && pathHits(path.points, expand(box, 3))
      )
    )
      reserved.push(box)
  }
  if (dirty.length) {
    const router = new A.Router(2)
    try {
      router.setRoutingParameter(A.RoutingParameter.segmentPenalty, 35)
      router.setRoutingParameter(A.RoutingParameter.shapeBufferDistance, 6)
      router.setRoutingParameter(A.RoutingParameter.idealNudgingDistance, 6)
      router.setRoutingOption(
        A.RoutingOption.nudgeSharedPathsWithCommonEndPoint,
        true
      )
      router.setRoutingOption(
        A.RoutingOption.nudgeOrthogonalTouchingColinearSegments,
        true
      )
      const shapes = new Map<string, ShapeHandle>()
      for (const n of nodes) {
        const s = shape(A, router, n)
        shapes.set(n.id, s)
        for (let i = 0; i < sides.length; i++) {
          const p = port({ x: 0, y: 0, width: 1, height: 1 }, sides[i])
          new A.ShapeConnectionPin(
            s,
            1,
            p.x,
            p.y,
            true,
            0,
            directions[i]
          ).setExclusive(false)
        }
      }
      for (const box of reserved) shape(A, router, expand(box, 3))
      const conns = new Map<string, ConnectorHandle>()
      for (const e of dirty) {
        const a = new A.ConnEnd(shapes.get(e.fromNode)!, 1),
          b = new A.ConnEnd(shapes.get(e.toNode)!, 1),
          c = new A.ConnRef(router, a, b)
        a.delete()
        b.delete()
        conns.set(e.id, c)
      }
      router.processTransaction()
      for (const e of dirty) {
        const line = conns.get(e.id)!.displayRoute(),
          points: Point[] = []
        for (let i = 0; i < line.size(); i++) {
          const p = line.at(i)
          points.push({ x: p.x, y: p.y })
          p.delete()
        }
        const ps = simplify(points),
          a = byId.get(e.fromNode)!,
          b = byId.get(e.toNode)!
        if (ps.length < 2 || !clearPath(ps, nodes, e))
          throw new Error(`Router could not avoid cards for ${e.id}`)
        routes.set(e.id, {
          version: 1,
          engine: ENGINE,
          points: ps,
          fromSide: sideAt(a, ps[0]),
          toSide: sideAt(b, ps[ps.length - 1]),
          endpoints: [geometry(a), geometry(b)],
          label: e.label ?? ''
        })
      }
    } finally {
      router.delete()
    }
  }
  const occupied = [...routes]
    .filter(([id]) => !dirty.some((e) => e.id === id))
    .map(([, r]) => r)
  for (const e of dirty) {
    const r = routes.get(e.id)!
    nudge(r, e, occupied, nodes, reserved)
    occupied.push(r)
  }
  const labels: Box[] = []
  // Retained labels first, so additions do not unnecessarily move old labels.
  const labelOrder = [...edges].sort(
    (a, b) =>
      Number(!old.get(a.id)?.labelBox) - Number(!old.get(b.id)?.labelBox) ||
      (a.id < b.id ? -1 : 1)
  )
  for (const e of labelOrder) {
    const r = routes.get(e.id)!
    r.label = e.label ?? ''
    delete r.labelBox
    delete r.leader
    placeLabel(A, e, r, nodes, labels, routes, old.get(e.id))
  }
  const changed = edges
    .filter((e) => !same(routes.get(e.id), old.get(e.id)))
    .map((e) => e.id)
  return {
    routes: Object.fromEntries(routes),
    report: {
      engine: ENGINE,
      edges: edges.length,
      rerouted: dirty.map((e) => e.id),
      changed,
      preserved_paths: edges.length - dirty.length,
      edge_card_intersections: 0,
      label_card_intersections: 0,
      label_label_intersections: 0,
      bends: [...routes.values()].reduce(
        (s, r) => s + Math.max(0, r.points.length - 2),
        0
      ),
      length: Math.round(
        [...routes.values()].reduce((s, r) => s + pathLength(r.points), 0)
      )
    }
  }
}
