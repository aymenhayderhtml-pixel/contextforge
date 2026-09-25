# TASKS.md

## Phase 0 — Manifest Schema + Server Skeleton
- [x] T001: Define `server/schema/manifest.schema.json` per docs/ARCHITECTURE.md — JSON Schema (Draft 2020-12) with node types (scene/script/module/asset), engine enum (godot/js), contract shape (exports/signals/requires), edge kinds (ext_resource/signal_connection/import/asset_ref), strict additionalProperties: false
- [x] T002: Write `server/schema/validate.js` — Ajv2020-based validator returning `{ valid, errors[] }` with specific error messages (enum values, missing props, extra props, type mismatches); 7/7 tests pass
- [x] T003: Minimal Node HTTP server (`server/index.js`) — Express serving `/public` static files, `POST /extract` and `GET /manifest` returning validated hardcoded sample manifest (6 nodes, 6 edges)
- [x] T004: Basic graph UI page in `/public/index.html` — plain list view of nodes (with engine/type badges, contract details, dependency links) and edges (with kind labels); auto-loads manifest on page open
- [x] T005: Manual test — confirmed: GET /manifest returns valid JSON, POST /extract returns valid JSON, schema validation passes on both, static HTML served correctly, pipeline works end to end

### Phase 0 Checkpoint
**What's done:** The manifest JSON Schema is defined and enforced. A validator produces clear, specific error messages. The server serves a hardcoded sample manifest through two API endpoints (`POST /extract`, `GET /manifest`) and a frontend list view renders nodes and edges from the manifest. The full pipeline (server → API → validator → UI) works end to end.

**What the tool can do now:** Start the server (`npm start`), open `http://localhost:3000`, and see a list of 6 sample nodes and 6 edges from a hardcoded Godot-style manifest. Both API endpoints return schema-valid manifests.

## Phase 1 — Godot Extractor
- [x] T006: Built `/test-fixtures/godot-sample` — 3 scenes (Player, Enemy, Level1), 3 scripts (Player.gd, Enemy.gd, GameManager.gd), project.godot with GameManager autoload. Covers: signal connections, @export vars, ext_resource deps (scripts + sub-scenes), autoload singleton reference
- [x] T007: `godot-extractor.js` .tscn parsing — extracts ext_resource headers (scripts, PackedScene sub-scenes), connection blocks (signal wiring), root node script assignments. Produces edges with kind=ext_resource and kind=signal_connection
- [x] T008: `godot-extractor.js` .gd parsing — extracts @export vars (Godot 4 + legacy syntax), signal declarations, public func signatures (excluding _-prefixed). Also detects autoload references from project.godot for the requires field. Scene contracts are union of root script contract per ARCHITECTURE.md §3
- [x] T009: Extractor output validates against manifest.schema.json — 16/16 tests pass covering node counts, contract contents, edge types, dependency accuracy, autoload requires detection, private func exclusion
- [x] T010: Determinism confirmed — two consecutive runs on the unchanged fixture produce byte-identical output (2901 bytes)

### Phase 1 Checkpoint
**What's done:** The Godot extractor parses .tscn (ext_resource deps, signal connections, scene structure) and .gd (signals, @export vars, public funcs) files, detects autoloads from project.godot, and produces a schema-valid manifest. Scene contracts inherit from their root script's contract. All output is sorted for determinism.

**What the tool can do now:** Given a Godot 4.x project path, the extractor produces a full dependency graph with 6 node types, 4 edge kinds, and complete public-interface contracts. Output is schema-validated and deterministic.

