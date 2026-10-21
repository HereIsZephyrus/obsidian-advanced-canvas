// Implemented by Codex (LLM agent): stable identities and read-only source locators.
import {relationStyles} from './presentation'
export const NAV_VIEW = 'literature-navigation'
export const STORE = '.literature-navigation'
export type Paper = {
  title: string; source: string; note: string; tree_path: string
  authors: string[]; year?: number; heading_catalog: {id: string; title: string}[]
}
export type Relation = {
  id: string; from_paper: string; to_paper: string; type: string
  label: string; explanation: string
  from_quotes?: string[]; to_quotes?: string[]; from_quote?: string; to_quote?: string
}
export type Corpus = {
  version: number
  bundle: {papers: Record<string, Paper>; relations: Relation[]; endpoint_map: Record<string, Record<string, string>>}
  nodes: Record<string, Record<string, {label: string; heading: string; parent: string | null; kind: string}>>
  sourceHashes: Record<string, string>
  forest?: Forest
}
// Codex (LLM agent): paper components and direct paper pairs have separate identities.
export type Forest = {
  version: number
  components: Record<string, {papers: string[]; revision: number; relationship: string; connecting?: string}>
  pairs?: Record<string, {papers: string[]; revision: number; path: string; relations: string[]}>
  paper_component: Record<string, string>
  redirects: Record<string, string[]>
}
export type ViewSpec = {
  id: string; kind: 'overview' | 'pair' | 'work'; path: string
  papers: string[]; revision: number; relations?: string[]; lastJob?: string
  presentationVersion?: number
  component?: string; layer?: 'relationship' | 'connecting'
}
export type NavPosition = {
  path: string; viewport?: {x: number; y: number; zoom: number}
  selection?: string[]; state?: Record<string, unknown>
}
export type Job = {id: string; view: ViewSpec; basePath?: string; status: 'pending' | 'running' | 'done' | 'failed'; error?: string}
export type NavState = {version: number; views: Record<string, ViewSpec>; jobs: Job[]; history: NavPosition[]; positions?: Record<string, NavPosition>}
export type Config = {version: number; root: string; python: string; tools: string; corpus: string}
// Codex (LLM agent): reject incomplete external corpus updates before replacing live data.
export function parseCorpus(text: string): Corpus {
  const value = JSON.parse(text) as Corpus
  if (value?.version !== 1 || !value.bundle?.papers || !Array.isArray(value.bundle.relations) ||
      !value.bundle.endpoint_map || !value.nodes || !value.sourceHashes) throw new Error('文献语料结构不完整')
  for (const [key, paper] of Object.entries(value.bundle.papers)) {
    if (!value.nodes[key] || !value.bundle.endpoint_map[key] ||
        ![paper.source, paper.note, paper.tree_path].every(p => typeof p === 'string' && safeRelative(p)))
      throw new Error(`文献路径或树节点无效：${key}`)
  }
  const ids = new Set<string>()
  for (const relation of value.bundle.relations) {
    if (!relation.id || ids.has(relation.id)) throw new Error('文献关系 ID 重复或缺失')
    ids.add(relation.id)
    for (const side of ['from', 'to'] as const) {
      const paper = relation[`${side}_paper`], node = value.bundle.endpoint_map[paper]?.[`${relation.id}-${side}`]
      if (!value.bundle.papers[paper] || !node || !value.nodes[paper]?.[node]) throw new Error(`文献关系端点缺失：${relation.id}`)
    }
  }
  if (value.forest) {
    const forest = value.forest, covered = new Set<string>()
    if (![1, 2].includes(forest.version) || (forest.version === 2 && !forest.pairs) || !forest.components || !forest.paper_component || !forest.redirects)
      throw new Error('文献森林索引不完整')
    for (const [id, component] of Object.entries(forest.components)) {
      if (!component.papers.length || !(forest.version === 1 ? ['relationship', 'connecting'] as const : ['relationship'] as const).every(layer =>
        typeof component[layer] === 'string' && safeRelative(component[layer]) && component[layer].startsWith(`network/${layer}/`)))
        throw new Error('文献网络路径无效')
      for (const key of component.papers) {
        if (!value.bundle.papers[key] || covered.has(key) || forest.paper_component[key] !== id)
          throw new Error('文献网络归属不一致')
        covered.add(key)
      }
    }
    if (covered.size !== Object.keys(value.bundle.papers).length || value.bundle.relations.some(r =>
      forest.paper_component[r.from_paper] !== forest.paper_component[r.to_paper])) throw new Error('文献网络分组不完整')
    if (forest.version === 2) {
      const expected = new Map<string, string[]>()
      for (const r of value.bundle.relations) {
        const id = pairId(r.from_paper, r.to_paper)
        expected.set(id, [...(expected.get(id) || []), r.id])
      }
      if (expected.size !== Object.keys(forest.pairs!).length) throw new Error('文献对索引不完整')
      for (const [id, pair] of Object.entries(forest.pairs!)) {
        if (pair.papers.length !== 2 || pair.papers[0] === pair.papers[1] || pairId(...pair.papers as [string,string]) !== id ||
            pair.path !== `network/connecting/${id}.canvas` ||
            pair.papers.some(k => !value.bundle.papers[k]) ||
            JSON.stringify([...pair.relations].sort()) !== JSON.stringify(expected.get(id)?.sort()))
          throw new Error('文献对归属不一致')
      }
    }
  }
  return value
}
export function componentView(corpus: Corpus, paper: string, layer: 'relationship' | 'connecting' = 'relationship'): ViewSpec | undefined {
  const forest = corpus.forest, id = forest?.paper_component[paper], component = id && forest?.components[id]
  if (!component || (layer === 'connecting' && !component.connecting)) return
  return {id: `${id}-${layer}`, component: id, layer, kind: layer === 'relationship' ? 'overview' : 'work',
    path: component[layer]!, papers: [...component.papers], revision: component.revision}
}
export function pairView(corpus: Corpus, a: string, b: string): ViewSpec | undefined {
  const id = pairId(a,b), pair = corpus.forest?.pairs?.[id]
  if (!pair) return
  return {id, layer: 'connecting', kind: 'pair', path: pair.path, papers: [...pair.papers],
    relations: [...pair.relations], revision: pair.revision}
}
export function canonicalView(corpus: Corpus, view: ViewSpec, paper?: string): ViewSpec {
  if (!corpus.forest) return view
  const key = paper || view.papers.find(p => corpus.forest!.paper_component[p])
  const result = view.kind === 'overview' ? key && componentView(corpus, key) :
    corpus.forest.version === 1 ? key && componentView(corpus, key, 'connecting') :
    view.papers.length === 2 && pairView(corpus, view.papers[0], view.papers[1])
  if (!result) throw new Error('请选择一条文献间连线打开内容关系')
  if (result.id === view.id && result.path === view.path && JSON.stringify(result.papers) === JSON.stringify(view.papers)) {
    result.revision = Math.max(result.revision, view.revision)
    result.lastJob = view.lastJob
  }
  return result
}
export function redirectPosition(corpus: Corpus, position: NavPosition): NavPosition {
  const targets = corpus.forest?.redirects[position.path]
  if (!targets?.length) return position
  const selected = position.selection || []
  const keys = Object.keys(corpus.bundle.papers).filter(k => selected.some(id =>
    id === `paper-${k}` || id === `demo-root-${k}` || id.startsWith(`demo-${k}-`)))
  const edgePairs = new Set(corpus.bundle.relations.filter(r => selected.includes(r.id) || selected.includes(pairId(r.from_paper,r.to_paper)))
    .map(r => pairId(r.from_paper,r.to_paper)))
  const candidates = targets.filter(path => {
    const pair = Object.entries(corpus.forest!.pairs || {}).find(([, p]) => p.path === path)
    if (pair) return edgePairs.size ? edgePairs.has(pair[0]) : keys.length > 0 && keys.every(k => pair[1].papers.includes(k))
    return keys.some(k => corpus.forest!.components[corpus.forest!.paper_component[k]]?.relationship === path)
  })
  const path = targets.length === 1 ? targets[0] : candidates.length === 1 ? candidates[0] : undefined
  // An ambiguous retired content view cannot silently choose one of its paper pairs.
  return path ? {...position, path, viewport: undefined} : position
}
export const relationLabels: Record<string, string> = Object.fromEntries(relationStyles.map(s => [s.type, s.label]))
export function pairId(a: string, b: string): string { return `pair-${[a, b].sort().join('-')}` }
export function paperForPath(corpus: Corpus, path: string): string | undefined {
  return Object.keys(corpus.bundle.papers).find(key => {
    const p = corpus.bundle.papers[key]
    return [p.source, p.note, p.tree_path].includes(path)
  })
}

