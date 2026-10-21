// Implemented by Codex (LLM agent): test source ambiguity and semantic navigation.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const built = await build({entryPoints:['src/literature-navigation/model.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const model = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const presentationBuild = await build({entryPoints:['src/literature-navigation/presentation.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const presentation = await import('data:text/javascript;base64,' + Buffer.from(presentationBuild.outputFiles[0].text).toString('base64'))
const queueBuild = await build({entryPoints:['src/literature-navigation/save-queue.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const queueUrl = 'data:text/javascript;base64,' + Buffer.from(queueBuild.outputFiles[0].text).toString('base64')
const queue = await import(queueUrl)
const focusBuild = await build({entryPoints:['src/literature-navigation/focus.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const {overviewFocus} = await import('data:text/javascript;base64,' + Buffer.from(focusBuild.outputFiles[0].text).toString('base64'))

// Codex (LLM agent): exercise deferred Obsidian leaves through the controller.
const controllerBuild = await build({entryPoints:['src/literature-navigation/controller.ts'],bundle:true,write:false,platform:'node',format:'esm',
  plugins:[{name:'obsidian-test-api',setup(build){
    build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'test'}))
    build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`
      export const requestUrl=async()=>{throw Error("Unexpected HTTP call")};
      export class ItemView { constructor(leaf) { this.contentEl=leaf.contentEl } }
      export class MarkdownView {}
      export class Notice {}
      export class TFile {}
      export class TAbstractFile {}
      export class WorkspaceLeaf {}
      export class FuzzySuggestModal {}
      export const Platform={isDesktopApp:true};
    `,loader:'js'}))
  }}]})
const {default: NavigationController} = await import('data:text/javascript;base64,' + Buffer.from(controllerBuild.outputFiles[0].text).toString('base64'))

async function navigationController(t) {
  for (const [key,value] of Object.entries({window:{setInterval:()=>0,clearTimeout(){}},document:{}})) {
    const previous=Object.getOwnPropertyDescriptor(globalThis,key)
    Object.defineProperty(globalThis,key,{value,configurable:true})
    t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else delete globalThis[key]})
  }
  let factory
  const leaves=[]
  const workspace={on(){},getLeavesOfType:()=>leaves}
  const plugin={app:{workspace,vault:{on(){},adapter:{exists:async()=>false}}},
    registerView(_type,create){factory=create},addRibbonIcon(){},addCommand(){},
    registerEvent(){},registerDomEvent(){},register(){},registerInterval(){}}
  const controller=new NavigationController(plugin)
  await controller.ready
  const content=()=>({clears:0,titles:[],empty(){this.clears++;this.titles=[]},
    addClass(){},createEl(_tag,options){this.titles.push(options.text);return this}})
  return {controller,leaves,workspace,content,createView:leaf=>factory(leaf)}
}

test('a deferred navigation sidebar does not break background refresh', async t => {
  const {controller,leaves}=await navigationController(t)
  const deferred={view:{getViewType:()=>model.NAV_VIEW},isDeferred:true}
  leaves.push(deferred)
  controller.corpus={}
  controller.currentPath=()=>undefined
  controller.currentCanvas=()=>undefined
  await assert.doesNotReject(()=>controller.refresh())
  assert.equal(deferred.isDeferred,true)
  assert.equal(deferred.view.contentEl,undefined)
})

test('loaded navigation panels render while deferred panels stay unloaded', async t => {
  const {controller,leaves,content,createView}=await navigationController(t)
  const active={contentEl:content()};active.view=createView(active)
  leaves.push({view:{getViewType:()=>model.NAV_VIEW},isDeferred:true},active)
  controller.renderAll()
  assert.equal(active.contentEl.clears,1)
  assert(active.contentEl.titles.includes('文献关系'))
})

test('revealing a deferred panel renders the latest selection', async t => {
  const {controller,leaves,workspace,content,createView}=await navigationController(t)
  const leaf={view:{getViewType:()=>model.NAV_VIEW},isDeferred:true,
    async setViewState(){}}
  leaves.push(leaf)
  const rendered=[]
  controller.render=()=>rendered.push(controller.context.paper)
  controller.refresh=async()=>{controller.context={paper:'selected-paper'};controller.renderAll()}
  await controller.refresh()
  assert.deepEqual(rendered,[])
  workspace.revealLeaf=async target=>{
    assert.equal(target,leaf)
    await Promise.resolve()
    target.contentEl=content();target.view=createView(target);target.isDeferred=false
    await target.view.onOpen()
  }
  await controller.show()
  assert.equal(leaf.isDeferred,false)
  assert(rendered.length>0)
  assert(rendered.every(p=>p==='selected-paper'))
})

