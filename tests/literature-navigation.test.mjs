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

// Codex (LLM agent): navigation follows connected components through merges and splits.
test('forest layers share membership and retired paths resolve by selected paper', () => {
  const paper = k => ({source:`${k}_content.md`,note:`${k}_notes.md`,tree_path:`${k}_notes.md`})
  const component = (id,papers) => ({papers,revision:2,relationship:`network/relationship/${id}.canvas`,connecting:`network/connecting/${id}.canvas`})
  const a=component('cA',['A','B']), c=component('cC',['C'])
  const corpus={version:1,bundle:{papers:{A:paper('A'),B:paper('B'),C:paper('C')},relations:[],endpoint_map:{A:{},B:{},C:{}}},
    nodes:{A:{},B:{},C:{}},sourceHashes:{},forest:{version:1,components:{cA:a,cC:c},paper_component:{A:'cA',B:'cA',C:'cC'},
      redirects:{'network/文献总览.canvas':[a.relationship,c.relationship],'network/connecting/old.canvas':[a.connecting]}}}
  const parsed=model.parseCorpus(JSON.stringify(corpus))
  for(const layer of ['relationship','connecting']) assert.deepEqual(model.componentView(parsed,'B',layer).papers,['A','B'])
  assert.equal(model.canonicalView(parsed,{kind:'pair',papers:['A','B'],path:'old.canvas'}).path,a.connecting)
  const previous={path:'network/文献总览.canvas',selection:['paper-C'],viewport:{x:1,y:2,zoom:1}}
  assert.equal(model.redirectPosition(parsed,previous).path,c.relationship)
  assert.equal(model.redirectPosition(parsed,previous).viewport,undefined)
  assert.equal(model.redirectPosition(parsed,{path:'network/connecting/old.canvas'}).path,a.connecting)
  assert.equal(model.redirectPosition(parsed,{path:'network/文献总览.canvas'}).path,'network/文献总览.canvas')
  parsed.forest.components.cC.papers.push('A')
  assert.throws(()=>model.parseCorpus(JSON.stringify(parsed)),/归属不一致/)
})
