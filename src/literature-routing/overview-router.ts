// Implemented by Codex (LLM agent): distributed boundary ports and short obstacle-avoiding overview paths.
import type {AvoidRuntime, ConnectorHandle} from './avoid-runtime'
import {type Drawing, type Edge, type Node, type Point, type Route, type Side,
  geometry, clearPath, hasRouteGeometry, shape, simplify, placeLabel, expand, intersects, pathHits, nudge} from './router'

const ENGINE = 'libavoid-polyline-v1'
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const center = (n: Node) => ({x:n.x + n.width / 2, y:n.y + n.height / 2})
const sides: Side[] = ['left', 'right', 'top', 'bottom']
const directions = {left:4, right:8, top:1, bottom:2}
type Port = {point: Point; side: Side; fraction: number}
const at = (n: Node, side: Side, t: number): Point => ({
  x: n.x + n.width * (side === 'left' ? 0 : side === 'right' ? 1 : t),
  y: n.y + n.height * (side === 'top' ? 0 : side === 'bottom' ? 1 : t)
})
const sideTo = (a: Node, b: Node): Side => {
  const dx = center(b).x - center(a).x, dy = center(b).y - center(a).y
  return Math.abs(dx) / a.width > Math.abs(dy) / a.height ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top')
}
function onBorder(n: Node, p: Point, side: Side) {
  const axis = side === 'left' || side === 'right' ? 'y' : 'x'
  const t = (p[axis] - n[axis]) / (axis === 'x' ? n.width : n.height)
  return t >= 0 && t <= 1 && distance(at(n, side, t), p) < .01
}
export function validOverviewRoute(route: Route | undefined, edge: Edge, nodes: Node[], byId: Map<string, Node>): route is Route {
  if (!hasRouteGeometry(route) || route.engine !== ENGINE) return false
  const a = byId.get(edge.fromNode), b = byId.get(edge.toNode)
  return !!a && !!b && JSON.stringify(route.endpoints) === JSON.stringify([geometry(a), geometry(b)]) &&
    onBorder(a, route.fromPort!, route.fromSide) && onBorder(b, route.toPort!, route.toSide) &&
    distance(route.points[0], route.fromPort!) < .01 && distance(route.points.at(-1)!, route.toPort!) < .01 && clearPath(route.points, nodes, edge)
}

