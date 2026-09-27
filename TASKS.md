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

## ⚠ v0.0.3 note
v0.0.3's brief: **no new features — make existing flows more robust.**
Phases 20–25 build on the existing headless routes and interfaces.

## Phase 20 — Headless Test Harness (foundation for everything below)
Every phase after this one needs to drive ContextForge without a human clicking through
the UI, so build this first.
- [x] T090: Documented every route needed to drive the full loop headlessly in `docs/HEADLESS_API.md` (init-project, extract, file-tree, file-content, save-file, rank-relevant-files, scoped-context, preview-diff, add-from-clipboard, undo/redo, console-logs, compare-verification, locks, devserver).
- [x] T091: Added headless screenshot evidence attachment support (`screenshotBase64`) in `POST /scoped-context` prompt compilation and verified with automated test.
- [x] T092: Built `scripts/headless-runner.js` providing both CLI commands and the programmatic `HeadlessClient` class; added `server/headless-harness-test.js` to test suite.

### Phase 20 Checkpoint: Headless Test Harness Completed
- Complete headless API documented in `docs/HEADLESS_API.md`.
- `HeadlessClient` in `scripts/headless-runner.js` allows subagents and scripts to drive all ContextForge features headlessly with single-call chaining (`runInvestigation`).
- Automated tests passing in `npm test`. Ready for blind obstacle-finding in Phase 21.