// Implemented by Codex (LLM agent): a note and its embedded tree can share one path.
export function renamePaperPaths(corpus: Corpus, replace: (path: string) => string): boolean {
  let changed = false
  for (const paper of Object.values(corpus.bundle.papers)) for (const field of ['source', 'note', 'tree_path'] as const) {
    const old = paper[field], next = replace(old)
    if (next === old) continue
    if (Object.prototype.hasOwnProperty.call(corpus.sourceHashes, old)) {
      corpus.sourceHashes[next] = corpus.sourceHashes[old]
      delete corpus.sourceHashes[old]
    }
    paper[field] = next
    changed = true
  }
  return changed
}
export function relationsFor(corpus: Corpus, paper: string): Relation[] {
  return corpus.bundle.relations.filter(r => r.from_paper === paper || r.to_paper === paper)
}
export function sideFor(r: Relation, paper: string): 'from' | 'to' { return r.from_paper === paper ? 'from' : 'to' }
export function endpoint(corpus: Corpus, r: Relation, side: 'from' | 'to'): string {
  return corpus.bundle.endpoint_map[r[`${side}_paper`]][`${r.id}-${side}`]
}
export function quotes(r: Relation, side: 'from' | 'to'): string[] {
  return [...new Set([...(r[`${side}_quotes`] || []), r[`${side}_quote`] || ''].filter(Boolean))]
}
export function shortAuthor(p: Paper): string {
  const first = p.authors?.[0]?.replace(/^\[\[|\]\]$/g, '').split('|').pop()?.split('/').pop() || 'Unknown author'
  return `${first}${p.authors?.length > 1 ? ' et al.' : ''}${p.year ? ` (${p.year})` : ''}`
}
export type Heading = {title: string; start: number; end: number; level: number}
export function headings(text: string): Heading[] {
  const all: Heading[] = []
  const pattern = /^(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) all.push({title: match[2], start: match.index, end: text.length, level: match[1].length})
  for (let i = 0; i < all.length; i++) all[i].end = all.slice(i + 1).find(h => h.level <= all[i].level)?.start ?? text.length
  return all
}
export function headingAt(text: string, offset: number): Heading | undefined {
  return headings(text).filter(h => h.start <= offset && h.end > offset).pop()
}
export type Located = {start: number; end: number; status: 'exact' | 'whitespace'}
function normalized(text: string) {
  let value = ''
  const starts: number[] = [], ends: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      const start = i
      while (i + 1 < text.length && /\s/.test(text[i + 1])) i++
      value += ' '; starts.push(start); ends.push(i + 1)
    } else { value += text[i]; starts.push(i); ends.push(i + 1) }
  }
  return {value, starts, ends}
}
// Never choose the first occurrence of an ambiguous quotation.
export function locateQuote(text: string, quote: string): Located | undefined {
  if (!quote.trim()) return
  const start = text.indexOf(quote)
  if (start >= 0 && text.indexOf(quote, start + 1) < 0) return {start, end: start + quote.length, status: 'exact'}
  const n = normalized(text), q = quote.replace(/\s+/g, ' ').trim(), at = n.value.indexOf(q)
  if (at < 0 || n.value.indexOf(q, at + 1) >= 0) return
  return {start: n.starts[at], end: n.ends[at + q.length - 1], status: 'whitespace'}
}
export function relationInHeading(corpus: Corpus, r: Relation, paper: string, text: string, heading: Heading): boolean {
  const side = sideFor(r, paper)
  const found = quotes(r, side).map(q => locateQuote(text, q)).filter((r): r is Located => !!r)
  if (found.length) return found.some(p => p.start >= heading.start && p.start < heading.end)
  const node = corpus.nodes[paper]?.[endpoint(corpus, r, side)]
  return !!node?.heading && node.heading === heading.title
}
export function safeRelative(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(p => p === '..' || p === '.')
}