export function routeOverview(A: AvoidRuntime, drawing: Drawing, previous?: Drawing) {
  const nodes = drawing.nodes.filter(n => n.type !== 'group').slice().sort((a,b) => a.id.localeCompare(b.id))
  const edges = drawing.edges.slice().sort((a,b) => a.id.localeCompare(b.id)), byId = new Map(nodes.map(n => [n.id,n]))
  const old = new Map((previous?.edges || drawing.edges).map(e => [e.id,e.literatureRoute]))
  const routes = new Map<string,Route>(), dirty: Edge[] = []
  for (const edge of edges) {
    if (!byId.has(edge.fromNode) || !byId.has(edge.toNode)) throw new Error(`Missing overview endpoint: ${edge.id}`)
    const cached = old.get(edge.id)
    if (validOverviewRoute(cached, edge, nodes, byId)) routes.set(edge.id, JSON.parse(JSON.stringify(cached)) as Route)
    else dirty.push(edge)
  }
  const portMap = new Map<string, Port>()
  // Retained paths keep their ports. New arrivals occupy the remaining boundary space.
  for (const node of nodes) for (const side of sides) {
    const requests: {key:string; edge:Edge; target:Node}[] = [], used: number[] = []
    for (const edge of edges) for (const end of ['from','to'] as const) {
      if (edge[`${end}Node`] !== node.id) continue
      const cached = routes.get(edge.id), target = byId.get(edge[end === 'from' ? 'toNode' : 'fromNode'])!
      const selectedSide = cached?.[`${end}Side`] || sideTo(node,target)
      if (selectedSide !== side) continue
      const key = `${edge.id}:${end}`
      if (cached) {
        const point = cached[`${end}Port`]!, vertical = side === 'left' || side === 'right'
        const fraction = vertical ? (point.y-node.y)/node.height : (point.x-node.x)/node.width
        used.push(fraction); portMap.set(key,{point,side,fraction})
      } else requests.push({key, edge, target})
    }
    const vertical = side === 'left' || side === 'right', extent = vertical ? node.height : node.width
    const margin = Math.min(.22, 14 / extent)
    requests.sort((a,b) => (vertical ? center(a.target).y-center(b.target).y : center(a.target).x-center(b.target).x) || a.key.localeCompare(b.key))
    if (!used.length) requests.forEach((request, i) => {
      const fraction = margin + (1 - 2 * margin) * (i + 1) / (requests.length + 1)
      portMap.set(request.key, {point:at(node,side,fraction),side,fraction}); used.push(fraction)
    })
    else for (const request of requests) {
      const positions = [margin,...used,1-margin].sort((a,b)=>a-b)
      let left = positions[0], right = positions[1]
      for (let i=1;i<positions.length;i++) if (positions[i]-positions[i-1] > right-left) {left=positions[i-1];right=positions[i]}
      const fraction = (left+right)/2
      used.push(fraction);portMap.set(request.key,{point:at(node,side,fraction),side,fraction})
    }
  }
  const reserved = [...routes].map(([id,route])=>({id,box:route.labelBox,route})).filter(({id,box,route}) =>
    !!box && route.label === edges.find(e=>e.id===id)?.label && !nodes.some(n=>intersects(expand(n,8),box!)) &&
    ![...routes].some(([other,r])=>other!==id && pathHits(r.points,expand(box!,3)))).map(r=>r.box!)
  if (dirty.length) {
    const router = new A.Router(1)
    try {
      router.setRoutingParameter(A.RoutingParameter.segmentPenalty, 50)
      router.setRoutingParameter(A.RoutingParameter.shapeBufferDistance, 10)
      const shapes = new Map(nodes.map(node=>[node.id,shape(A,router,node)])), conns = new Map<string,ConnectorHandle>()
      for (const box of reserved) shape(A,router,expand(box,3))
      let pin = 1
      for (const edge of dirty) {
        const ids: number[] = []
        for (const end of ['from','to'] as const) {
          const node = byId.get(edge[`${end}Node`])!, port = portMap.get(`${edge.id}:${end}`)!, id = pin++
          new A.ShapeConnectionPin(shapes.get(node.id)!,id,(port.point.x-node.x)/node.width,(port.point.y-node.y)/node.height,true,0,directions[port.side]).setExclusive(false)
          ids.push(id)
        }
        const a = new A.ConnEnd(shapes.get(edge.fromNode)!,ids[0]), b = new A.ConnEnd(shapes.get(edge.toNode)!,ids[1])
        conns.set(edge.id,new A.ConnRef(router,a,b));a.delete();b.delete()
      }
      router.processTransaction()
      for (const edge of dirty) {
        const line=conns.get(edge.id)!.displayRoute(), points:Point[]=[]
        for(let i=0;i<line.size();i++){const p=line.at(i);points.push({x:p.x,y:p.y});p.delete()}
        const ps=simplify(points), from=portMap.get(`${edge.id}:from`)!, to=portMap.get(`${edge.id}:to`)!
        if(ps.length<2 || !clearPath(ps,nodes,edge)) throw new Error(`Overview route intersects a card: ${edge.id}`)
        routes.set(edge.id,{version:1,engine:ENGINE,points:ps,fromSide:from.side,toSide:to.side,fromPort:ps[0],toPort:ps.at(-1),
          endpoints:[geometry(byId.get(edge.fromNode)!),geometry(byId.get(edge.toNode)!)],label:edge.label||''})
      }
    } finally {router.delete()}
  }
  const occupied=[...routes].filter(([id])=>!dirty.some(e=>e.id===id)).map(([,r])=>r)
  for(const edge of dirty){const route=routes.get(edge.id)!;nudge(route,edge,occupied,nodes,reserved);occupied.push(route)}
  const labels: {x:number;y:number;width:number;height:number}[]=[]
  for(const edge of [...edges].sort((a,b)=>Number(!old.get(a.id)?.labelBox)-Number(!old.get(b.id)?.labelBox)||a.id.localeCompare(b.id))) {
    const route=routes.get(edge.id)!;route.label=edge.label||'';delete route.labelBox;delete route.leader
    placeLabel(A,edge,route,nodes,labels,routes,old.get(edge.id))
  }
  return {routes:Object.fromEntries(routes),report:{engine:ENGINE,edges:edges.length,rerouted:dirty.map(e=>e.id),preserved_paths:edges.length-dirty.length,
    direct_paths:[...routes.values()].filter(r=>r.points.length===2).length,
    bends:[...routes.values()].reduce((sum,r)=>sum+r.points.length-2,0)}}
}