## Phase 21 — Blind Obstacle-Finding Test Suite
(Have an agent build a new project and try to use it *without* reading ContextForge's own source, to find real friction rather than friction the agent already knows how to route around.)
- [x] T093: Defined and deployed independent `qa-headless-tester` subagent role, restricted exclusively to `docs/HEADLESS_API.md` and CLI runner with zero ContextForge internal source access.
- [x] T094: Executed blind black-box tests across JS Three.js fixture, Godot 4.x fixture, and multi-file causal dependency scenarios (error in File B caused by state deletion in File A; verified ranking, context expansion, and recovery).
- [x] T095: Triaged all discovered obstacles into exactly 3 buckets:
  - **Code Bugs**: Fixed missing `apply` command in `scripts/headless-runner.js`, normalized `POST /compare-verification` array inputs, fixed engine desync in `POST /scoped-context`, and aliased `POST /game/launch` to Godot runner.
  - **Doc Gaps**: Fixed `docs/HEADLESS_API.md` schemas for `/file-tree` (array of objects), `/init-project` keys, `/add-from-clipboard` syntax error structure, and code fence requirement for `### FILE:`. Added `clear` option to `HeadlessClient.getConsoleLogs`.
  - **Prompt / Template Gaps**: Routed to Phase 25 (removing hardcoded Three.js sample paths from Godot handoffs, and clarifying `### FILE:` for full file replacement).

### Phase 21 Checkpoint: Blind Obstacle-Finding Completed
- QA subagent executed 3 distinct project test scenarios headlessly.
- Multi-file bug scenario and `CONTEXT INSUFFICIENT` cycle verified end-to-end.
- 4 code bugs fixed, 5 doc gaps corrected, and 2 prompt template gaps identified and routed to Phase 25.
- All automated tests passing (100% pass across 19 suites).

- [x] T096: Collected and saved real AI model response fixtures under `test-fixtures/multi-model-patches/` for Claude, ChatGPT, Gemini, and DeepSeek, capturing natural variations in fence formatting, markdown wrappers (`**### EDIT: \`path\`**`), and indentation conventions.
- [x] T097: Verified all model fixtures through the patch engine (`server/multi-model-patch-test.js`). Hardened `parseAiEditBlocks` regex to tolerate markdown bold wrappers, backtick-enclosed paths, and arbitrary code fence tags. Added suite to `npm test`.

### Phase 22 Checkpoint: Multi-Model Patch-Format Robustness Completed
- 4 real model fixtures collected and tested against live GDScript targets.
- Header variations (bolding, backticks, fenced vs unfenced) parsed cleanly without failure.
- `applyAiEditBlocks` applies each model's output without manual reformatting.
- Test suite passing 100%. Ready for Phase 23.

## Phase 23 — Console/Diagnostics Pipeline Hardening
(Harden this because a browser-based AI with no file/tool access — someone
pasting a bundle into a plain chat UI — depends *entirely* on what this pipeline hands it.
There's no second chance for it to go look at the file itself.)
- [x] T098: Fixed known false-positive sources in `validateContentSyntax` (tolerant parsing of `#` inside single/double quotes and triple-quoted docstrings without falsely truncating code lines as comments).
- [x] T099: Added explicit, directly testable "evidence completeness" contract in `server/diagnostics-hardening-test.js` asserting exact error location (file:line), the exact broken line of source in the scoped window, and public contract signatures of caller/callee.
- [x] T100: Audited and hardened `isErrorLine` in `console-manager.js` to exclude false-positive classes (info/debug logs, HTTP 200 telemetry requests, zero-error status messages, and player names containing error substrings). Added to `npm test`.

### Phase 23 Checkpoint: Console/Diagnostics Pipeline Hardening Completed
- Evidence completeness contract ensures downstream browser AI receives exact location, broken lines, and caller signatures verbatim.
- `isErrorLine` false-positive exclusions prevent pollution of `redLogs` error buffer.
- `validateContentSyntax` reliably handles complex GDScript and JS strings.
- 100% test pass across 21 test suites. Ready for Phase 24.

- [x] T101: `POST /add-from-clipboard` intercepts `CONTEXT INSUFFICIENT: [file/function]` responses cleanly, resolving requested paths against the loaded project file tree and returning `{ isContextInsufficient: true, requestedFiles: [...] }` without failing or corrupting files on disk.
- [x] T102: Workstation frontend and headless client auto-expand context by adding requested files in `full` source mode and automatically triggering prompt recompilation and clipboard updates. Interactive UI banner informs user of expanded context. Added automated test `server/context-insufficient-test.js` to `npm test`.

### Phase 24 Checkpoint: Context-Insufficient Loop Closure Completed
- AI responses requesting more context via `CONTEXT INSUFFICIENT:` are intercepted as first-class workflow signals.
- Requested files are extracted and auto-attached in full source mode.
- Interactive banner in UI and headless API allow seamless multi-turn expansion.
- Automated tests passing 100%. Ready for Phase 25.

## Phase 25 — Prompt Template Quality & Regression Tracking
(When a test finds an issue, if it's fixable by improving the prompt, fix the
prompt, not just the code around it.)
- [x] T103: Treated generated prompt templates as versioned artifacts and built automated test suite `server/prompt-template-quality-test.js` asserting mandatory structural presence of issue descriptions, console errors, target file snippets, outlines, and strict surgical contracts.
- [x] T104: Resolved prompt ambiguities surfaced in Phase 21 & 22:
  - Made `getStrictPatchContract` engine-aware (`godot` vs `js`), preventing Three.js sample paths from leaking into Godot handoffs.
  - Explicitly clarified in prompt templates that `### FILE:` can be used for complete file rewrites when surgical edits are impossible.
- [x] T105: Folded the complete surgical edit contract directly into ContextForge's project conventions block (`CONVENTIONS_SNIPPET` in `server/routes/context.js`), ensuring grounded edits, `CONTEXT INSUFFICIENT:` requests, and contract preservation are embedded without needing external system prompts.
- [x] T106: Blind Downstream AI Code-Generation Sufficiency Test — invoked a downstream coding subagent given *only* the compiled prompt bundle (via `POST /scoped-context`), without tool or file access, simulating a downstream LLM in a web chat interface. Verified:
  - Enhanced `generateJsOutline` in `server/outline.js` to extract method signatures inside exported classes and object literals (`export const MathUtils = { clamp, clampDelta, lerp }`), eliminating previously blank interface contracts.
  - Tested positive sufficiency: downstream AI produced a working surgical patch grounded in `MathUtils.lerp`/`clamp` that applied with verified syntax and zero contract guessing.
  - Tested negative insufficiency: downstream AI cleanly triggered `CONTEXT INSUFFICIENT:` when asked for unprovided dependencies (`src/asset-loader.js`, `src/scene-manager.js`), expanding the bundle.
  - Added automated test suite `server/downstream-ai-sufficiency-test.js` to `npm test`.

### Phase 25 Checkpoint: Prompt Template Quality & Regression Tracking Completed
- All generated prompt templates are regression-tested with structural assertions.
- Prompts dynamically adapt to engine context (Godot vs JS/Three.js).
- Complete surgical edit contract and `CONTEXT INSUFFICIENT` protocol are baked directly into generated prompts.
- Downstream AI code generation test proves prompts supply sufficient ground truth for downstream LLMs without file access.
- All 24 test suites passing cleanly with zero failures (200+ tests). v0.0.3 brief achieved.

## Phase 26 — Post-v0.0.3 Practical Workflow Hardening
- [x] T107: Gate "Fix This Issue" compilation on non-empty issue description or captured runtime error — reject empty handoffs in `/scoped-context` with HTTP 400 and provide active feedback/highlighting in workstation UI to prevent stale-selection focused snippet generation.
- [x] T108: SceneManager interface stub verification & class outline extraction — verify `src/scene-manager.js` class outline extracts all methods (`constructor`, `addEntity`, `removeEntity`, `start`, `stop`, `_loop`), supports `export default class`, classes with `extends`, `export default function`, `export default` objects, and handles methods with default parameter values without truncation.
- [x] T109: Incremental Phase 0/1 scoping in scaffold prompt anchored to `TASKS.md` — update `generateScaffoldPrompt` in `wizard.js` to instruct the AI to inspect `TASKS.md` and implement Phase 0/1 foundation only, prohibiting one-shot whole-game hallucinations.
- [x] T110: Scaffold prompt context completeness and `CONTEXT INSUFFICIENT` protocol — include scaffolded base file contents in prompt and provide the `CONTEXT INSUFFICIENT` escape hatch so AI can request missing configs without guessing.

### Phase 26 Checkpoint: Post-v0.0.3 Practical Workflow Hardening Completed
- "Fix This Issue" rejects handoff generation with HTTP 400 when both issue description and console logs are empty, and workstation UI alerts user and clears stale line selections.
- `generateJsOutline` extracts methods across `export class`, `export default class`, `class`, `export default function`, and `export default` objects, preserving complex default parameters (arrow functions, objects, and function calls) without string or paren truncation.
- New project scaffold prompt explicitly anchors downstream AI to `TASKS.md` Phase 0/1 Foundation only, provides initial scaffolded file contents, and supports `CONTEXT INSUFFICIENT:` protocol.
- All 25 test suites pass cleanly end-to-end (`npm test`).

## ⚠ v0.0.3.1 note
Found by live-testing the New Project wizard end-to-end (HTML/Three.js and Godot paths,
including pasting real AI responses back through the full fix loop) rather than by
self-testing. As always: compute real next task IDs from the actual TASKS.md, not from
this sandbox copy.

## Phase 27 — v0.0.3.1: Live Playtest Findings

### P0 — do this first, it's the most important bug found this version
- [x] T111: **Root-cause and fix the silent partial multi-file patch-apply bug.** Reproduced with saved live session fixture `test-fixtures/multi-model-patches/sky-duel-4block-mixed-response.txt`: parsers found all 4 blocks, but `/add-from-clipboard` and `/preview-diff` short-circuited on `editBlocks.length > 0`, silently bypassing `fileBlocks`. Unified both routes to apply and diff mixed edits and files together, record atomic multi-file history transactions with full undo/redo (unlinking new files on undo), report true counts in the UI banner (`3 edit(s), 1 file(s) in 4 file(s)`), and explicitly list failed blocks; permanent regression test suite `server/mixed-patch-regression-test.js` added and passing.

### Do next — real bugs found this session
- [x] T112: Fixed Godot card description and scaffold alignment. Default Godot scaffold now generates a typed `Node2D` scene root in `scenes/main.tscn` and `extends Node2D` in `scripts/main.gd`. Step 1 wizard card accurately describes: "Godot 4.x project with Node2D or Node3D root scene, GDScript, and native editor launcher."
- [x] T113: Added real 2D vs 3D dimension selector in Step 1 of the New Project wizard (`godot-dimension-group`, `dimension: '2d' | '3d'`). Backend `scaffoldNewProject` generates typed `Node2D` root & `extends Node2D` for 2D, and typed `Node3D` root & `extends Node3D` for 3D. Verified in `server/playtest-hardening-test.js`.
- [x] T114: Fixed `project.godot`'s `config/name` to write the properly-cased human project title (e.g. `config/name="Sky Duel"`), preserving casing for player-visible window title and Godot Project Manager, while preserving the slug for disk directory and package naming.
- [x] T115: Fixed HTML/Three.js scaffold dead `<div id="game-container">`. Updated `src/main.js` to mount the WebGLRenderer canvas into `document.getElementById('game-container')` and size it cleanly, and added CSS styling for `#game-container` in `src/style.css`.
- [x] T116: Added "Mixed (Godot + Web)" as a selectable 3rd engine card on Step 1 of the wizard (`id="card-engine-mixed"`), styled the 3-column engine card grid in `public/css/modals.css`, and verified dual-engine scaffolding end-to-end.

### Worth investigating — found but not fully diagnosed
- [x] T117: Confirmed and fixed: JS extractor previously ignored HTML files. Updated `server/extractors/js-extractor.js` with `findHtmlFiles` and `parseHtmlScriptReferences` to extract `index.html` (and other HTML entry points) as `scene` nodes with `kind: 'import'` dependency edges to referenced `<script type="module" src="...">` files.
- [x] T118: Fixed smart target-file auto-attach for structural/whole-scene issues. Removed arbitrary anywhere-in-file token matching from `extractScopedSnippet` so issues without explicit runtime lines or declaration matches return `null` instead of guessing arbitrary lines. Updated `/scoped-context` in `server/routes/context.js` to provide full file structural context under the symbol outline for standard-sized files.
- [x] T119: Implemented automatic owning `.tscn` inclusion for Godot issues indicating scene-tree or rendering problems. In `rankRelevantFiles` (`context-compiler.js`) and `/scoped-context` (`context.js`), detected scene/rendering keywords (`scene`, `tscn`, `node`, `tree`, `render`, `visual`, `camera`, etc.) against `.gd` scripts, boosting and auto-attaching the owning `.tscn` alongside its `.gd` script into the handoff bundle.

### Verify explicitly — unconfirmed, not necessarily bugs
- [x] T120: Confirmed surgical `### EDIT:` patching on Godot `.gd` and `.tscn` files. Created automated test in `server/playtest-hardening-test.js` verifying a multi-file surgical edit against `scripts/hero.gd` and `scenes/hero.tscn`, confirming single-line modifications apply cleanly with valid syntax without requiring full file rewrites.
- [x] T121: Confirmed and fixed screenshot evidence flow. Identified that `public/js/workstation/workstation.js` omitted `screenshotBase64` when compiling `/scoped-context`. Updated `workstation.js` to pass `screenshotBase64: payload.screenshotBase64`, verifying screenshot evidence embeds cleanly into the AI Evidence Package.
- [x] T122: Confirmed Runtime Error box manual re-check behavior is intentional to prevent feedback loops. Improved UX by tracking `hasRunLiveCheck` and explicitly displaying: "⚠️ Runtime check not run yet for this state. Click 🔄 Re-check to run compiler & runtime checks", transitioning to "✓ Verified: No compiler or runtime errors detected" only after a check is run.
- [x] T123: Added permanent regression test and saved live session fixture `test-fixtures/multi-model-patches/visual-polish-prose-preamble.txt` containing 1,251 characters of reasoning/prose preamble before the first code marker. Verified `parseAiFileBlocks` and `parseAiEditBlocks` cleanly ignore prose without leakage into file content.

### Phase 27 Checkpoint: v0.0.3.1 Live Playtest Findings Completed
- All 13 tasks (T111–T123) completed, verified, and backed by automated regression tests in `server/playtest-hardening-test.js` and `server/mixed-patch-regression-test.js`.
- Wizard scaffolding produces clean, typed 2D (`Node2D`) or 3D (`Node3D`) Godot projects with proper title casing.
- HTML/Three.js scaffold actively mounts into `#game-container` with styled CSS.
- Mixed engine option exposed as selectable card in Step 1.
- JS extractor treats `index.html` as scene node with script dependency edge.
- Structural issues fall back to file-level context without arbitrary line guessing.
- Godot scene-tree issues auto-attach owning `.tscn` scene.
- Surgical edits on `.gd` and `.tscn` files verified end-to-end.
- Screenshot base64 evidence wired into AI context handoff.
- Runtime Error box UX explicitly communicates unverified vs verified clear state.
- Long reasoning/prose preambles safely parsed without content corruption.
- 100% pass across all 27 test suites in `npm test`.

## ⚠ v0.0.4 note
Scope for this first phase, per direct instruction: the asset **swap subsystem only**.
Blender integration / prompt-driven modeling / rigging / animation are explicitly deferred
to a later v0.0.4 phase, not part of this one. As always, compute real next task IDs from
the live TASKS.md, not from this sandbox copy.

## Phase 28 — v0.0.4: Asset Swap Subsystem

- [x] T124: Implemented cross-project persistent favorites library: stored outside projects at ~/.contextforge/favorites.json (CF_FAVORITES_DIR configurable) via server/favorites-manager.js; supports starring assets with metadata, format, tags, and thumbnails; exposed REST endpoints in server/routes/favorites.js; automated tests in server/favorites-test.js passing 100%.
- [x] T125: Added "Browse..." file-picker button alongside drag-and-drop swap target in public/js/panel/detail-panel.js; unified file validation and swapping through /validate-asset and /swap-asset; automated tests passing 100%.
- [x] T126: Built contract-filtered favorites picker UI in public/js/panel/favorites-modal.js: reuses Phase 7 slot contract validation to hide incompatible favorites by default and allows 1-click swap-into directly from cross-project library; automated unit and integration tests passing 100%.
- [x] T127: Baked tooling convention into JS/Three.js scaffold: exposed live scene, camera, renderer, and tagAsset exclusively on window.__CONTEXTFORGE_GAME__; exported tagAsset in scene-manager.js; loadModel in asset-loader.js automatically tags returned objects with path as asset id; documented convention in docs/ARCHITECTURE.md and wizard prompt; automated tests verify loadModel tag output.
- [x] T128: Extended diagnostics bridge (public/contextforge-bridge.js) with click/raycast listener: computes NDC from canvas bounds, raycasts against exposed scene, walks up parent chain to resolve tagged root Object3D (userData.cfAssetId/assetId), messages CF_ASSET_SELECTED to ContextForge via postMessage and client-log, handles camera drag disambiguation, and emits CF_PREVIEW_CLICK_MISSING_SCENE when no scene exposed; automated tests in server/preview-raycast-test.js passing 100%.
- [x] T129: Wired live preview click into UI: public/js/app.js handles CF_ASSET_SELECTED, resolves asset nodes via public/js/shared/asset-resolver.js across exact/normalized/suffix/basename forms, and immediately invokes selectNode(node.id) to open the asset's swap panel without requiring manual searching; automated tests in server/asset-selection-integration-test.js passing 100%.
- [x] T130: UI polish on asset selection by name (no editor selection sync): clicking asset files by name in sidebar tree (tree.js) routes directly to selectNode swap panel in 1 click; detail panel syncs sidebar tree selection and adds an "Open in Godot" editor launch shortcut for Godot assets; automated unit & integration tests passing 100%.
- [x] T131: Handled missing exposed scene detection: added #preview-scene-notice banner in public/index.html with dismiss action; app.js intercepts CF_PREVIEW_CLICK_MISSING_SCENE and renders prominent warning toast + banner + diagnostics log instead of silent no-ops; automated tests in server/asset-selection-integration-test.js passing 100%.

## Deferred (later v0.0.4 phase, not this one)
- Blender integration: prompt-compile → paste to browser AI → paste back Python → run
  headless → validate against slot contract, per the earlier discussion.
- A real Godot-editor-plugin selection sync (clicking a node in the actual Godot editor
  reports back to ContextForge live) — bigger lift than the file-based flow in T130;
  worth reconsidering only if that flow proves annoying in practice.

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

