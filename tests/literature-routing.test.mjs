// Implemented by Codex (LLM agent): behavior checks for obstacle routing and stable updates.
import test from 'node:test'
import assert from 'node:assert/strict'
import { AvoidLib } from '../node_modules/libavoid-js/dist/index-node.mjs'
import {
  routeDrawing,
  pathHits,
  intersects,
  validRoute,
  routeCenter
} from '../dist/literature-engine.mjs'
await AvoidLib.load(new URL('../dist/libavoid.wasm', import.meta.url).pathname)
const A = AvoidLib.getInstance()
const card = (id, x, y, width = 100, height = 60) => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height
})
const fixture = () => ({
  nodes: [card('a', 0, 0), card('b', 500, 0), card('block', 270, -50, 60, 160)],
  edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: '继承 / 采用' }]
})
const attach = (c, result) => ({
  ...structuredClone(c),
  edges: c.edges.map((e) => ({ ...e, literatureRoute: result.routes[e.id] }))
})
test('managed edge centers use saved labels or the path midpoint without native geometry', () => {
  const route={points:[{x:0,y:0},{x:0,y:10},{x:90,y:10}]}
  assert.deepEqual(routeCenter(route),{x:40,y:10})
  assert.deepEqual(routeCenter({...route,labelBox:{x:10,y:20,width:100,height:30}}),{x:60,y:35})
  assert.deepEqual(routeCenter({points:[{x:7,y:9},{x:7,y:9}]}),{x:7,y:9})
})
function check(c, r) {
  for (const e of c.edges) {
    const route = r.routes[e.id]
    assert(
      validRoute(route, e, c.nodes, new Map(c.nodes.map((n) => [n.id, n])))
    )
    if (e.label) {
      assert(route.labelBox)
      for (const n of c.nodes) assert(!intersects(n, route.labelBox))
      for (const f of c.edges)
        if (f.id !== e.id) {
          assert(!pathHits(r.routes[f.id].points, route.labelBox))
          if (r.routes[f.id].labelBox)
            assert(!intersects(route.labelBox, r.routes[f.id].labelBox))
        }
    }
  }
}
test('routes around obstacles and places labels in free space', () => {
  const c = fixture(),
    r = routeDrawing(A, c)
  check(c, r)
  assert(r.routes.ab.points.length > 2)
})
test('unrelated additions retain exact routes and labels', () => {
  const c = fixture(),
    r = routeDrawing(A, c),
    before = attach(c, r),
    after = structuredClone(before)
  after.nodes.push(card('far', 3000, 3000))
  const next = routeDrawing(A, after, before)
  assert.deepEqual(next.routes, r.routes)
  assert.deepEqual(next.report.rerouted, [])
})
test('an obstacle moving across a route invalidates an edge without endpoint changes', () => {
  const c = fixture()
  c.nodes[2].y = 400
  const before = attach(c, routeDrawing(A, c)),
    after = structuredClone(before)
  after.nodes[2].y = -50
  const r = routeDrawing(A, after, before)
  assert.deepEqual(r.report.rerouted, ['ab'])
  check(after, r)
})
test('reloading a saved drawing retains routes and labels', () => {
  const c = fixture(),
    r = routeDrawing(A, c),
    saved = JSON.parse(JSON.stringify(attach(c, r)))
  assert.deepEqual(routeDrawing(A, saved).routes, r.routes)
})
test('two overlapping connectors receive separate intermediate lanes', () => {
  const c = fixture()
  c.edges.push({
    id: 'second',
    fromNode: 'a',
    toNode: 'b',
    label: '另一条关系'
  })
  const r = routeDrawing(A, c)
  check(c, r)
  assert.notDeepEqual(r.routes.ab.points, r.routes.second.points)
})
test('moving an endpoint recomputes its route and preserves unrelated component', () => {
  const c = fixture()
  c.nodes.push(card('d', 1200, 0), card('e', 1600, 0))
  c.edges.push({ id: 'de', fromNode: 'd', toNode: 'e' })
  const before = attach(c, routeDrawing(A, c)),
    after = structuredClone(before)
  after.nodes[0].y -= 120
  const r = routeDrawing(A, after, before)
  check(after, r)
  assert.deepEqual(r.routes.de, before.edges[1].literatureRoute)
  assert(r.report.rerouted.includes('ab'))
})
test('routing does not move nodes or alter relationship evidence', () => {
  const c = fixture()
  c.edges[0].literatureEvidence = { quote: 'source claim' }
  const original = structuredClone(c)
  routeDrawing(A, c)
  assert.deepEqual(c, original)
})
test('editing and removing a label updates the cache without changing its clear path', () => {
  const c = fixture(),
    before = attach(c, routeDrawing(A, c)),
    after = structuredClone(before)
  after.edges[0].label = '新的关系标签'
  const r = routeDrawing(A, after, before)
  check(after, r)
  assert.equal(r.routes.ab.label, after.edges[0].label)
  assert.deepEqual(r.routes.ab.points, before.edges[0].literatureRoute.points)
  delete after.edges[0].label
  const removed = routeDrawing(A, after, attach(after, r))
  assert.equal(removed.routes.ab.label, '')
  assert.equal(removed.routes.ab.labelBox, undefined)
})
test('malformed cached geometry is discarded and rebuilt', () => {
  for (const bad of [
    { points: null },
    { points: [null, null] },
    { fromSide: 'invalid' },
    { leader: [{}] },
    { labelBox: { x: NaN, y: 0, width: 10, height: 20 } }
  ]) {
    const c = fixture(),
      before = attach(c, routeDrawing(A, c))
    Object.assign(before.edges[0].literatureRoute, bad)
    const r = routeDrawing(A, before)
    check(before, r)
    assert.deepEqual(r.report.rerouted, ['ab'])
  }
})
