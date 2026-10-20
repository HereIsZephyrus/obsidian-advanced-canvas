# Literature navigation

Implemented by Codex, an LLM agent, on 2026-10-20.

The preview vault contains a paper overview and content views generated from the existing 50-paper corpus. The overview aggregates 150 recorded relationships into 118 paper-pair edges. It adds no scientific relationships.

Paper cards show the complete original title, first author, and year. The generator measures rendered text before resolving card collisions. Existing positions remain fixed outside affected regions. An unchanged refresh preserves all positions and paths. The command **文献关系：更新总览并保留位置** updates an existing overview through the generation queue.

Overview edges show deduplicated relationship types. A shared palette assigns blue to inheritance, teal to the same method, yellow to cited results, green to agreement, and coral to differences. Multiple types divide the entire path into equal-length solid color segments, including bends. These segments indicate types, not proportions or relationship direction. The sidebar contains the legend. The native interaction path still selects and opens the whole edge.

The unfocused overview shows subdued colored paths and hides relationship labels. Click a paper or edge to inspect its local connections. Moving the pointer leaves focus and zoom unchanged. Related labels appear at full opacity. Unrelated cards, paths, and labels share the dimmed state. Label visibility changes no stored positions or relationships.

Open `Demo-文献导航/文献总览.canvas`. The network ribbon button opens the **文献关系** sidebar. The command palette also provides **文献关系：打开当前文献的关系**, **文献关系：打开文献总览**, and **文献关系：返回刚才的网络**.

1. Select a paper to highlight its neighbors and inspect relationship types and counts.
2. Select an overview edge, then choose **打开内容关联**, or double-click the edge.
3. Select a content relationship to inspect its explanation and open either source quotation.
4. Choose **返回原视图** to restore the preceding selection, center, and zoom.
5. Choose **加入文献** to add a connected paper to the reading network.

The first addition creates a reading network from the paper-pair view. Further additions retain that reading network's ID and saved positions. The original pair remains available. Simultaneous additions enter one persistent FIFO queue. Repeated requests for the same pending scope share a job.

The sidebar recognizes the source, companion note, and tree through explicit paper IDs. In source mode, the cursor identifies the current section. In reading mode, selected text or a rendered heading provides context. The section selector supplies an explicit fallback. Companion notes receive paper-level navigation because their prose has no assumed paragraph correspondence with the source.

Evidence links select a unique source quotation in the editor without changing the file. The locator tolerates whitespace differences and matches changed sources again. Missing or ambiguous quotations produce a visible notice and a chapter fallback when that chapter is unique. The locator resolves source text directly. Passage IDs remain internal identifiers.

## Storage and updates

Each generated Canvas stores its view descriptor under `metadata.literatureNavigation`. Nodes retain their existing paper and tree identities. Detail relationships retain their original evidence.

Both views use the shared obstacle router. Overview paths use distributed boundary ports and diagonal segments where clear. Content views use orthogonal paths. Paths and labels avoid cards. Edge crossings remain possible.

`.literature-navigation/corpus.json` contains the frozen corpus, source hashes, and tree-node index. `state.json` stores view paths, queue jobs, navigation history, and viewports. The registry can be rebuilt from generated Canvas metadata. Historical experiment snapshots have no navigation descriptor and stay outside this registry.

Canvas creation, modification, rename, and deletion update discovery. The generator reconstructs a removed view from its retained descriptor. Source renames update the explicit file mapping. The locator checks source edits when opening evidence. A rename does not change paper or view identity.

The worker flushes native Canvas saves before reading and before committing. A concurrent edit rejects the replacement. **重试** uses the current drawing and preserves manual annotations. An interrupted job resumes after plugin reload. State writes share one queue across plugin instances and use unique temporary files. Updates create no backup copies.

The main ecohydrology vault stores generated views under `network/`. Its existing Remote Sync configuration handles synchronization. Companion notes retain their trees and links to these views.

This preview uses one desktop Obsidian process. Its generator requires Python 3.12, Node.js, Graphviz, and the existing `literature-canvas-tools` checkout. `config.json` records the local interpreter and checkout paths. Other computers need their own valid generator paths. Mobile generation and multiple concurrent writers are outside this implementation.

The preview uses the existing 50-paper corpus. Importing new scientific relationships into that corpus remains a separate workflow. The navigation commands do not infer relationships or regenerate close-reading notes.

The same navigation configuration supports the main vault with an explicit local corpus and output root.
A paper can use its companion note as `tree_path`. The **文献树** action then opens that note's
`文献树` heading. Renaming the shared note preserves both path mappings and its source hash.
Generated `flowchart LR` trees use a `paper_root` node. Their note region scrolls at the declared
font size, with a maximum height of 72% of the window. Other Mermaid diagrams retain their styles.
The separate publication tool inserts trees after frontmatter and the existing H1, preserving the remaining note text.

## Installation and validation

Build with `npm run build`, then use `literature-canvas-tools/scripts/install_canvas_plugin.py` to install into the preview vault with backups. Reload Advanced Canvas afterward.

For a new preview, initialize navigation from the selected network:

```sh
.venv/bin/python -m literature_canvas.navigation prepare \
  --vault /path/to/ecohydrology-literature-preview-DATE \
  --bundle demo/bundle.json \
  --canvas /path/to/selected-network.canvas \
  --backup /path/outside/vault/navigation-backup
```

Initialization refuses to replace an existing navigation configuration. It creates the overview and records checksums for existing Markdown files. It does not edit those files.

Run `npm run test:literature` for navigation, routing, and color-segment checks. Run the Python navigation tests from the tools checkout.

The tools script `scripts/check_navigation_ui.cjs` exercises the preview application. It checks navigation, concurrent additions, edit conflicts, rename handling, and interrupted-job recovery.

Run `scripts/check_overview_ui.cjs` for all 50 rendered cards, segment colors, and regeneration stability. Run `scripts/check_overview_interactions.cjs` for edge hit areas, rerouting, undo, and redo.

The focus regression runs on Obsidian 1.14.4. It checks pointer movement, clicks, and centers for uninitialized offscreen edges. Managed edges calculate their centers from saved geometry. Other uninitialized edges use their endpoint bounds until native curve data becomes available.

Disable Advanced Canvas to stop navigation. Each drawing remains an ordinary Canvas file with one fallback color per edge. Multiple color segments and obstacle routing require this plugin.