test('external corpus additions resolve new papers and reject incomplete relation endpoints', () => {
  const paper = id => ({source:`${id}_content.md`,note:`${id}_notes.md`,tree_path:`${id}_notes.md`})
  const corpus = {version:1,bundle:{papers:{A:paper('a')},relations:[],endpoint_map:{A:{}}},nodes:{A:{}},sourceHashes:{}}
  assert.equal(model.paperForPath(model.parseCorpus(JSON.stringify(corpus)),'b_notes.md'),undefined)
  corpus.bundle.papers.B=paper('b');corpus.nodes.A.method={};corpus.nodes.B={method:{}}
  corpus.bundle.endpoint_map.A={'r-from':'method'};corpus.bundle.endpoint_map.B={'r-to':'method'}
  corpus.bundle.relations=[{id:'r',from_paper:'A',to_paper:'B'}]
  assert.equal(model.paperForPath(model.parseCorpus(JSON.stringify(corpus)),'b_notes.md'),'B')
  delete corpus.nodes.B.method
  assert.throws(()=>model.parseCorpus(JSON.stringify(corpus)),/端点缺失/)
  assert.throws(()=>model.parseCorpus('{'),SyntaxError)
})

test('renaming a companion also moves its embedded tree without losing the source hash', () => {
  const corpus = {bundle:{papers:{A:{source:'paper_content.md',note:'paper_notes.md',tree_path:'paper_notes.md'}}},
    sourceHashes:{'paper_content.md':'source','paper_notes.md':'note'}}
  assert.equal(model.renamePaperPaths(corpus,p=>p==='paper_notes.md'?'renamed.md':p),true)
  assert.equal(corpus.bundle.papers.A.note,'renamed.md')
  assert.equal(corpus.bundle.papers.A.tree_path,'renamed.md')
  assert.deepEqual(corpus.sourceHashes,{'paper_content.md':'source','renamed.md':'note'})
  assert.equal(model.renamePaperPaths(corpus,p=>p),false)
})

test('only selection defines the local focus shared by paths and labels', () => {
  const nodes=['a','b','c','d'],edges=[{id:'ab',fromNode:'a',toNode:'b'},{id:'bc',fromNode:'b',toNode:'c'},{id:'cd',fromNode:'c',toNode:'d'}]
  assert.equal(overviewFocus(nodes,edges,[]).focused,false)
  let focus=overviewFocus(nodes,edges,['a'])
  assert.deepEqual([...focus.connected],['ab']);assert.deepEqual([...focus.neighbors],['a','b'])
  focus=overviewFocus(nodes,edges,['bc'])
  assert.deepEqual([...focus.connected],['bc']);assert.deepEqual([...focus.neighbors],['b','c'])
  focus=overviewFocus(nodes,edges,['a','d'])
  assert.deepEqual([...focus.connected],['ab','cd'])
})

test('plugin reloads share one state-write queue and recover from a failed write', async () => {
  const reloaded = await import(queueUrl + '#reloaded'), events=[]
  let release
  const first = queue.serializeWrite('preview',async()=>{events.push('old-start');await new Promise(r=>{release=r});events.push('old-end')})
  await new Promise(r=>setTimeout(r,0))
  const second = reloaded.serializeWrite('preview',async()=>{events.push('new')})
  assert.deepEqual(events,['old-start'])
  release();await Promise.all([first,second]);await reloaded.waitForWrites('preview')
  assert.deepEqual(events,['old-start','old-end','new'])
  await assert.rejects(queue.serializeWrite('preview',async()=>{throw Error('disk error')}))
  await reloaded.serializeWrite('preview',async()=>events.push('recovered'))
  assert.equal(events.at(-1),'recovered')
})

