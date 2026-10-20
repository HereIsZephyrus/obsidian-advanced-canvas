// Implemented by Codex (LLM agent): verify polyline routing with distributed boundary ports.
import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {AvoidLib} from '../node_modules/libavoid-js/dist/index-node.mjs'
import {pathHits, intersects} from '../dist/literature-engine.mjs'
const built=await build({entryPoints:['src/literature-routing/overview-router.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const {routeOverview,validOverviewRoute}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'))
await AvoidLib.load(new URL('../dist/libavoid.wasm',import.meta.url).pathname)
const A=AvoidLib.getInstance()
const card=(id,x,y,width=180,height=120)=>({id,type:'text',x,y,width,height})
const fixture=()=>({nodes:[card('a',0,0),card('b',700,0),card('c',700,500),card('block',350,-40,160,200)],
  edges:[{id:'ab',fromNode:'a',toNode:'b',label:'继承／采用 · 引用结果'},{id:'ac',fromNode:'a',toNode:'c',label:'结果一致'}]})
const attach=(c,r)=>({...structuredClone(c),edges:c.edges.map(e=>({...e,literatureRoute:r.routes[e.id]}))})
const check=(c,r)=>{
  for(const edge of c.edges){
    const route=r.routes[edge.id]
    assert(validOverviewRoute(route,edge,c.nodes,new Map(c.nodes.map(n=>[n.id,n]))))
    for(const n of c.nodes) assert(!intersects(n,route.labelBox))
    for(const other of c.edges) if(other.id!==edge.id){
      assert(!pathHits(r.routes[other.id].points,route.labelBox))
      assert(!intersects(r.routes[other.id].labelBox,route.labelBox))
    }
  }
}
test('overview routes avoid cards and labels while retaining diagonal segments',()=>{
  const c=fixture(),r=routeOverview(A,c)
  check(c,r)
  assert.equal(r.report.engine,'libavoid-polyline-v1')
  assert(r.routes.ab.points.length>2)
  assert(r.routes.ac.points.some((p,i,ps)=>i&&p.x!==ps[i-1].x&&p.y!==ps[i-1].y))
})
test('neighbor edges use separate ports and unchanged paths survive additions and reload',()=>{
  const c=fixture()
  c.edges.push({id:'ab2',fromNode:'a',toNode:'b',label:'相同方法'})
  const r=routeOverview(A,c);check(c,r)
  assert.notDeepEqual(r.routes.ab.fromPort,r.routes.ab2.fromPort)
  const saved=attach(c,r)
  assert.deepEqual(routeOverview(A,saved).routes,r.routes)
  const after=structuredClone(saved)
  after.nodes.push(card('far',5000,5000))
  assert.deepEqual(routeOverview(A,after,saved).routes,r.routes)
})
test('moving an intervening obstacle invalidates only obstructed paths',()=>{
  const c=fixture();c.nodes[3].y=1500
  const saved=attach(c,routeOverview(A,c)),after=structuredClone(saved)
  after.nodes[3].y=-40
  const r=routeOverview(A,after,saved);check(after,r)
  assert(r.report.rerouted.includes('ab'))
})