## Phase 2 — JS / Three.js Extractor
- [x] T011: Built `/test-fixtures/js-sample` — 5 ES modules (main.js, scene-manager.js, player.js, utils.js, asset-loader.js) with imports between them, plus a .glb asset reference. Covers: named exports, default exports, class exports, async function exports, const exports, cross-module imports, asset string references
- [x] T012: `js-extractor.js` wraps `madge` for import graph resolution — gets full dependency tree in JSON mode, handles src/ directory detection, normalizes paths for cross-platform support
- [x] T013: Extended `js-extractor.js` with export parsing via regex — handles `export function`, `export async function`, `export class`, `export const/let/var`, `export default`, and `export { ... }` re-exports. Also scans string literals for asset references (.glb, .png, etc.) and creates asset-type nodes with asset_ref edges
- [x] T014: All 16 tests pass — schema validation, module discovery (5 modules + 1 asset), dependency accuracy, contract parsing for all export styles, asset reference detection, signals=[] for all JS nodes, determinism confirmed (two runs produce identical output)

### Phase 2 Checkpoint
**What's done:** The JS extractor uses madge for import graph resolution and regex for export parsing. It discovers all ES modules, builds accurate import edges, parses all common export styles into contracts, detects asset references in string literals, and produces deterministic schema-valid output.

**What the tool can do now:** Both extractors (Godot and JS) can independently parse their respective project types and produce schema-valid, deterministic dependency manifests with full public-interface contracts.

## Phase 3 — Real Graph UI
- [x] T015: D3.js v7 force-directed graph — nodes as color-coded circles by type (scene=red, script=purple, module=blue, asset=green), edges as color-coded arrows by kind, zoom/pan, drag-to-reposition, hover tooltip with full path, legend
- [x] T016: Click-to-select side panel — shows node id, engine/type badges, full contract (exports, signals, requires), depends_on and depended_on_by as clickable links that navigate the graph
- [x] T017: Re-extract button + real extraction — rewrote server to run actual Godot/JS extractors via POST /extract with auto engine detection, server computes depended_on_by from edges per ARCHITECTURE.md §2. Re-extract button re-runs against the loaded project path. Tested against both fixtures (6+6 nodes, proper depended_on_by, error handling for missing/bad paths)

### Phase 3 Checkpoint
**What's done:** The plain list UI is replaced with a full interactive D3 force-directed graph. The server runs real extractors instead of returning hardcoded data, auto-detects Godot/JS engines, computes depended_on_by, and validates output. Clicking any node shows its complete contract and clickable dependency navigation. Re-extract runs live against the loaded project.

**What the tool can do now:** Point it at any Godot 4.x or JS/Three.js project folder, and it extracts + visualizes the full dependency graph with contracts, navigable dependencies, and live re-extraction. The pipeline is: user enters path → server runs extractor(s) → validates schema → D3 renders interactive graph → click any node to inspect its public interface.

## Phase 4 — Task Locking (multi-agent safety)
Purpose: prevent two AI sessions (e.g. two Gemini instances, or an agent plus a manual
paste-back) from editing the same file at the same time and corrupting it. See
docs/ARCHITECTURE.md section 6 for the full design before starting.
- [x] T018: Added optional `lock` field to node schema (`status`: free/locked, `holder`: string, `locked_at`: ISO timestamp). Existing tests pass (lock is optional), lock-specific validation confirmed for valid locked/free states and invalid enum values
- [x] T019: Implemented `POST /lock`, `POST /unlock`, `GET /locks` — lock fails with 409 when different holder tries to lock; same holder re-lock refreshes timestamp; unlock rejects wrong holder with 403; force-unlock bypasses holder check; stale-lock auto-release after 30 minutes; missing params return 400. Full 9-scenario test suite passes
- [x] T020: Graph UI shows pulsing dashed orange lock rings on locked nodes with holder name label; legend includes "Locked" indicator; side panel shows LOCKED badge + holder + timestamp when viewing a locked node; locks auto-poll every 10 seconds
- [x] T021: Force-unlock button in side panel — red "⚠ Force Unlock" button calls POST /unlock with force:true, refreshes lock state and updates visuals immediately

### Phase 4 Checkpoint
**What's done:** File-level node locking prevents two sessions from editing the same file. Lock/unlock/locks API endpoints enforce holder-based access control with stale-lock timeout. The graph UI visually shows which nodes are locked and by whom, with manual force-unlock for stuck locks.

