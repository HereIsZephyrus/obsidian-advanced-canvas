# Literature network routing

Implemented by Codex, an LLM agent, for this fork. See [LLM_CHANGES.md](LLM_CHANGES.md) for the changed files.

This fork renders saved obstacle-avoiding routes in literature Canvas files. The companion Python tools choose visible paper nodes and compute local node positions. The plugin renders and updates connectors when a node moves, resizes, or changes its relationships.

Each edge stores its polyline, endpoint geometry, label box, and optional label leader in `literatureRoute`. The engine identifies these records as `libavoid-orthogonal-v1`. Ordinary Canvas files keep the upstream behavior.

## Build and install

Use Node.js 18 or later. Build from the repository root:

```sh
npm ci
npm run build
npm run test:literature
npx tsc --noEmit
```

Copy these files from `dist` into the target vault's `.obsidian/plugins/advanced-canvas` directory:

- `main.js`, `styles.css`, `manifest.json`
- `literature-worker.js`, `libavoid.wasm`, `libavoid-LICENSE`

Enable Advanced Canvas in Obsidian. After replacing an installed build, disable and re-enable the plugin to load it.

The companion tools provide an installer that backs up replaced files and updates the Python router assets from the same build:

```sh
cd /home/channingtong/Documents/brain/literature-canvas-tools
.venv/bin/python scripts/install_canvas_plugin.py \
  --plugin /home/channingtong/Craft/obsidian-advanced-canvas \
  --vault /home/channingtong/Documents/brain/obsidian/ecohydrology-literature-preview-20261019 \
  --backup experiments/plugin-install-backup-20261020
```

The installer records file hashes and backup paths. It does not change the plugin enablement setting. The preview vault currently runs this build.

## Layout and routing

The Python layer retains stable paper and tree-node IDs. It projects relationship endpoints and their ancestors. Unrelated branches remain in the complete Mermaid notes. It stores positions, honors explicit pins, and gives manually placed nodes stronger placement constraints.

The shared TypeScript engine uses `libavoid-js@0.5.0-beta.5` for orthogonal obstacle routing. Existing clear paths remain unchanged. Moved endpoints and new obstacles invalidate affected paths. Card clearance, segment penalties, and corridor nudging constrain new routes. A separate placement pass keeps labels clear of cards, other labels, and other connectors. Detached labels receive short dashed leaders.

The browser worker and Node.js transport bundle the same `router.ts`. Python independently checks each result before committing it. The plugin debounces edits and rejects results for superseded geometry. Routing updates the current undo entry, so undoing a drag takes one step.

The persistent paper queue belongs to the Python tools. It accepts bursts while one consumer computes and commits each arrival. Interactive plugin jobs run in a shared worker. They are transient, and the saved Canvas supplies the state after reopening.

## Verification and limits

The 50-paper experiment lives in the companion project's `experiments/dynamic-50-20261020-libavoid-v2` directory. Sequential and burst modes produced identical states at all 50 steps. The final network contains 513 nodes, 150 cross-paper relationships, and 613 connectors in two components.

All 100 states passed independent checks for node overlap, connector-card penetration, label overlap, and label obstruction by another connector or leader. Nodes outside the affected region remained fixed. The sequential run verified 11,523 retained paths across its steps.

The native Obsidian checks cover moving and resizing cards, stale worker results, unrelated path stability, label edits, zoom scaling, undo/redo, and save/reopen. Run `scripts/check_plugin_ui.cjs` from the companion project against its disposable preview fixture.

Edges can cross other edges, and short shared endpoint segments can coincide. A dense graph still needs local zoom. Long labels may truncate inside their reserved boxes. If overlapping cards prevent routing, the plugin reports failure and retains the prior route data. Resolve the overlap before expecting a clear path.

Disabling the plugin restores native Canvas curves. The custom route data remains in the file. This fork depends on Obsidian's internal Canvas API, so repeat the native checks after an Obsidian upgrade.

## Rollback and dependency source

Disable Advanced Canvas before restoring files. Each installer receipt lists the exact backup for every replaced file. Restore those files to their recorded paths. Files whose backup is null were newly installed. Remove those files when reverting to the pre-installation state. Enable the restored plugin only if a previous version existed.

Preview publication uses separate backups and receipts beside the experiment. It accepts native JSON formatting, omitted default arrow fields, and the plugin's empty schema metadata. Other changes require inspection before replacement.

The pinned WASM dependency is [libavoid-js](https://github.com/Aksem/libavoid-js), a binding for [libavoid](https://www.adaptagrams.org/documentation/libavoid.html). Its LGPL-2.1-or-later license ships as `libavoid-LICENSE`. The upstream source and build instructions are available in that repository. Advanced Canvas retains its existing license.
