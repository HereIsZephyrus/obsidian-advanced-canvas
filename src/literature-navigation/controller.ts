// Implemented by Codex (LLM agent): bidirectional literature navigation in configured vaults.
import { ItemView, MarkdownView, Notice, TFile, TAbstractFile, WorkspaceLeaf, Platform, FuzzySuggestModal } from 'obsidian'
import type { ChildProcess } from 'child_process'
import type AdvancedCanvasPlugin from '../main'
import type { Canvas, CanvasEdge, CanvasElement, CanvasView } from '../@types/Canvas'
import {measurePaper, OVERVIEW_VERSION, relationStyles} from './presentation'
import {serializeWrite, waitForWrites} from './save-queue'
import {overviewFocus} from './focus'
import {
  NAV_VIEW, STORE, type Corpus, type Config, type NavState, type NavPosition, type ViewSpec, type Job,
  type Relation, type Heading, pairId, paperForPath, relationsFor, sideFor, endpoint, quotes,
  shortAuthor, headingAt, headings, locateQuote, relationInHeading, relationLabels, safeRelative, renamePaperPaths
} from './model'

type NodeData = {id: string; width?: number; height?: number; literatureCanvas?: {paper?: string; node?: string}}
type EdgeData = {id: string; fromNode: string; toNode: string; literatureNavigation?: {papers: string[]; relations: string[]}; literatureEvidence?: Relation}
type Drawing = {nodes: NodeData[]; edges: EdgeData[]; metadata?: {literatureNavigation?: ViewSpec}}
type Context = {paper?: string; node?: string; relations?: string[]; view?: ViewSpec; path?: string; heading?: Heading; text?: string}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const randomUUID = () => crypto.randomUUID()
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
  .map(byte => byte.toString(16).padStart(2, '0')).join('')

class PaperPicker extends FuzzySuggestModal<string> {
  constructor(private controller: LiteratureNavigationController, private keys: string[], private choose: (key: string) => void) {
    super(controller.plugin.app)
    this.setPlaceholder('选择要加入当前阅读网络的文献')
  }
  getItems() { return this.keys }
  getItemText(key: string) { return this.controller.corpus!.bundle.papers[key].title }
  onChooseItem(key: string) { this.choose(key) }
}

class NavigationView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private controller: LiteratureNavigationController) { super(leaf) }
  getViewType() { return NAV_VIEW }
  getDisplayText() { return '文献关系' }
  getIcon() { return 'network' }
  async onOpen() { this.contentEl.addClass('literature-navigation-panel'); this.controller.render(this.contentEl) }
}

export default class LiteratureNavigationController {
  corpus?: Corpus
  config?: Config
  state: NavState = {version: 1, views: {}, jobs: [], history: []}
  ready: Promise<void>
  context: Context = {}
  private leaf?: WorkspaceLeaf
  private lastPosition?: NavPosition
  private disposed = false
  private running = false
  private navigating = 0
  private navigationIntent = 0
  private refreshSerial = 0
  private children = new Set<ChildProcess>()
  private waiters = new Map<string, {resolve: (view: ViewSpec) => void; reject: (e: Error) => void}[]>()
  private forks = new Map<string, string>()
  private timer?: number
  private positionTimer?: number
  private evidence?: {paper: string; relation: string; side: 'from' | 'to'; status: string; quote: string}
  private focus = new WeakMap<Canvas, ReturnType<typeof overviewFocus>>()