**What the tool can do now:** Multiple AI agents can safely coordinate by locking nodes before editing. The graph shows real-time lock status. Stale locks auto-expire after 30 minutes. Users can force-unlock stuck nodes from the UI.

## Phase 5 — Context Packager
- [x] T022: "Package context for this node" — server POST /package-context returns target file contents, interface-only stubs for direct dependencies and dependents, and conventions snippet; UI modal with one-click clipboard copy
- [x] T023: "Add new scene/module" flow — server POST /scaffold locks the new node before writing boilerplate for Godot/JS, generates AI prompt with existing project nodes/contracts; UI "+ Add Node" modal scaffolds and auto-refreshes graph
- [x] T024: Paste-back box — server POST /paste-back enforces lock ownership before writing AI code to target path; UI side-panel paste-back box with session holder input, lock claiming, code textarea, and write-back feedback

### Phase 5 Checkpoint
**What's done:** Complete context packaging pipeline implemented. The server bundles target file content with interface-only stubs of connected nodes and static conventions. Scaffolding flow generates engine boilerplate and AI handoff prompts while enforcing lock acquisition. Paste-back writes AI-generated code to target project files strictly under lock verification.

**What the tool can do now:** Users can click any node in the graph UI to package its scoped context for an LLM with one click, scaffold new nodes with engine boilerplate and prompts, and paste AI output back into the project safely guarded by file-level task locks.

## Phase 6 — Validation on Write-back
- [x] T025: After paste-back write, re-runs single-file extractor (`extractSingleGodotFile` / `extractSingleJsFile`) on the modified file only and compares the new public contract against expectations of all dependent nodes
- [x] T026: Surfaces contract mismatches clearly with dependent and missing member details (e.g. "Level1 expects Player to emit `died()`, but the new Player does not declare that signal"), highlights issues in red in the UI, keeps lock during fixes, and releases lock upon task completion or manual release

### Phase 6 Checkpoint
**What's done:** Contract validation on write-back is fully functional. Whenever AI-generated code is pasted into a file, ContextForge extracts only that file's new interface contract and verifies it against the expectations of all dependent nodes and scenes (missing signals, missing exported functions/variables/classes, missing autoload requirements). Mismatches are surfaced before releasing the file, preventing breaking changes from silently entering the project.

**What the tool can do now:** The complete ContextForge core loop is working end to end:
1. Extract & visualize real source-derived dependencies.
2. Coordinate multiple agents/sessions via node locking.
3. Package minimal, interface-stubbed context for any AI model.
4. Scaffold new files with boilerplate and prompts.
5. Paste AI code back safely under lock protection.
6. Validate AI code against dependent contracts before releasing the lock.

## Phase 7 — Asset Graph (build after Phases 0–6 work end to end)
- [x] T027: Assets (`.glb`, images, audio) treated as leaf nodes (`depends_on: []`) with declared slot contracts. Extracted from companion `.slot.json` files, project registries, and in-code annotations. Populates `contract.exports` with sorted signatures (e.g. `animation: idle`, `format: glb`, `rigged: true`, `dimensions: 64x64`), `signals: []`, `requires: []`, and structured `slot` metadata. Deterministic and validated against JSON Schema.
- [x] T028: Drag-and-drop replacement & slot contract validation. Pure Node.js binary inspection of `.glb` models (animations, rigging) and images (format, dimensions). Implemented `POST /swap-asset` and `POST /validate-asset` with multi-agent lock protection. Frontend features D3 node dragover/drop targets, side panel drop zone with file picker, slot contract badge cards, and real-time mismatch feedback. 21/21 automated tests passing.

### Phase 7 Checkpoint
**What's done:** Assets are first-class leaf nodes with factual, declared slot contracts. ContextForge parses expected animations for 3D character slots, dimensions for textures, and formats across both Godot and JS/Three.js projects. A drag-and-drop workflow allows hot-swapping assets directly onto the dependency graph or the inspector panel, immediately validating the replacement against declared slot expectations without external heavy dependencies.

