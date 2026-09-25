# docs/ARCHITECTURE.md — Technical Spec

This is the authoritative design reference for the loop. If code and this doc disagree,
stop and log it in TASKS.md rather than picking one silently.

## 1. Manifest schema (conceptual shape — implement as JSON Schema in T001)

```json
{
  "project_root": "string, absolute path to the target game project",
  "generated_at": "ISO timestamp",
  "nodes": [
    {
      "id": "string, path relative to project_root, e.g. scenes/Player.tscn",
      "engine": "godot | js",
      "type": "scene | script | module | asset",
      "contract": {
        "exports": ["e.g. speed: float", "e.g. export function getScore()"],
        "signals": ["Godot only, e.g. died()", "health_changed(new_value)"],
        "requires": ["autoloads/singletons/globals this node assumes exist"]
      },
      "depends_on": ["node ids this node references directly"],
      "depended_on_by": ["computed — node ids that reference this one; never parsed directly, always derived from the full edge set"]
    }
  ],
  "edges": [
    { "from": "node id", "to": "node id", "kind": "ext_resource | signal_connection | import | asset_ref" }
  ]
}
```

Notes:
- `depended_on_by` must be computed once all nodes/edges are known — do not have the
  extractor try to fill this in per-file, or it will be wrong for anything parsed earlier
  in the run.
- `contract.signals` only applies to Godot nodes; `contract.exports` applies to both,
  named appropriately per engine (Godot exported vars vs. JS `export`).

## 2. Extractor interface

Every extractor is a single function with this shape, regardless of engine:

```js
// input: absolute path to the project root
// output: { nodes: [...], edges: [...] } — NOT yet validated or contract-resolved for depended_on_by
async function extract(projectPath) { ... }
```

The server (not the extractor) is responsible for:
- Merging output from all applicable extractors for a project (a project may be pure
  Godot, pure JS, or mixed if that ever comes up).
- Computing `depended_on_by` from the merged edge set.
- Validating the merged result against `manifest.schema.json`.
- Writing the final `manifest.json`.

This keeps extractors simple, single-purpose, and easy to add to later (a third engine is
one new file implementing this same function signature).

## 3. Godot extraction specifics
- `.tscn` files: parse `[ext_resource ...]` and `[sub_resource ...]` headers for
  dependencies; parse `[node ...]` blocks for structure; parse `[connection ...]` blocks
  for signal wiring between nodes/scenes.
- `.gd` files: parse `@export`/`export` var declarations, `signal` declarations, and
  top-level `func` declarations that aren't prefixed `_` (Godot convention for "private").
  Treat these as the script's public contract.
- A scene's contract is the union of its root script's contract plus any signals the scene
  itself re-exposes.

## 4. JS/Three.js extraction specifics
- Use `madge` (or equivalent) in JSON output mode to get the import graph — don't
  reimplement module resolution.
- For each module's contract, parse its `export` statements (named and default) — a
  lightweight regex or the TypeScript compiler API (`ts-morph`) both work; prefer whichever
  is less code to maintain.
- Treat non-JS assets referenced via import (textures, `.glb` models loaded through a
  loader call) as asset-type nodes with an edge from the importing module.

## 5. Server API (Phase 0 onward, extend as needed)

| Method | Path | Purpose |
|---|---|---|
| POST | `/extract` | Run extractor(s) against a given project path, write manifest.json |
| GET | `/manifest` | Return the current manifest.json for the loaded project |
| POST | `/package-context` | Given a node id, return the assembled context bundle (T018) |
| POST | `/scaffold` | Given a new node's type/engine/name, return boilerplate + a generated prompt (T019) |
| POST | `/paste-back` | Given a node id and code, write the file, re-extract just that node, validate contract against dependents (T020–T022) |

## 6. Task locking (multi-agent safety)

**Problem:** two AI sessions — two agent instances, or an agent plus a manual paste-back —
can end up editing the same file at the same time. The result breaks regardless of how
carefully either side worked; this isn't a "the AI made a mistake" bug, it's a coordination
gap. Splitting by line ranges does not fix this: line numbers shift as soon as either side
adds or removes a line, so a "lines 41–80" boundary silently stops meaning what it meant a
minute earlier. Locking at the **node (file) level** avoids that entirely, and matches how
tasks are already scoped in TASKS.md — one task, one node.

**Schema addition** — every node gets a `lock` field:
```json
"lock": {
  "status": "free | locked",
  "holder": "string, free-form session/agent identifier",
  "locked_at": "ISO timestamp"
}
```

**Rules:**
- Before any session begins a task that will modify a node — via `/scaffold`,
  `/paste-back`, or a directly reported manual edit — it must call `POST /lock` with the
  node id and a session identifier.
- `/lock` fails if the node is already locked by a different holder. The requesting
  session must not proceed to edit that file; it should pick a different task or wait.
- The lock holder calls `POST /unlock` when the task is checked off in TASKS.md, or when
  it's abandoned and logged under "Blocked / Needs Input."
- Add a stale-lock timeout (a reasonable default, e.g. auto-release after a period of no
  activity) so a crashed or abandoned session can't permanently block a file.
- The graph UI shows a locked node with a visible "in progress by <holder>" badge, so a
  human glancing at the graph can see what's currently claimed — and can force-unlock it
  manually if a lock gets stuck (T021).

**API additions:**

| Method | Path | Purpose |
|---|---|---|
| POST | `/lock` | Attempt to lock a node for a session; fails if already locked by someone else |
| POST | `/unlock` | Release a lock held by the caller's session |
| GET | `/locks` | List current locks — for the UI badge, and for an orchestrator to check before dispatching a subagent to a task |