test('colors divide the entire path equally, including bends and repeated vertices', () => {
  for (const points of [
    [{x:0,y:0},{x:90,y:0}],
    [{x:0,y:0},{x:0,y:10},{x:80,y:10}],
    [{x:0,y:0},{x:0,y:0},{x:30,y:40},{x:30,y:40},{x:130,y:40}]
  ]) for (const count of [1,2,3,5]) {
    const pieces = presentation.splitPath(points,count)
    assert.equal(pieces.length,count)
    assert.deepEqual(pieces[0][0],points[0])
    assert.deepEqual(pieces.at(-1).at(-1),points.at(-1))
    for (let i=0;i<count;i++) {
      assert(Math.abs(presentation.pathLength(pieces[i])-presentation.pathLength(points)/count)<1e-8)
      if (i) assert.deepEqual(pieces[i][0],pieces[i-1].at(-1))
    }
  }
  assert.deepEqual(presentation.splitPath([{x:0,y:0},{x:0,y:0}],2),[])
  assert.throws(()=>presentation.splitPath([],0),/positive/)
})
test('relation types have one stable color and order, independent of multiplicity', () => {
  assert.deepEqual(presentation.orderedTypes(['contrasts','inherits','inherits','uses_result']),['inherits','uses_result','contrasts'])
  assert.equal(presentation.firstAuthor({authors:['[[researchers/Jane Smith]]'],year:2024}),'Jane Smith · 2024')
})

test('paragraph locators tolerate whitespace and preserve UTF-16 editor offsets', () => {
  const text = '🛰️\n# Methods\nThe lake\n  area increased.\n\n# Results\nOther text.'
  const position = model.locateQuote(text, 'The lake area increased.')
  assert.equal(text.slice(position.start, position.end), 'The lake\n  area increased.')
  assert.equal(model.headingAt(text, position.start).title, 'Methods')
})
test('ambiguous or missing quotes do not select an arbitrary paragraph', () => {
  assert.equal(model.locateQuote('same sentence\n\nsame sentence', 'same sentence'), undefined)
  assert.equal(model.locateQuote('another sentence', 'absent evidence'), undefined)
  assert.equal(model.locateQuote('anything', ''), undefined)
})
test('a section includes its subheadings but excludes the following section', () => {
  const text = '# Methods\nSetup.\n## Sampling\nUsed observations.\n# Results\nThe lake increased.'
  const relation = {id:'r',from_paper:'A',to_paper:'B',from_quotes:['Used observations.']}
  const corpus = {bundle:{endpoint_map:{A:{'r-from':'method'}}},nodes:{A:{method:{heading:'Methods'}}}}
  const [methods, , results] = model.headings(text)
  assert.equal(model.relationInHeading(corpus,relation,'A',text,methods),true)
  assert.equal(model.relationInHeading(corpus,relation,'A',text,results),false)
})
test('content and companion note resolve to the same explicit paper identity', () => {
  const corpus = {bundle:{papers:{A:{source:'a_content.md',note:'a_notes.md',tree_path:'tree/A.md'}}}}
  assert.equal(model.paperForPath(corpus,'a_content.md'),'A')
  assert.equal(model.paperForPath(corpus,'a_notes.md'),'A')
  assert.equal(model.paperForPath(corpus,'unrelated/a_notes.md'),undefined)
  assert.equal(model.pairId('A','B'),model.pairId('B','A'))
})
test('navigation paths cannot escape the vault', () => {
  for (const path of ['/tmp/x','../x','nested/../../x','C:\\x','./x']) assert.equal(model.safeRelative(path),false)
  assert.equal(model.safeRelative('Demo/内容关系.canvas'),true)
})