**What the tool can do now:**
1. Extract & visualize real source-derived dependencies (scenes, scripts, modules, assets).
2. Treat assets as leaf nodes with explicit slot contracts (animations, format, rigging, dimensions).
3. Coordinate multiple agents/sessions via node locking.
4. Package minimal, interface-stubbed context for any AI model.
5. Scaffold new files with boilerplate and prompts.
6. Paste AI code back safely under lock protection.
7. Validate AI code against dependent contracts before releasing the lock.
8. Drag-and-drop replacement assets onto asset/placeholder nodes, writing them to disk and validating them against slot contracts with instant visual feedback.

## Phase 8 — Playtest Bug Fixes (carried over from v0.0.1 review)
- [x] T029: Added `requires` edge kind to schema enum, extractor, and graph UI. Godot scripts referencing autoload singletons (e.g. `GameManager`) emit `{ from, to, kind: 'requires' }` edges, populate `depends_on`, and render distinctly as dashed orange lines with legend indicator.
- [x] T030: Clear selected node state, side panel contents, and highlight rings whenever a new project path is extracted in `doExtract()`, preventing stale node details across project switches.
- [x] T031: Added `server/scaffold-validator.js` and frontend validation enforcing valid relative path patterns, rejecting bare spaces/names with spaces ("scene 1"), path traversal, and missing or mismatched extensions per engine/type (.tscn for scenes, .gd for scripts, .js/.mjs/.ts for modules). 15/15 unit tests pass.

### Phase 8 Checkpoint
**What's done:** All three playtest bugs are resolved. Autoload dependencies now appear as first-class `requires` edges rendered as distinct dashed lines, correctly identifying nodes that are actively required. Switching projects cleanly wipes out previous selection and panel state. The Add Node modal and server `/scaffold` endpoint strictly validate paths against engine and filetype rules, preventing malformed paths or extensionless files from being written.

**What the tool can do now:**
1. Render autoload requirements (e.g. `Player.gd -> GameManager.gd`) as visible, distinct dashed edges so required singletons are never mistaken for orphans.
2. Switch between different project paths cleanly without retaining stale node data or open panels from the prior project.
3. Validate and normalize new node IDs both client-side and server-side before scaffolding, ensuring proper extensions (`.tscn`, `.gd`, `.js`) and clean path syntax.

## Phase 9 — Graph Scaling & Navigation (real projects, not toy fixtures)
Motivating case: a real 80-node project rendered as scattered, mostly-illegible dots spread across a huge empty canvas — unusable at that scale. The fix is not visual tuning, it's not rendering the whole flat graph by default.
- [x] T032: Built medium-scale fixture `/test-fixtures/godot-large-sample` with 33 nodes across `scenes/ui`, `scenes/entities`, `scenes/levels`, `scripts/core`, `scripts/ui`, `scripts/entities`, `scripts/utils`, and `scripts/tests`, including interconnected clusters and 11 unconnected orphan files. Verified with automated test suite `test-fixtures/godot-large-test.js`.
- [x] T033: Integrated smooth zoom (`d3.zoom()` with 0.1x to 5.0x scale extent) and pan on empty canvas.
- [x] T034: Added "🎯 Fit to View" control button that computes the visible node bounding box and animates zoom/pan transition to fit all nodes into viewport with padding.
- [x] T035: Threshold-based folder clustering (default > 20 nodes, configurable). Collapses folder members into single cluster nodes (e.g. `scenes/ui/ (4)`) with inter-cluster edges; clicking a cluster expands it in place without resetting layout.
- [x] T036: Added real-time fuzzy search input with opacity dimming (non-matches dimmed to 12%, edges to 5%) and Enter-to-center zoom animation on first match with automatic node selection.
- [x] T037: Added 1-hop "🎯 Focus Mode" toggle isolating the selected node and its direct dependencies and dependents, dimming all non-connected nodes to 8% and non-connected edges to 3%.
- [x] T038: Collected zero-edge unconnected nodes into a collapsible "📦 Unconnected (N)" panel in the corner, keeping the main force canvas clean and free of orphan visual noise.

