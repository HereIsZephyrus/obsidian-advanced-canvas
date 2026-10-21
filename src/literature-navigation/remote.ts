// Codex (LLM agent): query one revision of Litnet without a synchronized corpus file.
import {safeRelative, pairId, type Corpus, type Forest, type Paper, type Relation} from './model'
export type RemoteConfig = {url: string; tokenFile: string}
type Page = {next_offset: number | null; total: number}
type Catalog = {revision: string; papers: Record<string, Paper>; forest?: Forest; page: Page}
export type Scope = {kind: 'paper' | 'pair' | 'node'; paper_ids: string[]; node_id?: string}
type Fragment = {revision: string; papers: Record<string, Paper>; nodes: Corpus['nodes']; endpoint_map: Corpus['bundle']['endpoint_map']; relations: Relation[]; source_hashes: Record<string,string>; page: Page}
type Call = {<T>(name: string, args: Record<string,unknown>): Promise<T>; dispose?: () => void}

export function mcpCall(config: RemoteConfig): Call {
  const endpoint = new URL(config.url)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1','localhost','192.168.1.18'].includes(endpoint.hostname)))
    throw new Error('Litnet 需要 HTTPS 或本机/center 地址')
  if (!config.tokenFile.startsWith('/') || endpoint.username || endpoint.password) throw new Error('Litnet 凭据配置无效')
  const http = require('http') as typeof import('http'), https = require('https') as typeof import('https')
  const transport = endpoint.protocol === 'https:' ? https : http
  const agent = endpoint.protocol === 'https:' ? new https.Agent({keepAlive:true}) : new http.Agent({keepAlive:true})
  let initialized: Promise<void> | undefined, id = 0
  const rpc = async (method: string, params: object, notification = false) => {
    const {readFile} = require('fs/promises') as typeof import('fs/promises')
    const token = (await readFile(config.tokenFile, 'utf8')).trim()
    if (!token || /\s/.test(token)) throw new Error('Litnet 读取凭据失败')
    // Direct TLS avoids the desktop proxy transport's unbounded pending requests.
    const response = await new Promise<{status:number;json:any}>((resolve,reject) => {
      const request = transport.request(endpoint, {method:'POST',agent,family:4,
        headers:{Authorization:`Bearer ${token}`, Accept:'application/json, text/event-stream',
          'Content-Type':'application/json', 'MCP-Protocol-Version':'2025-11-25'}}, response => {
        const chunks: Buffer[]=[]
        let size=0
        response.on('data', (chunk: Buffer) => {
          size+=chunk.length
          if (size>16*1024*1024) request.destroy(new Error('Litnet 响应超过大小限制'))
          else chunks.push(chunk)
        })
        response.on('error',reject)
        response.on('end',()=>{
          clearTimeout(timer)
          try {resolve({status:response.statusCode || 0,json:notification ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))})}
          catch {reject(new Error(`Litnet HTTP ${response.statusCode}：响应格式无效`))}
        })
      })
      const timer=setTimeout(()=>request.destroy(new Error('Litnet 请求超时，请重试')),20000)
      request.on('error',error=>{clearTimeout(timer);reject(error)})
      request.end(JSON.stringify({jsonrpc:'2.0', ...(notification ? {} : {id:++id}), method, params}))
    })
    if (response.status < 200 || response.status >= 300) throw new Error(`Litnet HTTP ${response.status}`)
    if (notification) return
    const result = response.json
    if (result.error) throw new Error(result.error.message || 'Litnet 协议错误')
    return result.result
  }
  const call: Call = async <T>(name: string, args: Record<string,unknown>): Promise<T> => {
    if (!initialized) initialized = (async () => {
      await rpc('initialize', {protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'advanced-canvas-litnet',version:'1'}})
      await rpc('notifications/initialized', {}, true)
    })().catch(error => {initialized=undefined;throw error})
    await initialized
    const response = await rpc('tools/call',{name,arguments:args})
    if (response?.isError) throw new Error(response.content?.find((c: {type:string})=>c.type==='text')?.text || 'Litnet 查询失败')
    return (response.structuredContent ?? JSON.parse(response.content.find((c: {type:string})=>c.type==='text').text)) as T
  }
  call.dispose=()=>agent.destroy()
  return call
}

