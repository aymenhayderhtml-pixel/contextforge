# TASKS.md

## Phase 0 — Manifest Schema + Server Skeleton
- [ ] T001: Define `server/schema/manifest.schema.json` per docs/ARCHITECTURE.md (node
      types: scene/script/module/asset; contract shape; edges)
- [ ] T002: Write `server/schema/validate.js` — validates any manifest.json against the
      schema and returns clear, specific errors (not just pass/fail)
- [ ] T003: Minimal Node HTTP server (`server/index.js`) serving `/public`, with a
      `POST /extract` endpoint that for now returns a small hardcoded sample manifest
- [ ] T004: Basic graph UI page in `/public`: fetch the manifest, render nodes and edges as
      a plain list first (not a visual graph yet) — the goal is proving the pipeline works
      end to end before making it pretty
- [ ] T005: Manual test: confirm the hardcoded sample manifest flows server → UI correctly

## Phase 1 — Godot Extractor
- [ ] T006: Build `/test-fixtures/godot-sample`: a tiny Godot 4.x project, 3 scenes, at
      least one signal connection between them, one exported var, one ext_resource
      dependency (e.g. a shared script or sub-scene)
- [ ] T007: `godot-extractor.js`: parse `.tscn` files for node structure and
      `ext_resource`/`ext_scene` dependencies
- [ ] T008: `godot-extractor.js`: parse `.gd` files for exported vars, signal
      declarations/emissions, and public function signatures — this is the node's
      "contract"
- [ ] T009: Wire extractor output through the schema validator (T002); iterate until the
      fixture project produces a fully valid manifest
- [ ] T010: Confirm determinism — run twice on the unchanged fixture, diff the two
      manifest.json outputs, must be identical

## Phase 2 — JS / Three.js Extractor
- [ ] T011: Build `/test-fixtures/js-sample`: a tiny Three.js/HTML project, 3–4 modules
      with imports/exports between them
- [ ] T012: `js-extractor.js`: wrap an existing import-graph tool (e.g. `madge`) to get the
      dependency edges — do not hand-write a JS/TS parser from scratch
- [ ] T013: Extend `js-extractor.js` to pull each module's exports as its "contract"
- [ ] T014: Wire through the schema validator against the JS fixture; confirm correctness
      and determinism as in T009/T010

## Phase 3 — Real Graph UI
- [ ] T015: Replace the plain list view with an actual node/edge graph (simple
      force-directed or fixed-grid layout is fine — legibility over polish)
- [ ] T016: Clicking a node opens a side panel showing its contract, what it depends on,
      and what depends on it
- [ ] T017: "Re-extract" button in the UI that re-runs the relevant extractor(s) on demand
      against the currently loaded project path

## Phase 4 — Task Locking (multi-agent safety)
Purpose: prevent two AI sessions (e.g. two Gemini instances, or an agent plus a manual
paste-back) from editing the same file at the same time and corrupting it. See
docs/ARCHITECTURE.md section 7 for the full design before starting.
- [ ] T018: Add a `lock` field to each node in manifest.schema.json (`status`, `holder`,
      `locked_at`); update the validator
- [ ] T019: Implement `POST /lock`, `POST /unlock`, and `GET /locks` endpoints — locking a
      node already locked by a different holder must fail clearly, not silently succeed;
      include a stale-lock timeout so a crashed session can't permanently block a file
- [ ] T020: Graph UI: show a locked node with a visible "in progress" badge naming its
      holder
- [ ] T021: Manual "force unlock" control in the UI, for when the user needs to override a
      stuck lock themselves

## Phase 5 — Context Packager
- [ ] T022: "Package context for this node" — assembles the target file's full content,
      plus interface-only stubs (not full implementations) of its direct dependencies,
      plus a short static conventions snippet, into one copy-pasteable block
- [ ] T023: "Add new scene/module" flow — must call `POST /lock` on the new node's id
      before scaffolding, then scaffolds an empty file with correct boilerplate for its
      engine, plus a generated prompt describing what it needs to connect to and what
      contract it should expose
- [ ] T024: Paste-back box — user pastes AI-generated code for a target file; the write
      must only proceed if the caller holds that node's lock (per Phase 4); writes it to
      the correct path in the target project

## Phase 6 — Validation on Write-back
- [ ] T025: After a paste-back write, re-run the extractor on the changed file(s) only
      (not the whole project) and compare the new contract to what existing dependents
      expect