### Phase 9 Checkpoint
**What's done:** Graph navigation and scaling are now production-ready for medium-to-large game codebases (~30–80+ nodes). The medium fixture (`godot-large-sample`) proves that instead of scattering dozens of disconnected dots across an empty canvas, ContextForge collapses folders into cohesive clusters, packs zero-edge util/test scripts into an Unconnected group, and provides search, fit-to-view, and 1-hop focus mode for instantaneous navigation.

**What the tool can do now:**
1. Navigate large graphs smoothly with scroll-wheel zoom (0.1x–5x) and canvas pan.
2. Fit any project graph into view with one click ("Fit to View").
3. Automatically group projects with > 20 nodes into expandable folder clusters with folder-to-folder edges.
4. Fuzzy-search node names with live canvas highlighting and instant zoom-centering.
5. Isolate any node's 1-hop neighborhood via Focus Mode.
6. Group zero-edge orphan files in a dedicated collapsible corner list.

## Phase 10 — Layout Stability
- [x] T039: Fixed hover shaking by isolating hover events to pure CSS stroke changes and tooltip rendering, completely decoupling hover from simulation alpha, position modifications, and restarts.
- [x] T040: Configured force simulation with `alphaDecay(0.04)` and `alphaMin(0.001)` so the layout cools down rapidly (~1.5s) and ceases ticking entirely once settled.
- [x] T041: Manually dragged nodes pin their coordinates (`fx`, `fy`) across drag release and re-renders; added "↺ Reset" button to unpin all nodes and re-settle the force simulation on demand.

### Phase 10 Checkpoint
**What's done:** Layout jitter and perpetual force movement are completely eliminated. Hovering over nodes is strictly visual. Dragging nodes permanently pins their positions until explicitly reset, allowing users to arrange architecture diagrams comfortably.

**What the tool can do now:**
1. Hover stably over any node without triggering simulation shakes or tick updates.
2. Automatically settle the graph into a completely static state in ~1.5s.
3. Drag any node to pin its position permanently, surviving project re-extractions until the "Reset" button is clicked.

## Phase 11 — UI / Screen Space Overhaul
- [x] T042: Graph canvas fills all available viewport space via flex layout and dynamically recalculates dimensions and force center on window resize events (`handleResize()`) without re-rendering or resetting user zoom.
- [x] T043: Detail panel made resizable via `#panel-resizer` drag handle with `--panel-w` CSS property binding, min/max clamping, and collapsible state with smooth zero-width collapse via `closePanel()`.
- [x] T044: Truncated long `#project-path` with `text-overflow: ellipsis`, fixed max-width, and bidirectional `title` tooltip updater reflecting full path on input and project load.
- [x] T045: Added left sidebar `#left-sidebar` with collapsible folder tree `#sidebar-tree` and filter input `#sidebar-search`. Implemented bidirectional selection sync: clicking tree items selects and centers nodes in the graph; selecting graph nodes highlights matching tree items and scrolls them into view.
- [x] T046: Audited layout against `godot-large-sample` (33 nodes across 8 folders), verifying that all nodes, clusters, orphan lists, and sidebar trees scale seamlessly without overlapping or broken controls. 16/16 scaling & layout tests pass.

### Phase 11 Checkpoint
**What's done:** The ContextForge UI has been transformed from a crowded fixed-pixel layout into a flexible, responsive IDE workspace. The graph canvas responds to viewport resizing without resetting zoom or layout. The detail inspector is resizable via a drag handle and collapsible. The project path field truncates with an ellipsis and full tooltip. The new left sidebar provides folder-grouped tree navigation bidirectionally synced with the graph.

**What the tool can do now:**
1. Dynamically resize the dependency graph on viewport changes without losing canvas state.
2. Drag the left border of the inspector panel to adjust its width, or collapse it completely.
3. Browse and filter all project files in an explorer tree grouped by folder in the left sidebar.
4. Jump to any node in the graph by clicking it in the sidebar tree, and vice versa.
5. Inspect long project paths without breaking header control alignment.