export class RemoteCorpus {
  corpus?: Corpus
  revision?: string
  private checked = 0
  private retryAfter = 0
  private syncing?: Promise<boolean>
  private scopes = new Map<string, Promise<void>>()
  constructor(private call: Call) {}
  dispose() {this.call.dispose?.()}
  async sync(force = false): Promise<boolean> {
    if (this.syncing) return this.syncing
    if (!force && Date.now() < this.retryAfter) return false
    if (!force && this.corpus && Date.now() - this.checked < 15000) return false
    this.syncing = this.synchronize()
    try {return await this.syncing} catch (error) {this.retryAfter=Date.now()+15000;throw error} finally {this.syncing=undefined}
  }
  private async synchronize(): Promise<boolean> {
    const status = await this.call<{revision: string}>('litnet_status', {})
    if (status.revision === this.revision) {this.checked=Date.now();return false}
    // Install a complete metadata catalog atomically; content remains scoped.
    const papers: Record<string,Paper> = {}
    let forest: Forest | undefined, offset: number | null = 0
    while (offset !== null) {
      const page: Catalog = await this.call('litnet_catalog', {offset,limit:500,revision:status.revision})
      if (page.revision !== status.revision) throw new Error('Litnet 返回了不同版本的目录')
      for (const [key,paper] of Object.entries(page.papers)) {
        if (![paper.source,paper.note,paper.tree_path].every(safeRelative)) throw new Error('Litnet 文献路径无效')
        papers[key]=paper
      }
      if (page.forest) forest=page.forest
      if (page.page.next_offset !== null && page.page.next_offset <= offset) throw new Error('Litnet 分页没有前进')
      offset=page.page.next_offset
    }
    if (forest?.version !== 2 || !forest.pairs || !forest.paper_component || !forest.redirects) throw new Error('Litnet 森林索引不完整')
    for (const [id,component] of Object.entries(forest.components)) {
      if (!safeRelative(component.relationship) || !component.relationship.startsWith('network/relationship/') ||
          component.papers.some(k=>!papers[k] || forest!.paper_component[k]!==id)) throw new Error('Litnet 文献网络归属无效')
    }
    if (Object.keys(papers).some(k=>!forest!.components[forest!.paper_component[k]]?.papers.includes(k))) throw new Error('Litnet 文献缺少网络归属')
    for (const [id,pair] of Object.entries(forest.pairs)) {
      if (pair.papers.length!==2 || pair.papers.some(k=>!papers[k]) || id!==pairId(pair.papers[0],pair.papers[1]) ||
          pair.path!==`network/connecting/${id}.canvas`) throw new Error('Litnet 文献对路径无效')
    }
    this.corpus={version:1,bundle:{papers,relations:[],endpoint_map:Object.fromEntries(Object.keys(papers).map(k=>[k,{}]))},
      nodes:Object.fromEntries(Object.keys(papers).map(k=>[k,{}])),sourceHashes:{},forest}
    this.revision=status.revision
    this.scopes.clear()
    this.checked=Date.now()
    return true
  }
  async hydrate(scope: Scope, includeEvidence=false): Promise<void> {
    await this.sync()
    if (!this.corpus) throw new Error('Litnet 服务暂不可用')
    const key=JSON.stringify([this.revision,scope,includeEvidence])
    const existing=this.scopes.get(key)
    if (existing) return existing
    const pending=this.fetchScope(scope,includeEvidence).catch(error=>{this.scopes.delete(key);throw error})
    this.scopes.set(key,pending)
    return pending
  }
  private async fetchScope(scope: Scope, includeEvidence: boolean): Promise<void> {
    const revision=this.revision, target=this.corpus!
    const fragments: Fragment[]=[]
    let offset: number | null=0
    while (offset!==null) {
      const fragment: Fragment=await this.call('litnet_query',{scope,offset,limit:100,revision,include_evidence:includeEvidence})
      if (fragment.revision!==revision) throw new Error('STALE_REVISION: Litnet 数据已更新')
      fragments.push(fragment)
      if (fragment.page.next_offset!==null && fragment.page.next_offset<=offset) throw new Error('Litnet 分页没有前进')
      offset=fragment.page.next_offset
    }
    if (revision!==this.revision || target!==this.corpus) throw new Error('STALE_REVISION: Litnet 数据已更新')
    const relations=new Map(target.bundle.relations.map(r=>[r.id,r]))
    for (const fragment of fragments) {
      for (const r of fragment.relations) for (const side of ['from','to'] as const) {
        const paper=r[`${side}_paper`], nid=fragment.endpoint_map[paper]?.[`${r.id}-${side}`]
        if (!target.bundle.papers[paper] || !nid || !fragment.nodes[paper]?.[nid]) throw new Error('Litnet 关系端点不完整')
      }
      for (const [k,nodes] of Object.entries(fragment.nodes)) target.nodes[k]={...target.nodes[k],...nodes}
      for (const [k,endpoints] of Object.entries(fragment.endpoint_map)) target.bundle.endpoint_map[k]={...target.bundle.endpoint_map[k],...endpoints}
      Object.assign(target.sourceHashes,fragment.source_hashes)
      for (const r of fragment.relations) relations.set(r.id,{...relations.get(r.id),...r})
    }
    target.bundle.relations=[...relations.values()]
  }
  async evidence(id: string): Promise<Relation> {
    const revision=this.revision
    const result=await this.call<{revision:string;relation:Relation;sources:Record<string,{path:string;sha256:string}>}>('litnet_evidence',{relation_id:id,revision})
    if (this.revision!==revision || result.revision!==revision) throw new Error('STALE_REVISION: Litnet 数据已更新，请重试')
    for (const source of Object.values(result.sources)) this.corpus!.sourceHashes[source.path]=source.sha256
    const index=this.corpus!.bundle.relations.findIndex(r=>r.id===id)
    if (index>=0) this.corpus!.bundle.relations[index]=result.relation
    return result.relation
  }
}
