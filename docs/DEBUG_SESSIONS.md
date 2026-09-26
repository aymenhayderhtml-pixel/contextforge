# ContextForge — Debugging Workstation & Multi-Turn Sessions

## 1. Overview

ContextForge v2.0 introduces the **3-Pane Debugging Workstation**, transforming ContextForge from a modal-bound tool into a dedicated developer debugging workstation.

The interface is accessible via the top view switcher:
- `[🗺️ Graph View]`: Visual interactive D3 dependency graph with folder clustering, asset slots, and live dev preview.
- `[🔬 Debug Workstation]`: 3-pane debugging cockpit designed for multi-turn bug resolution with external coding AIs.

---

## 2. The 3-Pane Architecture

```text
┌──────────────────────┬──────────────────────────────┬────────────────────────┐
│  LEFT: PROBLEM       │  CENTER: AI WORKSPACE        │  RIGHT: CONTEXTFORGE   │
│                      │                              │                        │
│  Issue Description   │  State A: Handoff Prompt     │  [Context] Ranked      │
│  Console Logs (Red)  │  • Tokens & savings %        │  [Files] Project tree  │
│  Screenshot dropzone │  • Model format selector     │  [Deps] Node graph     │
│  Strategy & Category │  • Copy / Export .md         │  [Verify] Undo/Redo    │
│                      │                              │                        │
│                      │  State B: Response & Patch   │                        │
│                      │  • Live block detection      │                        │
│                      │  • 1-Click Apply & Verify    │                        │
│                      │  • Continue Debugging ↻      │                        │
└──────────────────────┴──────────────────────────────┴────────────────────────┘
```

### Left Pane: Problem Definition & Evidence (`problem-pane.js`)
- **Problem Input**: Description of what is wrong or expected vs actual behavior.
- **Runtime Console Box**: Live project console stdout/stderr with `All` and `Red only` filters and instant `🔄 Check` trigger.
- **Screenshot Dropzone**: Drag-and-drop or clipboard paste for screenshots, with preview thumbnail and clear button.
- **Mode Toggle**: `Normal` (clean, streamlined) vs `Advanced` (category selector and context strategy options: `Minimal`, `Balanced`, `Deep`).
- **Compile Button**: `⚡ Compile AI Handoff` triggers context slicing and relevance ranking.

### Center Pane: AI Workspace & Patch Studio (`workspace-pane.js`)
- **Iteration Stepper**: Timeline breadcrumb (`🐞 Issue` → `📤 Handoff #1` → `⚡ Patch #001` → `🔬 Verify` → `📤 Handoff #2`).
- **State A (Handoff Prompt View)**:
  - Formats: Markdown standard, Claude, ChatGPT, Gemini, DeepSeek.
  - Token counts and percentage saved vs full project files.
  - Formatted prompt view with 1-click clipboard copy (`📋 Copy Prompt`) and file download (`💾 Export .md`).
- **State B (AI Response & Patch Studio)**:
  - Textarea for pasting external AI replies.
  - Live patch block detector showing edit counts and target files.
  - Primary action: `[⚡ Apply Patch & Verify]`.
  - Structured verification banner with syntax verification and error diff.
  - `[ Continue Debugging ↻ ]`: Promotes the session to iteration #2+, automatically deriving remaining/new errors.

### Right Pane: ContextForge Inspector (`inspector-pane.js`)
- **`[Context]` Tab**: Ranked candidate files with relevance badges (High, Medium, Low), Scoped vs Full file mode toggles, and token savings estimate.
- **`[Files]` Tab**: Project disk hierarchy with search filter and quick file selection.
- **`[Deps]` Tab**: Callers, callees, and symbol outline for the selected node.
- **`[Verify]` Tab**: 20-step undo/redo transaction stack with timestamps and rollback buttons.

---

## 3. Sidecar Persistence Specification (`.contextforge.sessions.json`)

To prevent client/server state conflicts and preserve multi-turn debugging sessions across page reloads, ContextForge persists sessions in the target project folder:

`<projectPath>/.contextforge.sessions.json`

### JSON Schema

```json
{
  "activeSessionId": "sess_1727336123456_a1b2",
  "sessions": [
    {
      "id": "sess_1727336123456_a1b2",
      "title": "Debug Session — Fix Jump Collision",
      "category": "runtime_error",
      "strategy": "balanced",
      "status": "active",
      "createdAt": "2026-09-26T07:30:00.000Z",
      "updatedAt": "2026-09-26T07:32:00.000Z",
      "iterations": [
        {
          "iterationIndex": 1,
          "timestamp": "2026-09-26T07:30:00.000Z",
          "problem": {
            "description": "Player falls through moving platform",
            "consoleLogs": "TypeError: Cannot read properties of undefined in platform.js:15",
            "screenshotBase64": null
          },
          "attachedFiles": ["src/platform.js", "src/player.js"],
          "prompt": "### REASONING & CONTEXT...",
          "patchApplied": {
            "patchId": "PATCH-001",
            "count": 2,
            "files": ["src/platform.js"],
            "timestamp": "2026-09-26T07:31:15.000Z"
          },
          "verification": {
            "success": true,
            "syntaxValid": true,
            "comparison": {
              "comparison": "ERROR_RESOLVED",
              "message": "Error resolved: TypeError in platform.js:15 (0 errors remaining).",
              "errorCountDelta": -1
            }
          }
        }
      ]
    }
  ]
}
```

---

## 4. Structured Verification Comparison (`verification-comparator.js`)

When an AI patch is applied, ContextForge analyzes the new state relative to the pre-patch state and assigns a structured outcome code:

| Status Code | Meaning | User Feedback |
|---|---|---|
| `ERROR_RESOLVED` | Previous error is gone, syntax is valid, no new errors. | Green success banner: "Error resolved! 0 errors remaining." |
| `SAME_ERROR` | Previous error signature matches the current error. | Amber banner: "Patch applied, but previous error is still occurring." |
| `NEW_ERROR` | Syntax error introduced or unexpected runtime exception appeared. | Red/Amber warning: "Patch applied, but new error introduced in [file]." |
| `FEWER_ERRORS` | Total count of errors decreased across the project. | Green badge: "Error count reduced from X to Y." |
| `MORE_ERRORS` | Total count of errors increased. | Amber badge: "Error count increased from X to Y." |
| `NO_RUNTIME_DATA` | Neither previous nor current state had runtime errors. | Neutral banner: "Patch applied. Syntax verified ✓" |

---

## 5. API Endpoints

- `GET /debug-sessions?projectPath=...`: Returns list of sessions and active session ID.
- `POST /debug-sessions`: Creates a new session.
- `GET /debug-sessions/:id?projectPath=...`: Retrieves session details and iteration history.
- `POST /debug-sessions/:id/iteration`: Records a new turn (problem, prompt, patch, verification).
- `PUT /debug-sessions/:id`: Updates session status (`active`, `resolved`, `abandoned`) or title.
- `POST /compare-verification`: Compares pre-patch error with post-patch error and returns structured comparison.
