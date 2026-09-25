# GEMINI.md — Project Overview & Working Agreement

Working title: **ContextForge** (rename freely — this is just a label for docs/commits)

## What this tool is
A local dev tool that fixes context/dependency problems that come from using multiple AI
models across many sessions to build games in Godot 4.x and Three.js/HTML. It works by
extracting a ground-truth dependency graph directly from the *source files* of a target
game project (not by asking an AI to summarize the project), and using that graph to:

1. Visualize how scenes/modules/assets in a project actually connect.
2. Generate a minimal, scoped "context package" for handing one specific task off to any
   AI model — just the target file plus the *interfaces* of what it touches, not the
   whole codebase.
3. Validate AI-returned code against the interfaces its dependents expect, before it gets
   wired into the real project.

This tool is not a game. It is a dev tool the user runs locally against their *other*
projects (the racing game, cultivation game, etc.) to make AI handoffs between sessions
and models cheap and reliable.

## Core principle — read this before writing any code
**The manifest is always derived by parsing real source files. It is never authored,
guessed, or summarized by an AI.** If the manifest is ever wrong or incomplete, the fix is
to improve the extractor/parser that produced it — never to hand-edit manifest.json, and
never to have an LLM call "fill in" a field it couldn't determine by parsing. This rule
exists because the entire point of the tool is to replace AI-inferred dependencies (which
are the problem) with parsed, factual ones.

## Tech stack
- **Backend:** Node.js, minimal HTTP server (Express is fine if it speeds you up, but keep
  dependencies light — this tool should be easy to run with a single `npm install && npm
  start`).
- **Frontend:** plain HTML/CSS/JS served by the Node server, opened at `localhost`. No
  build step required for v1 — keep it simple and inspectable.
- **Storage:** no database. The manifest is a single `manifest.json` file per target
  project, regenerated on demand. Never treat it as hand-editable state.
- **Platform:** assume the user develops on Windows. Avoid bash-only tooling in npm
  scripts; keep everything cross-platform (use `node` scripts rather than shell scripts
  where possible).

## Folder structure (target — create as you go)
```
/server
  index.js              -- HTTP server + API routes
  /extractors
    godot-extractor.js
    js-extractor.js
  /schema
    manifest.schema.json
    validate.js
/public                  -- frontend: graph UI, context packager UI
/test-fixtures
  /godot-sample           -- tiny Godot 4.x project used to test the extractor
  /js-sample               -- tiny Three.js/HTML project used to test the extractor
GEMINI.md
LOOP.md
TASKS.md
docs/ARCHITECTURE.md
```

## Conventions
- Every extractor implements the same interface — see docs/ARCHITECTURE.md — and only
  ever writes to `manifest.json`. Nothing else is allowed to write to it.
- Every node in the manifest has: `id`, `engine`, `type`, `contract` (its public
  interface), `depends_on` (authored/parsed), `depended_on_by` (computed, never parsed
  directly).
- Build a tiny fixture project per engine early (Phase 1/2) and test the extractor against
  it — do not "eyeball" correctness against a real, large project.
- Determinism matters: running an extractor twice on an unchanged project must produce
  byte-identical output. If it doesn't, that's a bug, not noise.

## Definition of done, per task
- Output validates against `manifest.schema.json`.
- Deterministic on repeat runs.
- Proven against a fixture project with at least one real dependency and one real
  interface member (signal/export/function) — not just an empty scene.