// Codex (LLM agent): one component can contain several stable pair views.
test('paper pairs stay separate inside a component and retired selection resolves a pair', () => {
  const paper = k => ({source:`${k}_content.md`,note:`${k}_notes.md`,tree_path:`${k}_notes.md`})
  const component = {papers:['A','B','C'],revision:2,relationship:'network/relationship/component-A.canvas'}
  const pair = (a,b,r) => ({papers:[a,b],revision:1,path:`network/connecting/pair-${a}-${b}.canvas`,relations:[r]})
  const ab=pair('A','B','ab'), bc=pair('B','C','bc')
  const corpus={version:1,bundle:{papers:{A:paper('A'),B:paper('B'),C:paper('C')},
    relations:[{id:'ab',from_paper:'A',to_paper:'B'},{id:'bc',from_paper:'B',to_paper:'C'}],
    endpoint_map:{A:{'ab-from':'m'},B:{'ab-to':'m','bc-from':'m'},C:{'bc-to':'m'}}},
    nodes:{A:{m:{}},B:{m:{}},C:{m:{}}},sourceHashes:{},forest:{version:2,components:{cA:component},
      pairs:{'pair-A-B':ab,'pair-B-C':bc},paper_component:{A:'cA',B:'cA',C:'cA'},
      redirects:{'network/文献总览.canvas':[component.relationship],
        'network/connecting/old.canvas':[ab.path,bc.path]}}}
  const parsed=model.parseCorpus(JSON.stringify(corpus))
  assert.deepEqual(model.componentView(parsed,'B').papers,['A','B','C'])
  assert.deepEqual(model.pairView(parsed,'B','A').papers,['A','B'])
  assert.equal(model.pairView(parsed,'A','C'),undefined)
  assert.equal(model.canonicalView(parsed,{kind:'pair',papers:['A','B'],path:'old.canvas'}).path,ab.path)
  assert.throws(()=>model.canonicalView(parsed,{kind:'work',papers:['A','B','C']}),/请选择/)
  const previous={path:'network/connecting/old.canvas',selection:['bc'],viewport:{x:1,y:2,zoom:1}}
  assert.equal(model.redirectPosition(parsed,previous).path,bc.path)
  assert.equal(model.redirectPosition(parsed,previous).viewport,undefined)
  assert.equal(model.redirectPosition(parsed,{...previous,selection:['demo-root-B']}).path,previous.path)
  assert.equal(model.redirectPosition(parsed,{...previous,selection:['demo-root-A','demo-root-B']}).path,ab.path)
  parsed.forest.pairs['pair-A-B'].relations.push('bc')
  assert.throws(()=>model.parseCorpus(JSON.stringify(parsed)),/归属不一致/)
})