  constructor(public plugin: AdvancedCanvasPlugin) {
    plugin.registerView(NAV_VIEW, leaf => new NavigationView(leaf, this))
    plugin.addRibbonIcon('network', '文献关系', () => this.run(() => this.show()))
    plugin.addCommand({id: 'literature-relations', name: '文献关系：打开当前文献的关系', callback: () => this.run(() => this.show())})
    plugin.addCommand({id: 'literature-overview', name: '文献关系：打开文献总览', callback: () => this.run(() => this.openOverview())})
    plugin.addCommand({id: 'literature-refresh-overview', name: '文献关系：更新总览并保留位置', callback: () => this.run(() => this.refreshOverview())})
    plugin.addCommand({id: 'literature-back', name: '文献关系：返回刚才的网络', callback: () => this.run(() => this.back())})
    plugin.addCommand({id: 'literature-rebuild-index', name: '文献关系：重建视图索引', callback: () => this.run(async () => { await this.rebuild(); new Notice('视图索引已重建') })})
    plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', leaf => {
      if (leaf && leaf.view.getViewType() !== NAV_VIEW && 'file' in leaf.view) { this.leaf = leaf; this.schedule() }
    }))
    plugin.registerEvent(plugin.app.workspace.on('file-open', () => this.schedule()))
    plugin.registerEvent(plugin.app.workspace.on('editor-change', () => this.schedule()))
    plugin.registerEvent(plugin.app.workspace.on('advanced-canvas:selection-changed', (canvas: Canvas) => {
      if (canvas.view.file?.path === this.currentPath()) { this.highlight(canvas); this.schedule() }
    }))
    plugin.registerEvent(plugin.app.workspace.on('advanced-canvas:edge-changed', (canvas, edge) => this.styleEdge(canvas, edge)))
    plugin.registerEvent(plugin.app.workspace.on('advanced-canvas:viewport-changed:after', () => this.rememberPosition()))
    plugin.registerEvent(plugin.app.workspace.on('advanced-canvas:double-click', (canvas, event, prevent) => {
      const selected = [...canvas.selection]
      const edge = selected.length === 1 ? selected[0].getData() as unknown as EdgeData : undefined
      if (!edge?.literatureNavigation?.papers || this.spec(canvas)?.kind !== 'overview') return
      const element = selected[0] as CanvasElement & {lineGroupEl?: HTMLElement; labelElement?: {wrapperEl?: HTMLElement}}
      const target = event.target as Node
      if (!element.lineGroupEl?.contains(target) && !element.labelElement?.wrapperEl?.contains(target)) return
      prevent.value = true
      this.run(() => this.openPair(edge.literatureNavigation!.papers[0], edge.literatureNavigation!.papers[1], edge.literatureNavigation!.relations))
    }))
    plugin.registerEvent(plugin.app.workspace.on('editor-menu', (menu, _editor, view) => {
      if (this.corpus && view.file && paperForPath(this.corpus, view.file.path))
        menu.addItem(item => item.setTitle('查看本节文献关系').setIcon('network').onClick(() => this.run(() => this.show())))
    }))
    plugin.registerEvent(plugin.app.vault.on('rename', (file, old) => this.run(() => this.renamed(file.path, old))))
    plugin.registerEvent(plugin.app.vault.on('delete', file => {
      if (file.path === this.currentPath()) this.schedule()
      // Keep the descriptor so a removed generated view can be reconstructed.
      if (Object.values(this.state.views).some(v => v.path === file.path)) this.renderAll()
    }))
    const indexChanged = (file: TAbstractFile) => {
      if (file instanceof TFile && file.extension === 'canvas' && this.config && file.path.startsWith(this.config.root + '/'))
        this.run(() => this.indexFile(file))
      else if (file.path === this.currentPath()) this.schedule()
    }
    plugin.registerEvent(plugin.app.vault.on('create', indexChanged))
    plugin.registerEvent(plugin.app.vault.on('modify', indexChanged))
    plugin.registerDomEvent(document, 'mouseup', () => {
      if (this.leaf?.view instanceof MarkdownView) this.schedule()
    })
    plugin.registerDomEvent(document, 'keyup', () => {
      if (this.leaf?.view instanceof MarkdownView) this.schedule()
    })
    plugin.registerDomEvent(document, 'scroll', event => {
      if (this.leaf?.view instanceof MarkdownView && this.leaf.view.contentEl.contains(event.target as Node)) this.schedule()
    }, true)
    plugin.registerDomEvent(document, 'mousedown', event => {
      if (this.currentCanvas() && (event.target as HTMLElement).closest?.('a.internal-link')) this.lastPosition = this.capture()
    }, true)
    plugin.register(() => {
      this.disposed = true
      window.clearTimeout(this.timer); window.clearTimeout(this.positionTimer)
      this.children.forEach(child => child.kill())
      this.plugin.getCanvases().forEach(canvas => this.clearHighlight(canvas))
      this.plugin.app.workspace.getLeavesOfType(NAV_VIEW).forEach(leaf => leaf.detach())
    })
    this.ready = this.load()
  }
  private run(action: () => Promise<unknown>) {
    void action().catch(error => { if (!this.disposed) new Notice(`文献关系：${String(error.message || error)}`, 8000); console.error('[Literature navigation]', error) })
  }
  private basePath(): string {
    const adapter = this.plugin.app.vault.adapter as typeof this.plugin.app.vault.adapter & {getBasePath?: () => string}
    if (!adapter.getBasePath || !Platform.isDesktopApp) throw new Error('生成视图需要桌面版 Obsidian')
    return adapter.getBasePath()
  }
  private async load() {
    const adapter = this.plugin.app.vault.adapter
    if (!await adapter.exists(`${STORE}/config.json`)) return
    try {
      this.config = JSON.parse(await adapter.read(`${STORE}/config.json`)) as Config
      if (!safeRelative(this.config.root) || !safeRelative(this.config.corpus)) throw new Error('导航配置路径无效')
      this.corpus = JSON.parse(await adapter.read(this.config.corpus)) as Corpus
      if (this.corpus.version !== 1) throw new Error('不支持此导航数据版本')
      await waitForWrites(this.basePath())
      if (await adapter.exists(`${STORE}/state.json`)) this.state = JSON.parse(await adapter.read(`${STORE}/state.json`)) as NavState
      for (const job of this.state.jobs) if (job.status === 'running') job.status = 'pending'
      this.plugin.app.workspace.onLayoutReady(() => this.run(async () => {
        if (this.disposed) return
        await this.rebuild()
        this.leaf = this.plugin.app.workspace.getMostRecentLeaf() || undefined
        this.schedule()
        await this.work()
      }))
    } catch (error) { new Notice(`文献导航未加载：${String(error)}`, 10000) }
  }
  private async persist() {
    const body = JSON.stringify(this.state, null, 2)
    const base = this.basePath()
    return serializeWrite(base, async () => {
      if (this.disposed) return
      const {mkdir, writeFile, rename, rm} = require('fs/promises') as typeof import('fs/promises')
      const {join} = require('path') as typeof import('path')
      const target = join(base, STORE, 'state.json'), temporary = target + '.' + randomUUID() + '.tmp'
      await mkdir(join(base, STORE), {recursive: true})
      try {
        await writeFile(temporary, body, 'utf8')
        if (!this.disposed) await rename(temporary, target)
      } finally {await rm(temporary, {force: true})}
    })
  }
  private currentPath() { return (this.leaf?.view as unknown as {file?: TFile})?.file?.path }
  private currentCanvas(): Canvas | undefined { return this.leaf?.view.getViewType() === 'canvas' ? (this.leaf.view as unknown as CanvasView).canvas : undefined }
  private spec(canvas: Canvas): ViewSpec | undefined {
    const spec = (canvas.getData() as unknown as Drawing).metadata?.literatureNavigation
    return spec ? {...spec, path: canvas.view.file?.path || spec.path} : undefined
  }
  private capture(): NavPosition | undefined {
    const path = this.currentPath()
    if (!path || !this.leaf) return
    const canvas = this.currentCanvas()
    if (canvas) return {path, viewport: {x: canvas.tx, y: canvas.ty, zoom: canvas.tZoom}, selection: [...canvas.selection].map(e => e.id)}
    return {path, state: clone(this.leaf.getViewState().state || {})}
  }
  private rememberPosition() {
    window.clearTimeout(this.positionTimer)
    this.positionTimer = window.setTimeout(() => {
      if (!this.navigating && this.currentCanvas()) {
        this.lastPosition = this.capture()
        if (this.lastPosition) {
          this.state.positions ??= {}
          this.state.positions[this.lastPosition.path] = this.lastPosition
          this.run(() => this.persist())
        }
      }
    }, 300)
  }
  private pushPosition(position = this.capture()) {
    if (!position) return
    this.state.positions ??= {}
    this.state.positions[position.path] = position
    if (this.state.history.at(-1)?.path === position.path) this.state.history.pop()
    this.state.history.push(position)
    this.state.history = this.state.history.slice(-40)
  }
  private schedule() {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.run(() => this.refresh()), 100)
  }
  async refresh() {
    if (!this.corpus || this.disposed) return
    const serial = ++this.refreshSerial, path = this.currentPath()
    if (!this.navigating && this.lastPosition?.path !== path && this.lastPosition?.viewport) {
      this.pushPosition(this.lastPosition); void this.persist()
    }
    const canvas = this.currentCanvas(), context: Context = {path}
    if (canvas) {
      context.view = this.spec(canvas)
      const selected = [...canvas.selection]
      const selectedRelations = selected.map(element => element.getData() as unknown as EdgeData)
        .filter(data => data.literatureEvidence).map(data => data.id)
      if (selectedRelations.length) context.relations = selectedRelations
      if (selected.length === 1) {
        const data = selected[0].getData() as unknown as NodeData & EdgeData
        context.paper = data.literatureCanvas?.paper
        context.node = data.literatureCanvas?.node
        context.relations = data.literatureNavigation?.relations || (data.literatureEvidence ? [data.id] : undefined)
      }
      this.lastPosition = this.capture()
    } else if (path) {
      context.paper = paperForPath(this.corpus, path)
      const view = this.leaf?.view
      if (context.paper && path === this.corpus.bundle.papers[context.paper].source && view instanceof MarkdownView) {
        const text = await this.plugin.app.vault.cachedRead(view.file!)
        if (serial !== this.refreshSerial) return
        context.text = text
        let offset = view.editor.posToOffset(view.editor.getCursor())
        if (view.getMode() === 'preview') {
          const selection = window.getSelection()?.toString().trim()
          const located = selection ? locateQuote(text, selection) : undefined
          if (located) offset = located.start
          else {
            const top = view.contentEl.getBoundingClientRect().top + 90
            const visible = Array.from(view.contentEl.querySelectorAll('h1,h2,h3,h4,h5,h6'))
              .filter(h => h.getBoundingClientRect().top <= top)
            const title = visible.at(-1)?.textContent?.trim()
            const matches = title ? headings(text).filter(h => h.title === title) : []
            offset = matches.length === 1 ? matches[0].start : -1
          }
        }
        if (offset >= 0) context.heading = headingAt(text, offset)
      }
      this.lastPosition = this.capture()
    }
    if (serial !== this.refreshSerial) return
    this.context = context
    this.renderAll()
  }
  async show() {
    await this.ready
    const workspace = this.plugin.app.workspace
    const leaf = workspace.getLeavesOfType(NAV_VIEW)[0] || workspace.getRightLeaf(false)
    if (!leaf) return
    await leaf.setViewState({type: NAV_VIEW, active: false})
    await workspace.revealLeaf(leaf)
    await this.refresh()
  }
  private renderAll() {
    this.plugin.app.workspace.getLeavesOfType(NAV_VIEW).forEach(leaf => this.render((leaf.view as NavigationView).contentEl))
  }
  private button(parent: HTMLElement, label: string, action: () => Promise<unknown>, cls?: string) {
    const b = parent.createEl('button', {text: label, cls})
    b.onclick = () => this.run(action)
    return b
  }
  render(el: HTMLElement) {
    el.empty()
    el.createEl('h3', {text: '文献关系'})
    if (!this.corpus || !this.config) { el.createEl('p', {text: '当前 vault 尚未配置文献导航。'}); return }
    const top = el.createDiv('literature-nav-actions')
    this.button(top, '文献总览', () => this.openOverview(this.context.paper))
    this.button(top, '返回原视图', () => this.back()).disabled = !this.state.history.length
    const legend = el.createEl('details', {cls:'literature-nav-legend'})
    legend.createEl('summary', {text:'关系颜色'})
    for (const style of relationStyles) {
      const row=legend.createDiv('literature-nav-legend-row')
      row.createSpan({cls:'literature-nav-swatch',attr:{style:`background:${style.color}`}})
      row.createSpan({text:style.label})
    }
    legend.createEl('p',{text:'多类关系沿整条路径等长分色。',cls:'literature-nav-muted'})
    const context = this.context, paper = context.paper ? this.corpus.bundle.papers[context.paper] : undefined
    if (paper && context.paper) {
      el.createEl('h4', {text: paper.title})
      el.createEl('p', {text: shortAuthor(paper), cls: 'literature-nav-muted'})
      const actions = el.createDiv('literature-nav-actions')
      this.button(actions, '原文', () => this.openPaper(context.paper!, 'source'))
      this.button(actions, '精读笔记', () => this.openPaper(context.paper!, 'note'))
      this.button(actions, '文献树', () => this.openPaper(context.paper!, 'tree_path'))
      const canvas = this.currentCanvas(), selected = canvas ? [...canvas.selection] : []
      if (canvas && selected.length === 1 && canvas.nodes.has(selected[0].id))
        this.button(actions, '复制节点链接', async () => {
          await navigator.clipboard.writeText(`[[${canvas.view.file!.path}#${selected[0].id}|${paper.title}]]`)
          new Notice('节点链接已复制，可粘贴到笔记或另一张 Canvas')
        })
      if (context.path === paper.source && context.text) {
        const select = el.createEl('select', {cls: 'literature-nav-section', attr: {'aria-label': '筛选原文章节'}})
        select.createEl('option', {text: '整篇文献', value: ''})
        for (const h of headings(context.text)) select.createEl('option', {text: h.title, value: String(h.start)})
        select.value = context.heading ? String(context.heading.start) : ''
        select.onchange = () => { this.context.heading = headings(context.text!).find(h => String(h.start) === select.value); this.renderAll() }
      }
    } else if (context.view) {
      el.createEl('p', {text: context.view.kind === 'overview' ? '选择文献以高亮邻居；选择连线查看关联类型，双击连线进入内容网络。' : '选择节点或连线查看关系与证据。'})
    } else el.createEl('p', {text: '打开文献原文、精读笔记或文献树，即可查看关联。'})
    if (context.view?.kind && context.view.kind !== 'overview') {
      const current = context.view
      const actions = el.createDiv('literature-nav-actions')
      this.button(actions, '加入文献', async () => {
        const keys = this.neighborCandidates(current)
        if (!keys.length) { new Notice('当前范围没有更多相连文献'); return }
        new PaperPicker(this, keys, key => this.run(() => this.extend(current.id, key))).open()
      })
      this.button(actions, '复制视图链接', async () => { await navigator.clipboard.writeText(`[[${current.path}]]`); new Notice('视图链接已复制') })
      el.createEl('p', {text: `${current.papers.length} 篇文献 · ${current.kind === 'pair' ? '文献对视图' : '阅读网络'}`, cls: 'literature-nav-muted'})
    }
    let relations: Relation[] = []
    if (context.relations) relations = this.corpus.bundle.relations.filter(r => context.relations!.includes(r.id))
    else if (context.paper) {
      relations = relationsFor(this.corpus, context.paper)
      if (context.node) {
        const target = context.node
        relations = relations.filter(r => {
          let nid: string | null = endpoint(this.corpus!, r, sideFor(r, context.paper!))
          while (nid) { if (nid === target) return true; nid = this.corpus!.nodes[context.paper!][nid]?.parent || null }
          return false
        })
      } else if (context.heading && context.text) relations = relations.filter(r => relationInHeading(this.corpus!, r, context.paper!, context.text!, context.heading!))
    }
    if (context.paper || context.relations) {
      const types = new Map<string, number>()
      for (const r of relations) types.set(relationLabels[r.type] || r.type, (types.get(relationLabels[r.type] || r.type) || 0) + 1)
      el.createEl('p', {text: `${context.heading ? context.heading.title + ' · ' : ''}${relations.length} 条关系`, cls: 'literature-nav-count'})
      if (types.size) el.createEl('p', {text: [...types].map(([t, n]) => `${t} ${n}`).join(' · '), cls: 'literature-nav-muted'})
      if (!relations.length) el.createEl('p', {text: '当前范围没有已记录的关系。'})
      if (context.relations?.length) {
        const first = relations[0]
        if (first && context.view?.kind === 'overview') this.button(el, '打开内容关联', () => this.openPair(first.from_paper, first.to_paper, context.relations))
      }
      for (const relation of relations) this.renderRelation(el, relation, context.paper)
    }
    if (context.paper) {
      const views = Object.values(this.state.views).filter(v => v.kind !== 'overview' && v.papers.includes(context.paper!))
      if (views.length) {
        el.createEl('h4', {text: '已保存的内容视图'})
        for (const view of views) this.button(el, this.viewLabel(view), () => this.openSpec(view, [`demo-root-${context.paper}`]), 'literature-nav-view-link')
      }
    }
    if (this.evidence && context.paper === this.evidence.paper) {
      const box = el.createEl('details', {cls: 'literature-nav-evidence'})
      box.createEl('summary', {text: this.evidence.status})
      box.createEl('p', {text: this.evidence.quote})
    }
    const pending = this.state.jobs.filter(j => j.status === 'pending' || j.status === 'running')
    if (pending.length) el.createEl('p', {text: `生成队列：${pending.length} 项`, cls: 'literature-nav-status'})
    for (const job of this.state.jobs.filter(j => j.status === 'failed')) {
      const box = el.createDiv('literature-nav-error')
      box.createEl('p', {text: job.error || '视图生成失败'})
      this.button(box, '重试', async () => { job.status = 'pending'; job.error = undefined; await this.persist(); await this.work() })
    }
  }
  private renderRelation(el: HTMLElement, relation: Relation, paper?: string) {
    const box = el.createDiv('literature-nav-relation')
    const a = this.corpus!.bundle.papers[relation.from_paper], b = this.corpus!.bundle.papers[relation.to_paper]
    const other = paper === relation.from_paper ? b : a
    const connector = ['inherits', 'uses_result'].includes(relation.type) ? ' → ' : ' ↔ '
    box.createEl('strong', {text: relationLabels[relation.type] || relation.type})
    box.createEl('div', {text: paper ? other.title : `${shortAuthor(a)}${connector}${shortAuthor(b)}`, cls: 'literature-nav-relation-title'})
    box.createEl('p', {text: `${this.corpus!.nodes[relation.from_paper][endpoint(this.corpus!, relation, 'from')]?.label}${connector}${this.corpus!.nodes[relation.to_paper][endpoint(this.corpus!, relation, 'to')]?.label}`, cls: 'literature-nav-muted'})
    const actions = box.createDiv('literature-nav-actions')
    this.button(actions, '查看关系', () => this.openPair(relation.from_paper, relation.to_paper, [relation.id]))
    this.button(actions, `${shortAuthor(a)} 原文`, () => this.openEvidence(relation.id, 'from'))
    this.button(actions, `${shortAuthor(b)} 原文`, () => this.openEvidence(relation.id, 'to'))
    const details = box.createEl('details')
    details.createEl('summary', {text: '关联说明'})
    details.createEl('p', {text: relation.explanation || relation.label})
  }
  private viewLabel(view: ViewSpec): string {
    const names = view.papers.slice(0, 3).map(key => shortAuthor(this.corpus!.bundle.papers[key]))
    return names.join(' ↔ ') + (view.papers.length > 3 ? ` 等 ${view.papers.length} 篇` : '')
  }
  private clearHighlight(canvas: Canvas) {
    canvas.wrapperEl.classList.remove('literature-nav-overview', 'literature-nav-focus')
    this.focus.delete(canvas)
    for (const node of canvas.nodes.values()) node.nodeEl?.classList.remove('literature-nav-dim', 'literature-nav-neighbor')
    for (const edge of canvas.edges.values()) for (const element of [edge.lineGroupEl, edge.labelElement?.wrapperEl])
      element?.classList.remove('literature-nav-dim', 'literature-nav-neighbor', 'literature-nav-edge', 'literature-nav-edge-label', 'literature-nav-label-visible')
  }
  private highlight(canvas: Canvas) {
    this.clearHighlight(canvas)
    if (this.spec(canvas)?.kind !== 'overview') return
    canvas.wrapperEl.classList.add('literature-nav-overview')
    const focus = overviewFocus([...canvas.nodes.keys()], [...canvas.edges.values()].map(e=>e.getData()), [...canvas.selection].map(e=>e.id))
    this.focus.set(canvas, focus)
    canvas.wrapperEl.classList.toggle('literature-nav-focus',focus.focused)
    if (focus.focused) for (const node of canvas.nodes.values()) node.nodeEl?.classList.add(focus.neighbors.has(node.id) ? 'literature-nav-neighbor' : 'literature-nav-dim')
    for (const edge of canvas.edges.values()) this.styleEdge(canvas,edge)
  }
  private styleEdge(canvas: Canvas, edge: CanvasEdge) {
    if (!canvas.wrapperEl.classList.contains('literature-nav-overview')) return
    const focus=this.focus.get(canvas), related=!!focus?.connected.has(edge.id)
    edge.lineGroupEl?.classList.add('literature-nav-edge')
    edge.labelElement?.wrapperEl?.classList.add('literature-nav-edge-label')
    for (const element of [edge.lineGroupEl,edge.labelElement?.wrapperEl]) {
      element?.classList.toggle('literature-nav-neighbor',related)
      element?.classList.toggle('literature-nav-dim',!!focus?.focused&&!related)
    }
    edge.labelElement?.wrapperEl?.classList.toggle('literature-nav-label-visible',related)
  }
  async openOverview(paper?: string) {
    this.navigationIntent++
    await this.ready
    const spec = this.state.views.overview
    if (!spec) throw new Error('未找到文献总览')
    await this.openSpec(spec, paper ? [`paper-${paper}`] : undefined)
    await this.show()
  }
  async refreshOverview() {
    await this.ready
    if (!this.state.views.overview) throw new Error('未找到文献总览')
    const intent=++this.navigationIntent
    const view=await this.enqueue({...this.state.views.overview, revision:this.state.views.overview.revision+1, presentationVersion:OVERVIEW_VERSION})
    if (this.disposed || intent!==this.navigationIntent) return
    await this.openSpec(view)
    await this.show()
  }
  async openPair(a: string, b: string, focus?: string[]) {
    const intent = ++this.navigationIntent
    await this.ready
    if (!this.config || !this.corpus || a === b || !this.corpus.bundle.papers[a] || !this.corpus.bundle.papers[b]) throw new Error('无效文献对')
    const id = pairId(a, b)
    const spec = this.state.views[id] || {id, kind: 'pair', path: `${this.config.root}/内容关系/${id}.canvas`, papers: [a, b].sort(), revision: 1}
    const view = await this.ensure(spec)
    if (intent !== this.navigationIntent || this.disposed) return
    await this.openSpec(view, focus)
    await this.show()
  }
  neighborCandidates(view: ViewSpec) {
    const current = new Set(view.papers), result = new Set<string>()
    for (const r of this.corpus!.bundle.relations) {
      if (current.has(r.from_paper) && !current.has(r.to_paper)) result.add(r.to_paper)
      if (current.has(r.to_paper) && !current.has(r.from_paper)) result.add(r.from_paper)
    }
    return [...result].sort((a, b) => this.corpus!.bundle.papers[a].title.localeCompare(this.corpus!.bundle.papers[b].title))
  }
  async extend(viewId: string, paper: string) {
    const intent = ++this.navigationIntent
    if (!this.corpus?.bundle.papers[paper]) throw new Error('未知文献')
    const fork = this.forks.get(viewId)
    if (fork) viewId = fork
    const known = [...this.state.jobs].reverse().find(j => j.view.id === viewId && j.status !== 'failed')?.view || this.state.views[viewId]
    if (!known) throw new Error('阅读视图已不存在')
    let spec = clone(known)
    if (!spec || spec.kind === 'overview') throw new Error('请先打开内容关系视图')
    if (!this.neighborCandidates(spec).includes(paper) && !spec.papers.includes(paper)) throw new Error('所选文献与当前网络没有已记录的关系')
    let basePath: string | undefined
    if (spec.kind === 'pair') {
      basePath = spec.path
      const id = `work-${randomUUID()}`
      this.forks.set(spec.id, id)
      spec = {...spec, id, kind: 'work', path: `${this.config!.root}/阅读网络/${id}.canvas`}
    }
    spec.papers = [...new Set([...spec.papers, paper])].sort()
    spec.revision++
    const result = await this.enqueue(spec, basePath)
    if (intent !== this.navigationIntent || this.disposed) return result
    await this.openSpec(result, [`demo-root-${paper}`])
    await this.show()
    return result
  }
  private async ensure(spec: ViewSpec) {
    const exists = this.plugin.app.vault.getAbstractFileByPath(spec.path)
    if (exists instanceof TFile) return spec
    return this.enqueue(spec)
  }
  private async enqueue(view: ViewSpec, basePath?: string): Promise<ViewSpec> {
    let job = this.state.jobs.find(j => ['pending', 'running'].includes(j.status) && j.view.id === view.id && JSON.stringify(j.view.papers) === JSON.stringify(view.papers))
    if (!job) {
      job = {id: randomUUID(), view: clone(view), basePath, status: 'pending'}
      job.view.lastJob = job.id
      this.state.jobs.push(job)
    }
    const active = job
    const promise = new Promise<ViewSpec>((resolve, reject) => {
      const waiting = this.waiters.get(active.id) || []; waiting.push({resolve, reject}); this.waiters.set(active.id, waiting)
    })
    await this.persist()
    this.renderAll()
    this.run(() => this.work())
    return promise
  }
  private async project(view: ViewSpec, previous?: Drawing): Promise<{canvas: Drawing; report: unknown}> {
    const config = this.config!
    let overviewMetrics: Record<string,{width:number;height:number}> | undefined
    if (view.kind==='overview') {
      await document.fonts.ready
      overviewMetrics=Object.fromEntries(view.papers.map(key=> {
        const old=previous?.nodes.find(n=>n.id===`paper-${key}`)
        const width=(previous?.metadata?.literatureNavigation?.presentationVersion||1)>=2 ? old?.width||380 : 380
        return [key,measurePaper(this.corpus!.bundle.papers[key],width)]
      }))
    }
    const {execFile} = require('child_process') as typeof import('child_process')
    const {join} = require('path') as typeof import('path')
    return new Promise((resolve, reject) => {
      const child = execFile(config.python, ['-m', 'literature_canvas.navigation', 'project', '--corpus', join(this.basePath(), config.corpus)],
        {cwd: config.tools, timeout: 180000, maxBuffer: 32 * 1024 * 1024}, (error, stdout, stderr) => {
          this.children.delete(child)
          if (error) { reject(new Error(stderr.trim().slice(-1500) || error.message)); return }
          try { resolve(JSON.parse(stdout) as {canvas: Drawing; report: unknown}) } catch (e) { reject(e) }
        })
      this.children.add(child)
      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify({view, previous, overviewMetrics}))
    })
  }
  private async flush(path: string) {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('canvas')) {
      const view = leaf.view as unknown as CanvasView & {save: () => Promise<void>}
      if (view.file?.path === path) await view.save()
    }
  }
  private async work() {
    if (this.running || this.disposed || !this.config) return
    this.running = true
    try {
      for (;;) {
        const job = this.state.jobs.find(j => j.status === 'pending')
        if (!job || this.disposed) break
        job.status = 'running'; await this.persist(); this.renderAll()
        try {
          if (!safeRelative(job.view.path) || !job.view.path.startsWith(this.config.root + '/')) throw new Error('视图路径不在导航目录内')
          const vault = this.plugin.app.vault
          await this.flush(job.view.path)
          const file = vault.getAbstractFileByPath(job.view.path)
          const before = file instanceof TFile ? await vault.read(file) : undefined
          let previous = before ? JSON.parse(before) as Drawing : undefined
          const saved = previous?.metadata?.literatureNavigation
          const completed = saved?.lastJob === job.id || !!(saved && saved.revision > job.view.revision)
          if (saved && saved.id !== job.view.id) throw new Error('目标路径属于另一个视图，已停止覆盖')
          if (saved && saved.revision > job.view.revision) {
            if (!job.view.papers.every(p => saved.papers.includes(p))) throw new Error('此任务已过期，请从当前阅读网络重新加入文献')
            job.view = saved
          }
          if (!completed) {
            if (!previous && job.basePath) {
              await this.flush(job.basePath)
              const base = vault.getAbstractFileByPath(job.basePath)
              if (!(base instanceof TFile)) throw new Error('原阅读视图已移走，请重新选择')
              previous = JSON.parse(await vault.read(base)) as Drawing
            }
            const result = await this.project(job.view, previous)
            if (this.disposed) break
            // Flush native unsaved edits before the optimistic commit check.
            await this.flush(job.view.path)
            const content = JSON.stringify(result.canvas, null, 2)
            if (file instanceof TFile) {
              await vault.adapter.write(`${STORE}/backup-${job.id}.json`, before!)
              await vault.process(file, current => {
                if (current !== before) throw new Error('生成期间 Canvas 被修改，已保留你的修改。可重试合并。')
                return content
              })
            } else {
              const parts = job.view.path.split('/').slice(0, -1)
              for (let i = 1; i <= parts.length; i++) {
                const folder = parts.slice(0, i).join('/')
                if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder)
              }
              await vault.create(job.view.path, content)
            }
            job.view = result.canvas.metadata!.literatureNavigation!
          }
          this.state.views[job.view.id] = clone(job.view)
          job.status = 'done'
          await this.persist()
          this.waiters.get(job.id)?.forEach(w => w.resolve(clone(job.view)))
        } catch (error) {
          if (this.disposed) break
          job.status = 'failed'; job.error = String((error as Error).message || error)
          await this.persist()
          this.waiters.get(job.id)?.forEach(w => w.reject(new Error(job.error)))
        }
        this.waiters.delete(job.id)
        this.renderAll()
      }
    } finally { this.running = false }
  }
  private async openFile(path: string, record = true): Promise<WorkspaceLeaf> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) throw new Error(`文件不存在：${path}`)
    if (record) this.pushPosition()
    this.navigating++
    try {
      const leaf = this.leaf || this.plugin.app.workspace.getLeaf(false)
      await leaf.openFile(file)
      this.plugin.app.workspace.setActiveLeaf(leaf, {focus: true})
      this.leaf = leaf
      this.lastPosition = this.capture()
      if (record) await this.persist()
      return leaf
    } finally { this.navigating--; this.schedule() }
  }
  async openSpec(view: ViewSpec, focus?: string[], record = true) {
    view = await this.ensure(view)
    const leaf = await this.openFile(view.path, record)
    const canvas = (leaf.view as unknown as CanvasView).canvas
    if (!canvas) return
    if (focus?.length) {
      canvas.updateSelection(() => {
        canvas.selection.clear()
        for (const id of focus!) {
          const element = canvas.nodes.get(id) || canvas.edges.get(id)
          if (element) {
            canvas.selection.add(element)
            const edge = canvas.edges.get(id)
            if (edge) {
              const data = edge.getData()
              for (const endpoint of [data.fromNode, data.toNode]) {
                const node = canvas.nodes.get(endpoint)
                if (node) canvas.selection.add(node)
              }
            }
          }
        }
      })
      if (canvas.selection.size) canvas.zoomToSelection()
    } else {
      const saved = this.state.positions?.[view.path]?.viewport
      if (saved) canvas.setViewport(saved.x, saved.y, saved.zoom)
    }
    this.highlight(canvas)
    this.lastPosition = this.capture()
    await this.refresh()
  }
  async openPaper(paper: string, field: 'source' | 'note' | 'tree_path') {
    this.navigationIntent++
    const target = this.corpus!.bundle.papers[paper]
    if (!target) throw new Error('未知文献')
    await this.openFile(target[field])
    if (field === 'tree_path' && target.tree_path === target.note) {
      await this.plugin.app.workspace.openLinkText(target.note + '#文献树', '', false)
    }
    await this.show()
  }
  async openEvidence(id: string, side: 'from' | 'to') {
    this.navigationIntent++
    const relation = this.corpus!.bundle.relations.find(r => r.id === id)
    if (!relation) throw new Error('关系已不存在')
    const paper = relation[`${side}_paper`], path = this.corpus!.bundle.papers[paper].source
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) throw new Error('原文文件不存在')
    const text = await this.plugin.app.vault.read(file)
    const candidates = quotes(relation, side)
    const matching = candidates.map(quote => ({quote, position: locateQuote(text, quote)})).find(p => p.position)
    const changed = await digest(text) !== this.corpus!.sourceHashes[path]
    const leaf = await this.openFile(path)
    await leaf.setViewState({...leaf.getViewState(), state: {...leaf.getViewState().state, mode: 'source', source: false}})
    const view = leaf.view as MarkdownView
    let status: string
    if (matching?.position) {
      const from = view.editor.offsetToPos(matching.position.start), to = view.editor.offsetToPos(matching.position.end)
      view.editor.setSelection(from, to)
      view.editor.scrollIntoView({from, to}, true)
      status = changed ? '原文已更新，已重新匹配并选中证据' : '已定位并选中原文证据'
    } else {
      view.editor.setCursor({line: 0, ch: 0})
      const node = this.corpus!.nodes[paper][endpoint(this.corpus!, relation, side)]
      const matches = headings(text).filter(h => h.title === node?.heading)
      if (matches.length === 1) {
        const from = view.editor.offsetToPos(matches[0].start)
        view.editor.setCursor(from); view.editor.scrollIntoView({from, to: from}, true)
      }
      status = '证据无法唯一定位；请核对引文' + (matches.length === 1 ? '，已打开对应章节' : '')
      new Notice(status, 8000)
    }
    this.evidence = {paper, relation: id, side, status, quote: matching?.quote || candidates[0] || '此关系没有保存引文'}
    await this.show()
  }
  async back() {
    this.navigationIntent++
    let position = this.state.history.pop()
    while (position && !this.plugin.app.vault.getAbstractFileByPath(position.path)) {
      const view = Object.values(this.state.views).find(v => v.path === position!.path)
      if (view) { await this.ensure(view); break }
      position = this.state.history.pop()
    }
    if (!position) { this.renderAll(); return }
    const leaf = await this.openFile(position.path, false)
    if (position.viewport) {
      const canvas = (leaf.view as unknown as CanvasView).canvas
      canvas.updateSelection(() => {
        canvas.selection.clear()
        for (const id of position!.selection || []) {
          const element = canvas.nodes.get(id) || canvas.edges.get(id)
          if (element) canvas.selection.add(element)
        }
      })
      canvas.setViewport(position.viewport.x, position.viewport.y, position.viewport.zoom)
      this.highlight(canvas)
    } else if (position.state) await leaf.setViewState({...leaf.getViewState(), state: position.state})
    this.lastPosition = this.capture()
    await this.persist(); await this.refresh()
  }
  async rebuild() {
    if (!this.config) return
    for (const file of this.plugin.app.vault.getFiles().filter(f => f.extension === 'canvas')) {
      await this.indexFile(file, false)
    }
    await this.persist(); this.renderAll()
  }
  private async indexFile(file: TFile, save = true) {
    if (!this.config || !safeRelative(file.path) || !file.path.startsWith(this.config.root + '/')) return
    try {
      const data = JSON.parse(await this.plugin.app.vault.cachedRead(file)) as Drawing
      const view = data.metadata?.literatureNavigation
      if (!view || !['overview', 'pair', 'work'].includes(view.kind) || !Array.isArray(view.papers) || !view.papers.every(p => this.corpus?.bundle.papers[p])) return
      const existing = this.state.views[view.id]
      if (existing && existing.path !== file.path && this.plugin.app.vault.getAbstractFileByPath(existing.path)) return
      const next = {...view, path: file.path}
      if (JSON.stringify(existing) === JSON.stringify(next)) return
      this.state.views[view.id] = next
      if (save) { await this.persist(); this.renderAll() }
    } catch { /* Ignore unrelated or unfinished Canvas files. */ }
  }
  private async renamed(path: string, old: string) {
    if (!this.config || !this.corpus) return
    const replace = (p: string) => p === old ? path : p.startsWith(old + '/') ? path + p.slice(old.length) : p
    const newRoot = replace(this.config.root)
    if (newRoot !== this.config.root) {
      this.config.root = newRoot
      await this.plugin.app.vault.adapter.write(`${STORE}/config.json`, JSON.stringify(this.config, null, 2))
    }
    const changed = renamePaperPaths(this.corpus, replace)
    for (const view of Object.values(this.state.views)) view.path = replace(view.path)
    for (const job of this.state.jobs) { job.view.path = replace(job.view.path); if (job.basePath) job.basePath = replace(job.basePath) }
    for (const position of this.state.history) position.path = replace(position.path)
    if (this.state.positions) this.state.positions = Object.fromEntries(Object.entries(this.state.positions).map(([p, value]) => [replace(p), {...value, path: replace(value.path)}]))
    if (this.lastPosition) this.lastPosition.path = replace(this.lastPosition.path)
    if (changed) await this.plugin.app.vault.adapter.write(this.config.corpus, JSON.stringify(this.corpus, null, 2))
    await this.persist(); this.schedule()
  }
}