## Phase 12 — HTML / Web Live Preview Panel
- [x] T047: Added collapsible web live preview panel (`#web-preview-panel`) with embedded sandboxed `<iframe>` (`#web-preview-iframe`), custom dev server URL input (`#preview-url-input`), reload button, new-tab opener, and collapse toggle header.
- [x] T048: Implemented project-level preview URL persistence via `POST /preview-url` and `GET /preview-url` storing configuration in `.contextforge.preview.json` sidecar files in the project root alongside client-side `localStorage` caching.
- [x] T049: Conditioned preview UI on JS/HTML engine detection: preview controls and panel are shown only when project contains JS/HTML nodes, and automatically hidden for Godot-only projects. 6/6 tests passing in `server/preview-test.js`.

### Phase 12 Checkpoint
**What's done:** Web and HTML5 game developers now have an integrated live preview directly inside ContextForge. The collapsible preview dock embeds an iframe connected to the user's local dev server (e.g. Vite, Webpack, Three.js dev server on port 5173). The target URL is automatically saved to a project sidecar (`.contextforge.preview.json`) and retrieved on reload. Projects without JS/HTML nodes (such as pure Godot games) cleanly hide the preview dock to avoid interface clutter.

**What the tool can do now:**
1. View a running web game directly inside the graph workspace via a collapsible bottom preview panel.
2. Enter any local dev server URL (e.g. `http://localhost:5173`), reload the iframe, or open in an external browser tab.
3. Automatically remember and restore the dev server URL for each project across sessions via project sidecars.
4. Seamlessly hide preview tools when working on Godot-only projects.


## Phase 13 — New Project Wizard + Progress Dashboard
- [x] T050: Added "+ New Project" button in controls opening a project initialization wizard with target folder selection, engine dropdown (Godot / JS / Mixed), and project name. Implemented validation rejecting existing project folders.
- [x] T051: Implemented `scaffoldNewProject()` in `server/project-init.js` and `POST /init-project` endpoint generating engine starter boilerplate (Godot `project.godot`/scenes/scripts or JS `package.json`/`index.html`/src modules or mixed) AND full AI-agent doc set (`GEMINI.md`, `LOOP.md`, `TASKS.md`, `docs/ARCHITECTURE.md`). Automatically triggers an initial `/extract` loading the new project directly into the graph.
- [x] T052: Added Progress Dashboard (`#btn-toggle-progress`) and `parseProjectProgress()` parser with `GET /project-progress` endpoint parsing `- [ ]` and `- [x]` checkboxes from `TASKS.md` into overall completion percent, task ratios, and per-phase progress bars and task lists.
- [x] T053: Implemented live real-time auto-refresh in Progress Dashboard polling every 3 seconds while open, immediately reflecting any disk changes made to `TASKS.md` as agents complete tasks. 10/10 tests passing in `server/project-init-test.js`.

### Phase 13 Checkpoint
**What's done:** ContextForge now provides full project lifecycle support: from bootstrapping brand new game projects with an AI-agent operating system to monitoring autonomous agent progress in real time. The New Project wizard scaffolds clean engine starter files along with the exact 4-doc loop specification (`GEMINI.md`, `LOOP.md`, `TASKS.md`, `docs/ARCHITECTURE.md`) used to build ContextForge itself. The Progress dashboard displays phase-by-phase completion percentages and task checklists with live 3-second polling.

**What the tool can do now:**
1. Scaffold brand-new Godot, JavaScript/Three.js, or Mixed game projects with one click via "+ New Project".
2. Automatically generate the complete AI-agent-loop doc set (`GEMINI.md`, `LOOP.md`, `TASKS.md`, `docs/ARCHITECTURE.md`) customized to the new game and engine.
3. Automatically extract and visualize newly bootstrapped projects in the graph immediately upon creation.
4. Monitor an AI agent's live progress through `TASKS.md` via the interactive "📊 Progress" dashboard with phase-by-phase progress bars and task checklists.
5. Live-poll `TASKS.md` updates every 3 seconds without needing to reload the browser.