- [ ] T026: Surface any mismatch clearly before the user commits the change (e.g. "Level1
      expects Player to emit `died()`, but the new Player does not declare that signal");
      release the node's lock once the task is checked off or explicitly abandoned

## Phase 7 — Asset Graph (build after Phases 0–6 work end to end)
- [ ] T027: Treat assets (`.glb`, images, etc.) as leaf nodes with a declared "slot
      contract" (e.g. expected animation names for a rigged character slot)
- [ ] T028: Drag-and-drop UI — dropping a file onto a placeholder node swaps it in and
      re-validates it against the slot's contract

## Phase 8 — Playtest Bug Fixes (carried over from v0.0.1 review)
- [ ] T029: Add `requires` as a real edge type in the graph, not just a field shown in the
      side panel — e.g. `Player.gd -> GameManager` currently has zero graph edges despite
      the panel correctly showing `REQUIRES: GameManager`, which would make an
      actually-used dependency look safe to delete
- [ ] T030: Clear the selected node / side panel whenever a new project path is extracted,
      so switching projects doesn't leave a stale node's details on screen
- [ ] T031: Validate the "+ Add Node" ID field against the chosen engine's expected path
      pattern before scaffolding — currently a value like a bare space with no extension
      is accepted and creates a garbage file path

## Phase 9 — Graph Scaling & Navigation (real projects, not toy fixtures)
Motivating case: a real 80-node project rendered as scattered, mostly-illegible dots
spread across a huge empty canvas — unusable at that scale. The fix is not visual tuning,
it's not rendering the whole flat graph by default.
- [ ] T032: Build a medium-scale fixture (~25-30 nodes, a mix of a few connected clusters
      plus a good number of genuinely orphaned nodes) under `/test-fixtures/godot-large-sample`
      or `/js-large-sample`, so scaling features can be tested repeatably without needing
      the user's real project each time
- [ ] T033: Add zoom (scroll wheel) and pan (drag on empty canvas) to the graph view
- [ ] T034: Add a "Fit to View" button that centers/zooms to show all currently-visible nodes
- [ ] T035: Above a node-count threshold (default ~20, make it configurable), default to
      grouping nodes by containing folder into a single collapsed cluster node showing a
      count (e.g. `scripts/ (12)`) with folder-to-folder edges; clicking a cluster expands
      it in place
- [ ] T036: Add a search box that fuzzy-matches node ids/filenames; matches go full
      opacity, everything else dims, and the view centers on the first match
- [ ] T037: Add "Focus Mode": selecting a node can toggle a view showing only that node
      plus its direct dependencies and dependents (1-hop), dimming/hiding the rest — this
      should be the default lens once a node is selected via search or the context
      packager flow, since a real task only ever needs one node's neighborhood
- [ ] T038: Collect nodes with zero edges into a single collapsible "Unconnected (N)"
      group in a fixed corner instead of positioning them via the force simulation — in
      the 80-node case roughly half the nodes were orphaned test/util files consuming
      most of the visual space for zero information

## Phase 10 — Layout Stability
- [ ] T039: Fix the hover-triggers-shaking bug — hover must be a pure visual style change
      (e.g. highlight border) and must never alter node position or restart/tick the force
      simulation
- [ ] T040: Confirm the force simulation actually cools down (alpha decays to ~0) and stops
      ticking once the initial layout settles; a settled graph must be static, not
      perpetually simulating
- [ ] T041: When a user manually drags a node, pin its position (fixed x/y) so a later
      extract or re-render doesn't reshuffle a manually arranged layout; only an explicit
      reset should release the pin

## Phase 11 — UI / Screen Space Overhaul
- [ ] T042: Make the graph canvas fill all available viewport space and respond correctly
      to window resizing
- [ ] T043: Make the detail panel resizable (drag its left edge) and collapsible, instead
      of a fixed-width overlay
- [ ] T044: Truncate a long project path with an ellipsis and a hover tooltip for the full
      value, instead of letting it push other header controls
- [ ] T045: Add a left sidebar with a searchable tree/list of nodes (grouped by folder) as
      a second way to navigate a large project, kept in sync with graph selection in both
      directions — for real project sizes this is often faster than finding a dot on canvas
- [ ] T046: General layout audit — test explicitly against the large fixture from T032,
      not only the small 6-node fixtures, since scale is specifically where the current
      layout breaks

## Phase 12 — HTML / Web Live Preview Panel
- [ ] T047: Add a collapsible preview panel (small header bar, click to show/hide) that
      embeds an `<iframe>` pointed at a dev server URL typed in by the user (e.g.
      `http://localhost:5173`) — do not attempt automated screenshot capture for this
      version; it would require bundling a headless browser for something an iframe
      already solves
- [ ] T048: Persist the last-used preview URL per project so it doesn't need retyping each
      session
- [ ] T049: Only offer/show the preview panel for projects that contain at least one
      JS/HTML node, not for Godot-only projects

## Phase 13 — New Project Wizard + Progress Dashboard
- [ ] T050: "+ New Project" button opens a wizard: target folder (must not already contain
      a manifest), engine (Godot / JS / mixed), project name
- [ ] T051: On submit, scaffold the target folder's base structure for the chosen engine,
      AND generate the AI-agent-loop doc set for that new game project — GEMINI.md,
      LOOP.md, TASKS.md, docs/ARCHITECTURE.md — using the same doc pattern ContextForge
      itself was bootstrapped with; this automates a step currently done by hand for every
      new game project. Then run an initial `/extract` so the new project shows up in the
      graph immediately, even if nearly empty
- [ ] T052: Add a "Progress" view that parses the target project's own TASKS.md checkbox
      state (`- [ ]` / `- [x]`) and renders it as a phase-by-phase checklist/progress bar
      inside ContextForge's UI
- [ ] T053: Refresh the Progress view when TASKS.md changes on disk (poll or file-watch)
      so it reflects an agent's progress live during a session

## ⚠ Reconciliation note (this sandbox copy vs. the real project)
An independent code audit (a separate AI reading the actual live repo, not this copy)
found that the real on-disk TASKS.md already has a **Phase 14 — Disk File Explorer**
(T054–T058) and **Phase 15 — Scope-Aware Context & Token Budgeting** (T059–T064), built
and tested, that were never described in this file. They were built directly against the
live project in a session this copy never saw. The "Phase 14 — Patch Safety & Reliability"
and "Phase 15 — Preview & Bug-Report Capture" previously drafted here used the *same* task
IDs for completely different work — a collision. The agent building against the real file
caught this itself (per LOOP.md's "don't guess, log it" rule) instead of overwriting
anything, which is exactly the intended failure mode.

This copy has been corrected below to document the real Phase 14/15 (reconstructed from
the audit, since this sandbox never had their true source text) and to renumber the
patch-reliability work starting after them. **Task IDs below Phase 16 are illustrative,
not authoritative** — the agent must always compute the next free ID from the real,
current TASKS.md, never from this copy, exactly as LOOP.md's resume rule already requires.

## Phase 14 — Disk File Explorer *(reconstructed from audit; already built)*
- [x] T054: `GET /file-tree` + sidebar showing all files on disk (not just graph nodes);
      non-graph files open in a raw viewer with Save, no "Depends On" section
- [x] T055: New-project wizard's scaffold-prompt textarea live-updates as the idea is typed
- [x] T056: Generated scaffold prompt includes a worked file-block example and explicit
      "output only file blocks / never truncate / close every fence" instructions
- [x] T057: "▶ Run" button for `.html` files (sidebar + inspector), wired to the dev-server
      lifecycle
- [x] T058: Report Issue modal + AI-edit-block apply/patch engine with multi-pass anchor
      matching (exact → line-number-stripped → trim → boundary-anchor → similarity-based),
      CRLF normalization, and already-applied idempotency

## Phase 15 — Scope-Aware Context & Token Budgeting *(reconstructed from audit; already built)*
- [x] T059: `server/outline.js` — per-file outline generation (JS/HTML/GDScript) with an
      mtime/size-validated cache; `GET /file-outline`
- [x] T060: Issue-report file rows default to "scoped" mode; `POST /scoped-context` sends a
      relevant-window snippet for the target file and outline-only for its dependencies
- [x] T061: Per-file "Scoped | Full" toggle pill in the issue modal
- [x] T062: Token/char savings estimate shown for the scoped vs. full context size
- [x] T063 (partial): oversized-file banner nudging toward scoped mode — the one-click
      dismiss-and-remember-via-localStorage part described in ISSUES.md is not yet built
- [x] T064: `/package-context` reuses the same outline cache and respects `scoped:false`

## Phase 16 — Audit Fixes: Broken/Hidden UI, Correctness, Security
An external audit of the real codebase found several already-"complete" tasks are not
actually reachable or correct. Do these before further feature work — some of them make
existing, tested backend work unusable from the UI, and one is a real security gap.

**Do first (highest severity / cheapest fixes):**
- [x] T065: Fix `ReferenceError: projectConsoleLogs is not defined` in `server/routes/console.js`
      (~line 85) — imported `projectConsoleLogs` from `console-manager.js`; automated test added and passing
- [x] T066: Fix the dead "⚠ Force Unlock" button — pointed `forceUnlock` in `detail-panel.js` at real `POST /unlock` with `{ nodeId, force: true }` and added server route alias; automated test passing
- [x] T067: Unhide and wire `#btn-add-node` and `#btn-new-project` — unhidden in controls header; created `add-node-modal.js` calling `POST /scaffold`, wired both buttons in `app.js`; automated tests passing
- [x] T068: Restrict CORS — restricted file-writing endpoints (`/save-file`, `/add-from-clipboard`, `/swap-asset`, `/paste-back`, `/scaffold`) and preflight to same-origin/localhost allowlist, blocking external web pages from project mutations while preserving local dev telemetry; automated test passing

**Do next:**
- [x] T069: Wire the remaining dead buttons: `#btn-pause-game`, `#btn-stop-game`,
      `#btn-open-godot`, `#btn-preview-reload`, `#btn-preview-newtab`, `#btn-term-report`,
      `#btn-toggle-preview` — all 7 buttons wired to their respective endpoints and handlers in `app.js` and `preview.js`; automated tests passing
- [x] T070: Build the missing paste-back UI (side-panel textarea + session-holder input +
      lock-claim button) for T024 — implemented in `detail-panel.js` with holder input, lock claim/release, code textarea, and dependent contract validation feedback; automated tests passing
- [x] T071: Add the 10-second lock auto-poll originally described for T020 — implemented `startLockPolling()` on 10s interval in `app.js`, refreshing lock rings and badges live; automated test passing
- [x] T072: Fix the path-traversal check gap in `/swap-asset` — replaced raw join with `resolveProjectPath`, added automated path traversal test in `server/asset-graph-test.js`
- [x] T073: Confirm where D3 is actually loaded from in `index.html`/`render.js` and record it — confirmed loaded via CDN script tag `<script src="https://d3js.org/d3.v7.min.js"></script>` in `<head>` of `index.html`; added HTTP page-load test verifying asset availability and D3 usage in `server/workstation-session-test.js`
- [x] T074: Remove the committed `test-fixtures/js-sample/"scene 1"` artifact and committed sidecars; add to `.gitignore` — removed leftover artifact and sidecar from git/disk; added `.contextforge.*` to `.gitignore`; automated test added
- [x] T075: Resolve the `docs/TASKS.md`/`docs/GEMINI.md`/`docs/LOOP.md` vs. root-file ambiguity — added archival notes to docs/ headers; updated `parseProjectProgress` to explicitly track `tasksFilePath` and guarantee resolution against active project root; automated test added

### Phase 16 Checkpoint: Audit Fixes Completed
- All 11 audit tasks (T065–T075) implemented and verified.
- All dead UI buttons wired, CORS restricted against malicious web origin writes, path traversal blocked on asset swapping, paste-back UI rendered and functional with lock workflow, 10s auto-polling live, D3 load mechanism documented with page test, and root tasks resolution verified.
- Entire test suite (`npm test`) passing with 0 failures across 180+ tests.


## Phase 17 — Patch Safety & Reliability
(This is the work originally planned as "Phase 14" before the ID collision was found. The
1-click Undo Patch item was already built and tested in the session that hit the
collision — record it here under its correct, non-colliding ID rather than the mistaken
"T054" it was built under.)

- [x] T076: Undo Patch — one-click revert of the most recently applied patch from the
      verification banner, wired to `POST /history/undo`; automated test added and passing
- [x] T077: Pre-save in-memory syntax check before writing a pasted patch to disk — implemented `validateContentSyntax` for JS and GDScript in `console-manager.js`, integrated pre-check into `applyAiEditBlocks` and `writeAiFilesToProject` returning 422 `preCheckFailed`, added "Apply Anyway" and "Reject Broken Patch" banner buttons; automated test passing
- [x] T078: Whitespace/formatting drift tolerance in the patch anchor matcher — added Pass 4b (punctuation-spacing normalization) and Pass 4c (blank-line drift tolerance) to `findTargetMatch`; automated test passing
- [x] T079: Overlapping edit block handling — implemented sequential re-anchoring and diagnostic overlap detection in `applyAiEditBlocks`; automated test passing
- [x] T080: Interactive diff preview drawer — added `POST /preview-diff`, `generateUnifiedDiff` in `diff-generator.js`, `diff-drawer.js` component, and `🔍 Preview Diff` button in workstation pane; automated test passing
- [x] T081: Smart target-file auto-attach from stack-trace `file:line` references — updated `rankRelevantFiles` to preserve parsed stack `line`, passed to `/scoped-context` for focused snippet extraction, auto-selected in problem pane; automated test passing

### Phase 17 Checkpoint: Patch Safety & Reliability Completed
- All 6 patch safety tasks (T076–T081) implemented and verified.
- Broken AI patches are blocked in memory before disk write with one-click "Apply Anyway" / "Reject Broken Patch" choice.
- Formatting and punctuation drift in anchors tolerated without ambiguity.
- Overlapping edit blocks diagnosed and re-anchored.
- Interactive diff preview drawer renders visual before/after changes with colored line additions/deletions.
- Stack trace `file:line` auto-detected and focused in scoped context.
- All 190+ automated tests across the test suite passing cleanly.


## Phase 18 — Preview & Bug-Report Capture
(Scoped down from the agent's original "Phase 3: Runtime & Preview" proposal. Most of the
live-preview drawer already exists per Phase 12/16 — confirm before rebuilding anything.)
- [ ] T082: Wire up the "+ Add Screenshot" control in the Problem pane to actually capture the
      preview canvas and attach it to the Evidence Package (unconfirmed either way — check
- [ ] T083: (optional, low priority) live FPS/draw-call HUD in the preview bar

## Phase 19 — OpenCode UI Redesign & 1-Click Polish
- [x] T084: Minimal Developer-Tool Toolbar Layout — re-architected top toolbar into clean 3-zone structure (Project path/files, Playback trio, Action utilities) and relocated view toggles & utilities to header right, completely eliminating horizontal scrolling across viewport sizes down to 1100px.
- [x] T085: Files Dropdown Elevation — resolved toolbar clipping by setting `overflow: visible` on `.controls` and elevated z-index (`9999`) on `.dropdown-menu`.
- [x] T086: D3 Node Hover Stabilization — eliminated hover flickering on graph nodes by setting `pointer-events: none` on text/lock substrates and replacing continuous D3 transition timers with native CSS transitions (`transition: stroke-width 0.12s ease`).
- [x] T087: Horizontal Playback Control Expansion — updated playback cluster (`[▶]`, `[❚❚]`, `[■]`) to smoothly expand horizontally on hover (`[▶ Play]`, `[❚❚ Pause]`, `[■ Stop]`) with subtle contextual color highlights and zero layout jitter.
- [x] T088: Direct `⚡ Paste & Run` (Zero Confirmation Modal) — renamed button to `⚡ Paste & Run`, removed `hasAiBlocks` modal gate and error popups, enabling instant 1-click clipboard ingestion, project re-extraction, and automatic dev server launch.
- [x] T089: Documentation Consolidation & Cleanup — removed redundant archival copies (`docs/GEMINI.md`, `docs/TASKS.md`, `docs/LOOP.md`), leaving the repository root as the single source of truth; synchronized `README_FOR_AI.md` and comprehensively updated `README.md`.

### Phase 19 Checkpoint: OpenCode UI Redesign & Polish Completed
- All 6 redesign & polish tasks (T084–T089) completed and verified.
- Toolbar clean, restrained, professional, with zero horizontal scroll.
- Playback controls expand smoothly on hover.
- 1-click `⚡ Paste & Run` operates directly without modal confirmations.
- All duplicate docs eliminated; test suite passing 100% (190+ tests).

## Deferred / Not yet scheduled
- Procedural Web Audio engine preset for template projects — pair with new-project
  scaffolding (Phase 13), not urgent on its own.
- Godot 4.x headless test runner on patch apply — revisit once Phase 17's syntax-check
  task is proven out; this should extend that same system for Godot, not be a separate one.

## Blocked / Needs Input
_(append notes here whenever a task can't proceed without a decision from the user — do
not guess and continue)_
- [RESOLVED] T054–T059 collision: reconciled into Phase 16, 17, and 18.
- [RESOLVED] Duplicate docs in `docs/`: removed `docs/GEMINI.md`, `docs/TASKS.md`, and `docs/LOOP.md` so root files are the canonical single source of truth.

