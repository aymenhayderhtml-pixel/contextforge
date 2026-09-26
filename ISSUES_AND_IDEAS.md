# ContextForge — Master Issues, Roadmap & Issue Engine Overhaul Plan

> **Core Philosophy**: ContextForge is NOT an AI model. It is the **compiler, debugger, context selector, and patch safety layer** for external coding AIs.
>
> **Workflow**: `User describes issue → ContextForge inspects project → ranks & slices exact code → compiles high-density prompt → External AI writes patch → ContextForge validates exact FIND → Applies patch transaction → Verifies syntax & console → User gets 1-click rollback`.

---

## 📌 Table of Contents
1. [Completed in this Sprint (Verified)](#1-completed-in-this-sprint-verified)
2. [The Issue Engine Overhaul Architecture](#2-the-issue-engine-overhaul-architecture)
3. [The 6 Core Pillars of the Context Compiler](#3-the-6-core-pillars-of-the-context-compiler)
4. [New Issue Window UI Specification](#4-new-issue-window-ui-specification)
5. [Phased Implementation Roadmap](#5-phased-implementation-roadmap)
6. [Security & Efficiency Backlog](#6-security--efficiency-backlog)

---

## 1. Completed in this Sprint (Verified)

- [x] **Fix Files Button**: Removed conflicting inline `onclick` that caused double-toggling (open/close in same frame). Files dropdown now opens and closes smoothly.
- [x] **1-Click Paste & Direct Apply**: Clicking `📋 Paste` directly reads from system clipboard via `navigator.clipboard.readText()`. If AI `### FILE:` or `### EDIT:` blocks are present, applies them immediately to disk, updates graph & tree, and records a transaction without opening a modal. Seamlessly falls back to modal if clipboard is blocked or contains other text.
- [x] **20-Step Undo & Redo Transaction Engine**:
  - Implemented `server/history-manager.js` storing up to 20 full snapshot states per project.
  - Endpoints: `POST /history/undo`, `POST /history/redo`, `GET /history/status`, `POST /history/clear`.
  - UI Controls: Toolbar `↺ Undo` / `↻ Redo` buttons + `Files` dropdown items + `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` keyboard shortcuts.
  - Automatically snapshots before/after state on surgical patches, clipboard pastes, node writebacks, and manual file saves.
- [x] **Backend Route Modularization**:
  - Extracted monolithic `server/index.js` (1,799 lines) into 9 domain routers under `server/routes/` (`extract.js`, `scaffold.js`, `paste.js`, `devserver.js`, `files.js`, `clipboard.js`, `context.js`, `console.js`, `history.js`), reducing `server/index.js` down to 51 lines.
  - Centralized shared server state in `server/state.js` and filesystem resolution in `server/paths.js`.
- [x] **Modular CSS System**:
  - Extracted 1,460 lines of styles into 6 scoped stylesheets in `public/css/`: `variables.css`, `base.css`, `graph.css`, `sidebar.css`, `terminal.css`, and `modals.css`.
- [x] **Client ES Modules**:
  - Extracted client frontend modules into `public/js/`: `state.js`, `app.js`, `shared/toast.js`, `history/history.js`, `clipboard/clipboard.js`, `terminal/terminal.js`, `preview/preview.js`, `sidebar/tree.js`, and `issue/issue-modal.js`.
- [x] **Context Compiler Subsystem**:
  - Created `server/context-compiler.js` implementing relevance scoring (`rankRelevantFiles`), error stack parsing, verbatim code slicing, and the strict surgical patch contract.
- [x] **Documentation Suite**:
  - Created `docs/PROJECT_MAP.md` (primary AI entrypoint), `docs/CONTEXT_COMPILER.md`, `docs/PATCH_ENGINE.md`, `docs/DEVELOPMENT.md`.
- [x] **Automated Test Suite**: Added `server/history-test.js`. All **162 unit & integration tests** pass cleanly with 0 regressions.

---

## 2. The Issue Engine Overhaul Architecture

### The Problem With Shallow Outlines
Previously, ContextForge generated outlines like:
```text
### FILE: src/main.js (Scoped Context)
// --- Symbol Outline ---
const app = document.querySelector("#app");
class FortniteCloneGame
```
A symbol outline only tells the external AI that something exists. It does NOT provide:
- The actual implementation lines
- Surrounding logic & local state
- Callers and callees
- Exact original text, indentations, and punctuation

Because of this, the external AI is forced to hallucinate or invent `<<<<<<< FIND` blocks, which inevitably fail when applied.

### The Solution: The Context Compiler Pipeline
```text
USER PROBLEM DESCRIPTION
       ↓
ERROR & STACK PARSER (from terminal drawer)
       ↓
RELEVANCE RANKING (keyword match + call graph)
       ↓
FILE SELECTION (ContextForge selects files automatically)
       ↓
EXACT CODE SLICING (verbatim functions & caller lines from disk)
       ↓
BUDGET & QUALITY CHECK (Micro / Balanced / Deep with auto-expansion)
       ↓
COMPILED AI PROMPT (Strict "DO NOT INVENT FIND" contract)
       ↓
EXTERNAL AI (ChatGPT / Claude / DeepSeek)
       ↓
EXACT PATCH VALIDATION (1 exact match required)
       ↓
PATCH TRANSACTION (Numbered checkpoint: PATCH #042)
       ↓
POST-PATCH VERIFICATION (node --check / Godot check / error resolved)
       ↓
RESULT & ROLLBACK (Ready for visual play, or 1-click Ctrl+Z)
```

---

## 3. The 6 Core Pillars of the Context Compiler

### Pillar 1: Automatic Relevant-File Selection (Before Slicing)
- **Principle**: The user should not have to manually guess which 4 files are related to their bug.
- **Mechanism**:
  1. Inspect user issue description keywords (`"shooting"`, `"player invisible"`, `"damage"`).
  2. Inspect captured console error stack traces (file paths and line numbers).
  3. Query the static dependency graph for connected modules.
  4. Compute a relevance percentage:
     - `98% src/main.js` (Player shooting state & event handler)
     - `94% src/scene-manager.js` (Raycast & projectile creation)
     - `71% src/game-state.js` (Ammo & player state)
     - `12% src/style.css` (HUD only — excluded)
  5. Automatically select the top relevant files, while providing a `[Customize]` toggle.

### Pillar 2: Exact Verbatim Code Slicing (From Real Disk Files)
- **Principle**: Never send empty outlines. Send exact, character-for-character function implementations.
- **Slice Hierarchy**:
  - **Slice A (Crime Scene)**: The exact function body containing the error (e.g. lines 470–515 of `main.js`).
  - **Slice B (Caller)**: The 5–10 lines in the caller function triggering the routine.
  - **Slice C (Callees)**: The exact signatures or helper routines called within the slice.
  - **Slice D (Referenced State)**: The constructor declarations of variables mutated inside the slice.
- **Result**: ~90 lines of verbatim code containing 100% of the debugging context, eliminating 90% of token waste.

### Pillar 3: Strict "DO NOT INVENT FIND" Prompt Contract
- The generated prompt explicitly instructs the external AI:
```text
STRICT PATCH CONTRACT:
Every FIND section must be an EXACT, character-for-character substring of the supplied source code.
- Do NOT normalize whitespace or re-indent.
- Do NOT paraphrase or omit lines.
- Do NOT guess original code not provided in the context.
If the supplied context is insufficient, state "CONTEXT INSUFFICIENT" and specify the required function/file.
```

### Pillar 4: Exact Patch Safety & Fuzzy Recovery (No Silent Overwrites)
- **Safety Rule**: A patch is ONLY applied automatically if `<<<<<<< FIND` matches **exactly once** in the target file.
  - 0 matches: REJECT.
  - 2+ matches: REJECT (ambiguous).
  - 1 match: APPLY.
- **Never Silently Apply Fuzzy Matches**: If an AI makes a whitespace or indentation mismatch (e.g. 96% match), ContextForge does NOT modify the code blindly. Instead:
  1. Displays a **Fuzzy Match Detected** preview showing requested vs actual disk lines.
  2. Offers a 1-click **Generate Recovery Prompt** containing the exact 10 lines currently on disk so the external AI can re-emit a clean patch.

### Pillar 5: Patch Transaction System & Checkpoints
- Every AI patch is recorded as a numbered transaction (`PATCH #001`, `PATCH #002`...):
  - Timestamp & target files
  - Number of lines added / removed
  - Before/after snapshots
  - Verification result
- Stored in a local transaction log with instant 1-click rollback (`Undo Patch #042`).

### Pillar 6: Post-Patch Verification Engine
- Immediately upon applying a patch:
  1. Runs static syntax check (`node --check` / headless Godot check).
  2. Pings dev server / game bridge.
  3. Checks terminal drawer to verify if previous error disappeared.
  4. Flashes a verification card:
     ```text
     ╭────────────────────────────╮
     │ PATCH VERIFICATION         │
     │                            │
     │ ✓ 2 edits applied          │
     │ ✓ 2 exact matches          │
     │ ✓ Syntax valid             │
     │ ✓ Vite dev-server clean    │
     │                            │
     │ Previous error: RESOLVED   │
     ╰────────────────────────────╯
     ```

---

## 4. New Issue Window UI Specification

```text
┌─────────────────────────────────────────────────────────────────┐
│ 🐞 REPORT ISSUE & COMPILE FIX CONTEXT                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ WHAT IS WRONG?                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ e.g. Player falls through floor when jumping near boxes     │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ EXPECTED BEHAVIOR                                               │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Player lands on top of boxes cleanly                        │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│                                                                 │
│ 🔍 AUTOMATIC CONTEXT SELECTION                                  │
│ 🤖 ContextForge investigated your project and selected:         │
│                                                                 │
│  ☑ src/player.js                98% relevance • lines 140-195   │
│  ☑ src/physics.js               94% relevance • lines 45-80     │
│  ☑ scenes/level.js              76% relevance • lines 210-240   │
│                                                                 │
│  📊 3 files • 4 sliced functions • ~1,280 tokens (Saves 89%)    │
│  [👁️ Preview Exact Code Slices] [⚙️ Customize Selection]        │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│                                                                 │
│ 🖥️ RUNTIME EVIDENCE                                             │
│  ✓ Terminal Error: TypeError: Cannot read properties of undef   │
│  ✓ Stack: src/player.js:142 → updateMovement()                 │
│  ✓ Runtime Probe: window.__CF_PROBE__ captured                  │
│                                                                 │
│  Context Confidence: █████████░ 92% (High precision)           │
│                                                                 │
│           [ 📋 COMPILE & COPY AI FIX PROMPT ]                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Phased Implementation Roadmap

### Phase 1 — Context Quality & Code Slicing (Immediate Next)
1. **Verbatim Code Slicer**: Extract real function bodies and line ranges from disk instead of signature outlines.
2. **Relevance Ranker**: Auto-select candidate files from keywords + console errors.
3. **Strict Patch Contract**: Embed `DO NOT INVENT FIND TEXT` in the compiled prompt.
4. **Token Meter & Context Coverage**: Display exact chars, estimated tokens, and savings percentage.

### Phase 2 — Safety, Transactions & Recovery
1. **Patch Transaction Log**: Numbered transactions with rollback.
2. **Exact Patch Matcher**: Reject 0 and 2+ matches.
3. **Fuzzy Match Recovery Prompt**: 1-click prompt generator when an AI makes an indentation error.

### Phase 3 — Runtime Intelligence & Verification
1. **Post-Patch Verification**: Run static check immediately after apply; report clean syntax or syntax error with 1-click undo.
2. **Structured Console Parser**: Parse `file`, `line`, `col`, `stack` into typed JSON.
3. **Runtime Probe Bridge**: Support structured `window.__CF_PROBE__` data capture.

### Phase 4 — Advanced Context Optimization
1. **Adaptive Context Expansion**: Warn when Micro context is insufficient and auto-expand.
2. **Context Confidence Score**: Calculate percentage based on stack resolution and symbol presence.