This is deliberately file-level, not line-level: it trades fine-grained parallelism (two
agents in one file at once) for correctness (no silent interleaving of broken edits). If a
single file genuinely needs two hands regularly, that's usually a sign it should be split
into smaller files/scenes — which the dependency graph will keep wired together correctly
either way.

## 8. Playtest bug fixes (v0.0.2)
Three concrete bugs found by using the tool on a real project:
- **`requires` is invisible in the graph.** The side panel correctly surfaces autoload/
  singleton dependencies parsed from function bodies (e.g. `GameManager.add_score(...)`
  inside a `.gd` script), but nothing draws an edge for them. A node that's actually
  depended on can look like a safe-to-delete orphan. Fix: emit a `requires` edge kind (see
  section 1's edge `kind` enum — add `requires` alongside `ext_resource | signal_connection
  | import | asset_ref`) and render it distinctly (e.g. dashed line) from structural edges.
- **Stale selection across projects.** Extracting a new project path must clear whatever
  node was previously selected/shown in the detail panel — currently the old selection
  persists and shows facts about a node that no longer exists in the loaded project.
- **Unvalidated node IDs.** The Add Node modal accepts anything as an ID with no pattern
  check against the chosen engine/type, which produced a literal file named `scene 1`
  (space, no extension) in testing. Validate/normalize against the expected pattern for
  the selected engine+type before calling `/scaffold`.

## 9. Graph scaling & navigation (v0.0.2)
Problem observed: on a real ~80-node project, the default layout scattered disconnected
clusters across a huge empty canvas with tiny illegible labels. The fix is not "make the
dots smaller" — it's "don't render the whole flat graph by default."
- **Threshold-based clustering**: above roughly 20 nodes (tune as needed), default to
  grouping nodes by containing folder into a single collapsed node per folder (e.g.
  `scripts/ (12)`), with edges drawn folder-to-folder rather than file-to-file. Clicking a
  cluster expands it in place.
- **Orphans get their own group**: zero-edge nodes are pure visual noise at scale (roughly
  half the 80-node test project was unconnected test/util scripts). Collect them into one
  collapsible "Unconnected (N)" node in a fixed corner instead of letting the force sim
  scatter them across open canvas.
- **Focus Mode is the everyday view, not a novelty**: for any real task, only a node's
  1-hop neighborhood matters. Selecting a node (from search, from the graph, or from the
  context packager flow) should offer a mode that dims/hides everything outside its direct
  dependencies + dependents. The full graph is for orientation, not for working.
- **Search-first navigation**: at real scale, typing a name and jumping to it beats
  visually scanning a canvas. Fuzzy-match against node ids/filenames.

## 10. Layout stability (v0.0.2)
The reported "shakes on hover" bug is almost certainly the force simulation re-running
on hover state changes rather than only on data/layout changes.
- Hover must be a pure visual style change (e.g. highlight border/color) — it must never
  touch simulation alpha, node position, or trigger a re-tick.
- The simulation must cool down (alpha → ~0) after initial layout and then stop ticking
  entirely. A settled graph is static until the user drags a node or re-extracts.
- A manually dragged node gets its position pinned (`fx`/`fy` if using d3-force) so a
  later extract doesn't reshuffle a manual arrangement; only an explicit reset releases it.

## 11. UI space management (v0.0.2)
- Canvas fills all available space and responds to resize events — not a fixed-pixel
  canvas.
- The detail panel becomes resizable (drag handle on its left edge) and collapsible,
  rather than a fixed-width overlay that eats a third of the screen regardless of content.
- Long paths in the project-path field truncate with `text-overflow: ellipsis` and a
  `title` attribute for the full value on hover.
- Add a left-hand searchable tree/list of nodes (grouped by folder) as a second navigation
  method alongside the graph, kept in sync with graph selection in both directions.
- Test every UI change against the large fixture from T032, not only the small 6-node
  fixtures — that's specifically where the current layout breaks.

## 12. HTML/web live preview panel (v0.0.2)
- A collapsible panel (small header bar, click to expand/collapse) embeds an `<iframe>`
  pointed at a dev server URL the user types in (e.g. `http://localhost:5173`).
- Do not attempt automated screenshot capture in this version — it would require bundling
  a headless browser for something an iframe already solves. Revisit only if iframe
  embedding proves insufficient (e.g. a project blocked by CSP from being framed).
- Persist the last-used URL per project (in manifest.json or a small sidecar file) so it
  isn't retyped every session.
- Only show/offer this panel for projects containing at least one JS/HTML node.

## 13. New Project wizard + progress dashboard (v0.0.2)
- The wizard scaffolds a brand-new **target game project** (not ContextForge itself): an
  empty/new folder, an engine choice, and a project name.
- On submit it generates the same AI-agent-loop doc set ContextForge itself was
  bootstrapped with — `GEMINI.md`, `LOOP.md`, `TASKS.md`, `docs/ARCHITECTURE.md` — for that
  new game project, and runs an initial `/extract` so it shows up in the graph
  immediately. This automates a step currently done by hand for every new game project.
- The **Progress view** parses the target project's own `TASKS.md` checkbox state
  (`- [ ]` / `- [x]`) into a phase-by-phase checklist/progress bar inside ContextForge —
  no need to open the raw markdown to see how far an agent has gotten. Poll or watch the
  file so it updates live while an agent works.

## 14. Non-goals for v1
- No cloud sync, no multi-user, no auth — this runs on the user's own machine against
  their own local project folders.
- No attempt to auto-fix contract mismatches — the tool's job is to surface them clearly,
  not to silently patch code.
- No attempt to support engines beyond Godot and JS/Three.js until both of those are solid
  end to end.