// Codex (LLM agent): remote catalogs never imply that content was downloaded.
const remoteBuild=await build({entryPoints:['src/literature-navigation/remote.ts'],bundle:true,write:false,platform:'node',format:'esm',
  plugins:[{name:'remote-http',setup(build){build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'test'}));
    build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const requestUrl=()=>{throw Error("Unexpected transport call")}',loader:'js'}))}}]})
const {RemoteCorpus}=await import('data:text/javascript;base64,'+Buffer.from(remoteBuild.outputFiles[0].text).toString('base64'))
function remoteFixture() {
  let revision='v1'
  const calls=[]
  const papers=Object.fromEntries(['A','B','C'].map(k=>[k,{title:k,authors:['Author'],source:k+'_content.md',note:k+'_notes.md',tree_path:k+'_notes.md'}]))
  const forest={version:2,components:{one:{papers:['A','B','C'],revision:1,relationship:'network/relationship/one.canvas'}},
    pairs:{'pair-A-B':{papers:['A','B'],relations:['ab'],revision:1,path:'network/connecting/pair-A-B.canvas'},
      'pair-B-C':{papers:['B','C'],relations:['bc'],revision:1,path:'network/connecting/pair-B-C.canvas'}},paper_component:{A:'one',B:'one',C:'one'},redirects:{}}
  const call=async(name,args)=>{
    calls.push({name,args})
    if(args.revision && args.revision!==revision)throw Error('STALE_REVISION')
    if(name==='litnet_status')return {revision}
    if(name==='litnet_catalog')return {revision,papers,forest,page:{total:3,next_offset:null}}
    if(name==='litnet_query') {
      const second=args.offset>0,id=second?'bc':'ab',a=second?'B':'A',b=second?'C':'B'
      return {revision,papers,nodes:{[a]:{m:{label:'Methods',parent:null}},[b]:{m:{label:'Methods',parent:null}}},
        endpoint_map:{[a]:{[id+'-from']:'m'},[b]:{[id+'-to']:'m'}},source_hashes:{},
        relations:[{id,from_paper:a,to_paper:b,type:'same_method',...(args.include_evidence?{from_quote:'evidence'}:{})}],
        page:{total:2,next_offset:second?null:100}}
    }
    throw Error(name)
  }
  return {calls,call,remote:new RemoteCorpus(call),change:()=>{revision='v2'}}
}
test('remote navigation downloads paged scopes once and drops caches on revision change',async()=>{
  const f=remoteFixture(),scope={kind:'paper',paper_ids:['B']}
  assert.equal(await f.remote.sync(),true)
  assert.equal(f.remote.corpus.bundle.relations.length,0)
  assert.equal(f.calls.some(c=>c.name==='litnet_query'),false)
  await Promise.all([f.remote.hydrate(scope),f.remote.hydrate(scope)])
  assert.equal(f.calls.filter(c=>c.name==='litnet_query').length,2)
  assert.equal(f.remote.corpus.bundle.relations.length,2)
  assert(f.calls.filter(c=>c.name==='litnet_query').every(c=>c.args.scope===scope))
  await f.remote.hydrate(scope,true)
  assert.equal(f.remote.corpus.bundle.relations[0].from_quote,'evidence')
  f.change();assert.equal(await f.remote.sync(true),true)
  assert.equal(f.remote.corpus.bundle.relations.length,0)
  await f.remote.hydrate(scope)
  assert.equal(f.calls.at(-1).args.revision,'v2')
})
test('a server revision change during pagination cannot mix fragments',async()=>{
  const f=remoteFixture()
  const remote=new RemoteCorpus(async(name,args)=>{
    const value=await f.call(name,args)
    if(name==='litnet_query'&&args.offset===0)f.change()
    return value
  })
  await remote.sync()
  await assert.rejects(remote.hydrate({kind:'paper',paper_ids:['B']}),/STALE_REVISION/)
  assert.equal(remote.corpus.bundle.relations.length,0)
})
test('remote mode preserves local Canvas generation jobs without running or recreating files',async t=>{
  const {controller}=await navigationController(t)
  const f=remoteFixture();await f.remote.sync()
  controller.remote=f.remote;controller.corpus=f.remote.corpus;controller.config={root:'network'}
  controller.state.jobs=[{id:'old',status:'pending'}]
  controller.plugin.app.vault.getAbstractFileByPath=()=>undefined
  await controller.work()
  assert.equal(controller.state.jobs[0].status,'pending')
  await assert.rejects(controller.ensure(model.pairView(controller.corpus,'A','B')),/尚未同步/)
  assert.deepEqual(controller.neighborCandidates({papers:['A','B']}),['C'])
})

// Codex (LLM agent): verify the real MCP client against a local HTTP transport.
test('MCP client authenticates, initializes once, and closes its pooled connections',async t=>{
  const {createRequire}=await import('node:module')
  const {createServer}=await import('node:http')
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises')
  const {tmpdir}=await import('node:os')
  const {join}=await import('node:path')
  const previous=globalThis.require;globalThis.require=createRequire(import.meta.url)
  const folder=await mkdtemp(join(tmpdir(),'litnet-client-'))
  const tokenFile=join(folder,'token');await writeFile(tokenFile,'t'.repeat(40),{mode:0o600})
  const methods=[],sockets=new Set()
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+'t'.repeat(40))
    const chunks=[];for await(const chunk of req)chunks.push(chunk)
    const body=JSON.parse(Buffer.concat(chunks).toString());methods.push(body.method)
    if(body.method==='notifications/initialized'){assert.equal(body.id,undefined);res.writeHead(202);res.end();return}
    const result=body.method==='initialize'?{serverInfo:{name:'litnet'}}:{content:[{type:'text',text:JSON.stringify({ok:true})}]}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}))
  })
  server.on('connection',socket=>sockets.add(socket))
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const {mcpCall}=await import('data:text/javascript;base64,'+Buffer.from(remoteBuild.outputFiles[0].text).toString('base64'))
  const call=mcpCall({url:`http://127.0.0.1:${server.address().port}/mcp`,tokenFile})
  t.after(async()=>{call.dispose();await new Promise(r=>server.close(r));await rm(folder,{recursive:true});if(previous)globalThis.require=previous;else delete globalThis.require})
  assert.deepEqual(await call('litnet_status',{}),{ok:true})
  assert.deepEqual(await call('litnet_status',{}),{ok:true})
  assert.deepEqual(methods,['initialize','notifications/initialized','tools/call','tools/call'])
  assert.equal(sockets.size,1)
})
