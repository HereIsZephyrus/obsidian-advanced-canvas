// Implemented by Codex (LLM agent): derive one focus scope for cards, paths, and separate label elements.
type Edge = {id: string; fromNode: string; toNode: string}
export function overviewFocus(nodeIds: string[], edges: Edge[], selected: string[]) {
  const nodes = new Set(nodeIds), byId = new Map(edges.map(e => [e.id, e]))
  const active = selected.filter(id => nodes.has(id) || byId.has(id))
  const roots = new Set(active.filter(id => nodes.has(id)))
  const connected = new Set(active.filter(id => byId.has(id)))
  const neighbors = new Set(roots)
  for (const edge of edges) {
    if (roots.has(edge.fromNode) || roots.has(edge.toNode)) connected.add(edge.id)
    if (connected.has(edge.id)) {neighbors.add(edge.fromNode);neighbors.add(edge.toNode)}
  }
  return {focused: neighbors.size > 0 || connected.size > 0, neighbors, connected}
}