## Phase 14 — Disk File Explorer, Surgical Edits & AI Workflow (v0.0.3)
- [x] T054: Changed left sidebar tree to mirror actual project folder on disk (`getProjectFileTree` / `GET /file-tree`), showing all files and subfolders regardless of dependency graph presence. Added non-graph file viewer/editor with save capability and without "Depends On" section.
- [x] T055: Added live game-idea textarea above AI scaffold prompt in Step 3 of New Project wizard; updates scaffold prompt in real time.
- [x] T056: Tightened AI scaffold prompt template with a complete worked example (`### FILE: src/example.js`), strict "Output ONLY file blocks" rule, ban on abbreviation/truncation, and requirement for closed fenced code blocks.
- [x] T057: Added per-file "▶ Run" button for HTML files (in sidebar and inspector). Verifies dev server reachability via `GET /ping-dev-server` with friendly toast notification if unreachable.
- [x] T058: Implemented "Report Issue" modal generating surgical patch prompts (`### EDIT:`, `<<<<<<< FIND`, `=======`, `>>>>>>> REPLACE`) and extended "Add from clipboard" (`POST /add-from-clipboard`) to auto-detect and apply surgical patches with line-ending normalization and uniqueness checks. 18/18 tests passing in `server/new-project-flow-test.js`.

### Phase 14 Checkpoint
**What's done:**
1. Sidebar mirrors the full project directory on disk, letting users browse and edit any file (e.g., config, markdown, docs) directly.
2. The New Project wizard dynamically embeds user-typed game ideas into the AI scaffold prompt in real time.
3. Scaffold prompt instructions enforce strict, unambiguous output formatting with worked examples.
4. Quick-run button for HTML files checks local dev server health before opening in a new tab.
5. Surgical edit workflow allows error reporting, patch generation, and atomic `### EDIT:` patch application directly from the clipboard.

## Phase 15 — Scope-Aware Context & Outline Packaging (v0.0.3)
- [x] T059: Implemented `server/outline.js` with regex-based lightweight outline generator for JS (function/class/const signatures without bodies), HTML (tagged elements with id/class and scripts), and GDScript. Added disk mtime/size based outline caching with `GET /file-outline` endpoint.
- [x] T060: Added scoped context by default in Report Issue modal: embeds target file outline plus focused surrounding snippet (matching line number or symbol name in error description), with dependency files embedded as interface outlines only.
- [x] T061: Added per-file `[Scoped | Full]` mode toggle pills in Report Issue modal, allowing instant expansion to full source on demand.
- [x] T062: Implemented real-time token and character savings calculation (`POST /scoped-context`), displaying prompt size and percentage saved versus full-file embedding.
- [x] T063: Added non-blocking nudge banner when files cross 800-line threshold suggesting module splitting, with one-click dismiss state persisted in `localStorage`.
- [x] T064: Updated "Package Context for Model" (`POST /package-context`) with the same outline-for-dependencies logic, estimated token display, and full dependencies toggle. 12/12 automated tests passing in `server/scope-context-test.js`.

### Phase 15 Checkpoint
**What's done:**
1. Lightweight, fast outline generators extract clean signature-only outlines for JS, HTML, and GDScript without implementation bodies, backed by an in-memory mtime/size cache.
2. The Report Issue modal defaults to scoped context: target file outline + focused window around the referenced line/symbol, and graph dependencies as outline signatures.
3. Every attached file has an interactive `[Scoped | Full]` toggle pill for instant expansion.
4. Live prompt savings bar displays estimated tokens, character counts, and percentage saved compared to full files.
5. Oversized files ($\ge 800$ lines) trigger a non-blocking suggestion to consider splitting modules for cheaper future edits.
6. "Package Context for Model" reuses the same outline-for-dependencies architecture.

## Blocked / Needs Input
_(append notes here whenever a task can't proceed without a decision from the user — do
not guess and continue)_



