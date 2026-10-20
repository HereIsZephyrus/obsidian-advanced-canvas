# Changes made by an LLM agent

Codex, an LLM agent, implemented the literature routing and navigation integration on 2026-10-20. This document marks every changed file, including JSON files that cannot contain comments.

| Files | Change made by Codex |
| --- | --- |
| `package.json`, `package-lock.json` | Pin `libavoid-js@0.5.0-beta.5` and add build and routing-test commands. |
| `scripts/build-literature.mjs` | Bundle the shared engine for Node.js, the browser worker, and tests. Copy the WASM binary and license. |
| `scripts/route-literature.ts` | Read Canvas JSON from stdin and return routes and diagnostics. |
| `src/literature-routing/avoid-runtime.ts` | Type the pinned WASM binding surface. |
| `src/literature-routing/router.ts` | Preserve valid paths, route invalid paths around cards, separate corridors, and place labels and leaders. |
| `src/literature-routing/worker.ts` | Run routing outside the Obsidian UI thread. |
| `src/literature-routing/controller.ts` | Schedule edits, reject stale results, render saved geometry, and preserve undo behavior. |
| `src/main.ts` | Create the routing controller. |
| `src/literature-navigation/model.ts`, `src/literature-navigation/controller.ts` | Add source locators, the relationship sidebar, saved view identities, a persistent generation queue, and bidirectional navigation. |
| `src/main.ts`, `src/styles.scss`, `src/styles/_literature-navigation.scss` | Register the navigation controller and style its sidebar and transient highlights. |
| `src/literature-routing/controller.ts` | Reject stale jobs after file switches. Render equal-length relation colors while retaining native edge interaction. |
| `src/literature-routing/overview-router.ts`, `src/literature-routing/dispatch.ts` | Route overview polylines through distributed boundary ports and preserve clear saved paths. |
| `src/literature-navigation/presentation.ts`, `src/literature-navigation/relation-style.json` | Share ordered relation colors and labels. Measure full-title cards and split paths by arc length. |
| `src/literature-navigation/save-queue.ts` | Serialize state writes across plugin reloads. |
| `src/literature-navigation/focus.ts`, `src/literature-navigation/controller.ts`, `src/styles/_literature-navigation.scss` | Apply one selection scope to cards, paths, and separate labels. Reveal labels only on selection. |
| `src/literature-navigation/controller.ts`, `src/styles/_literature-navigation.scss` | Add the overview refresh command, measured cards, relationship legend, and color segments. |
| `tests/literature-overview.test.mjs`, `tests/literature-navigation.test.mjs` | Check polyline routing, retained geometry, equal-length colors, and state-write ordering across reloads. |
| `tests/literature-navigation.test.mjs`, `LITERATURE_NAVIGATION.md` | Test source and identity resolution. Document preview use, storage, installation, and limits. |
| `src/@types/Canvas.d.ts` | Declare the native history replacement method. |
| `src/patchers/canvas-patcher.ts` | Include routed segments and labels in edge bounds for viewport rendering. |
| `src/patchers/canvas-patcher.ts` | Wait for instance fields before rebuilding open views during plugin reload. Reset the clearing flag even if teardown fails. |
| `src/patchers/canvas-patcher.ts`, `src/literature-routing/router.ts`, `tests/literature-routing.test.mjs` | Calculate managed edge centers before native Bezier initialization. Check label centers and path midpoints. |
| `src/canvas-extensions/advanced-styles/edge-styles.ts` | Keep the upstream path generator from replacing managed routes. |
| `src/canvas-extensions/floating-edge-canvas-extension.ts` | Retain the port sides chosen by the shared router. |
| `src/styles.scss`, `src/styles/_literature.scss` | Size labels consistently and center compact generated structure cards. |
| `tests/literature-routing.test.mjs` | Check obstacle routing, stable updates, label changes, and corrupt-cache recovery. |
| `LITERATURE_ROUTING.md`, `LLM_CHANGES.md` | Document installation, behavior, validation, limits, rollback, and authorship. |
| `src/literature-navigation/model.ts`, `src/literature-navigation/controller.ts`, `tests/literature-navigation.test.mjs` | Open trees embedded in companion notes and retain hashes when their shared file is renamed. |
| `src/styles/_literature-navigation.scss`, `LITERATURE_NAVIGATION.md` | Keep Flowchart LR paper trees readable in a scrollable note region and document companion-note navigation. |

Generated files under ignored `dist/` come from these sources. The build copies `libavoid.wasm` and its license unmodified from the pinned dependency.
