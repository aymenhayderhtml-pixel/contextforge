<div align="center">

# ⚡ ContextForge

**Local Architectural Workbench & Visual Dependency Graph for Godot 4.x & Web Game Engines**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.21-blue.svg)](https://expressjs.com/)
[![Godot Engine](https://img.shields.io/badge/Godot-4.x-478cbf.svg?logo=godot-engine&logoColor=white)](https://godotengine.org/)
[![Three.js](https://img.shields.io/badge/Three.js-r128%2B-black.svg?logo=three.js&logoColor=white)](https://threejs.org/)
[![Tests](https://img.shields.io/badge/Tests-190%2B%20Passing-success.svg)](https://github.com/aymenhayderhtml-pixel/contextforge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

*Bridge the gap between your game engine, local disk, and LLMs with visual topology, scope-aware context compilation, and transactional surgical patching.*

> **New AI or Developer?** Read **[docs/PROJECT_MAP.md](docs/PROJECT_MAP.md)** first for fast orientation. Also see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**, **[docs/CONTEXT_COMPILER.md](docs/CONTEXT_COMPILER.md)**, and **[docs/PATCH_ENGINE.md](docs/PATCH_ENGINE.md)**.

---

</div>

## 📌 Why ContextForge?

When building games with modern LLMs (Claude, ChatGPT, Gemini, DeepSeek), developers face two painful bottlenecks:

1. **Context Window Exhaustion & Hallucination**: AI models perform best when given precise, relevant context. Dumping entire scripts and scene definitions into prompts quickly blows through token limits, degrades output quality, and causes models to hallucinate rewrites of code that was already working.
2. **Brittle Code Ingestion**: Copying code back from an AI often requires tedious manual file-by-file merges. A single missed line or indentation discrepancy can silently break GDScript compile passes or Three.js render loops.

**ContextForge fixes this.** It acts as a visual mission control on your local machine:
- It parses your project into an **interactive dependency graph** (scenes, scripts, assets, and signals).
- It extracts **targeted code snippets and lightweight API outlines** instead of full files (saving 60–80% of tokens).
- It provides a **1-click direct bridge (`⚡ Paste & Run`)** that parses AI responses, applies surgical patches directly to disk, and launches the game with zero confirmation dialogs.
- It provides a dedicated **🔬 3-Pane Workstation** for multi-turn iterative bug-fixing and verification.

---

## 🚀 Key Features

### 🕸️ 1. Interactive Dependency Graph (`🗺️ Graph`)
- **Multi-Engine Extraction**: Native AST/regex-based extractors for **Godot 4.x** (`.tscn`, `.gd`, autoloads, signal wiring) and **JavaScript / TypeScript / Three.js** (ES modules, imports, canvas bindings).
- **Interactive D3 Canvas**: Force-directed layout with folder clustering (>20 nodes), 1-hop neighborhood **Focus Mode**, zero-edge orphan grouping, and zoom/pan.
- **Node Contracts & Slot Inspection**: Visualizes exported properties, signals, dependencies, and companion `.slot.json` asset contracts (GLB animations, texture dimensions).

### 🔬 2. 3-Pane Developer Workstation (`🔬 Workstation`)
- **Left Pane (Problem)**: Formulates issue descriptions, displays real-time runtime error evidence, and allows screenshot attachment.
- **Center Pane (AI Workspace)**: Generates multi-turn AI handoff prompts, interactive diff preview drawer, and 1-click verification banner with instant "Undo Patch" safety net.
- **Right Pane (Context & Inspector)**: Ranks candidate files with smart relevance scoring from stack traces, provides targeted snippet windowing and signature outlines.

### 📋 3. Direct 1-Click Surgical Patching (`⚡ Paste & Run`)
- Seamlessly ingests external AI responses directly from your clipboard with zero confirmation popups.
- **Surgical Edits (`### EDIT:`)**: Uses git-style `<<<<<<< FIND`, `=======`, and `>>>>>>> REPLACE` blocks to make atomic changes to files on disk without risking full-file overwrites.
- **Multi-File Scaffolding (`### FILE:`)**: Automatically generates missing subdirectories and writes complete files in bulk.
- **Automatic Game Launch**: Re-extracts the project graph and automatically starts or updates the dev server.
- **In-Memory Syntax Pre-Check**: Blocks invalid JS/GDScript syntax before writing to disk with "Apply Anyway" / "Reject Broken Patch" overrides.

### 📟 4. Real-Time Diagnostics & Engine Console
- **Godot Headless Compiler Check**: Runs rapid headless validation passes (`godot --headless --quit-after 1`) to capture GDScript parse and compile errors before opening the GUI editor.
- **Vite & Web Dev Server Integration**: Automatically manages dev server lifecycles (`npm run dev`), ports, and health checks with automatic cleanup when tabs close.
- **Diagnostics Bridge**: Injects telemetry bridge into HTML entrypoints to route runtime browser errors directly to ContextForge.

### 🎮 5. Engine-Native Playback & Workflows
- **Horizontal Expanding Playback Trio**: Native `[▶ Play]`, `[❚❚ Pause]`, and `[■ Stop]` controls that smoothly widen on hover with contextual state labels (`Play`, `Resume`, `Running`).
- **Restrained OpenCode Visual Aesthetic**: Dark, high contrast, minimal developer-tool interface with subtle borders and zero horizontal scrolling.
- **Web Live Preview**: Embedded collapsible iframe with auto-reload and standalone tab launch.
- **Recent Projects**: Instant project switching via the `Files ▾` menu with `localStorage` persistence.

---

## 🛠️ Architecture

```
contextforge/
├── public/                 # Vanilla JS / D3.js / CSS Frontend UI
│   ├── index.html          # Single-page dashboard, canvas & modals
│   ├── favicon.svg         # ContextForge vector brand icon
│   └── README_FOR_AI.md    # In-app AI context companion guide
├── server/                 # Express backend API & analyzers
│   ├── index.js            # HTTP server, routes, and process orchestrator
│   ├── extractors/
│   │   ├── godot-extractor.js  # Godot 4.x scene (.tscn) & script (.gd) parser
│   │   └── js-extractor.js     # JavaScript / ES module dependency extractor
│   ├── console-manager.js  # Process log buffer & headless Godot runner
│   ├── dev-server.js       # Vite / Node dev server lifecycle manager
│   ├── outline.js          # AST-free lightweight signature outline generator
│   ├── project-init.js     # New project wizard & AI clipboard block parser
│   ├── slot-contract.js    # Asset metadata & slot contract validator
│   └── schema/             # JSON Schema definitions for extraction manifests
├── test-fixtures/          # Godot & Three.js test repositories
└── docs/                   # Full architectural specifications
```

---

## 🏁 Quick Start

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- *(Optional for Godot projects)*: **Godot Engine 4.x** installed and accessible in `PATH` (or `~/.local/bin/godot`).

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/aymenhayderhtml-pixel/contextforge.git
cd contextforge

# 2. Install dependencies
npm install

# 3. Start the ContextForge server
npm start
```

Open your browser at:
```
http://localhost:3000
```

---

## 📖 Developer Workflow: Pairing with an AI

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant CF as ContextForge (:3000)
    participant Disk as Local Project Files
    actor AI as External AI (Claude / ChatGPT)

    Dev->>CF: Enter Project Path & Click "Extract"
    CF->>Disk: Scan .tscn, .gd, .js, and contracts
    CF-->>Dev: Interactive visual dependency graph rendered
    
    Note over Dev,CF: Bug occurs or new feature needed
    Dev->>CF: Click "🐞 Issue" on buggy node
    CF-->>Dev: Copies Scoped Context (Outline + Snippet + Console error)
    
    Dev->>AI: Paste prompt into AI chat
    AI-->>Dev: Replies with ### EDIT: or ### FILE: blocks
    
    Dev->>CF: Click "⚡ Paste & Run"
    CF->>Disk: Applies surgical patches directly to files
    CF->>CF: Re-extracts & runs headless compiler check
    CF->>Dev: Automatically boots/updates dev server & runs game
```

---

## 🤖 AI Output Formatting Guide

When instructing your AI assistant, you can click **`Files ▾` ➔ `Context for AI`** inside the app to copy the prompt guide. ContextForge expects external models to respond using one of two clean block structures:

### Surgical Edits (Preferred for existing code)

```markdown
### EDIT: scripts/Player.gd
<<<<<<< FIND
func take_damage(amount: int) -> void:
	health -= amount
=======
func take_damage(amount: int) -> void:
	health = max(0, health - amount)
	emit_signal("health_changed", health)
>>>>>>> REPLACE
```

### Full Files (For new files or rewrites)

````markdown
### FILE: scripts/autoload/GameState.gd
```gdscript
extends Node

signal coins_changed(count: int)
var coins: int = 0

func add_coin() -> void:
	coins += 1
	coins_changed.emit(coins)
```
````

---

## 🧪 Testing

ContextForge comes with a comprehensive suite of **190+ automated integration and regression tests across 18 test suites**:

```bash
# Run the complete test suite
npm test
```

### Test Coverage Includes:
- **Schema Validation**: Validates extraction manifests against strict JSON schemas.
- **Godot Extractor**: Tests scene instancing, signal connection graphs, script exports, and autoloads.
- **JS / Three.js Extractor**: Tests ES module imports, circular dependency tolerance, and package detection.
- **Asset Graph & Slot Contracts**: Validates 3D meshes (GLB/GLTF), animations, and texture slots.
- **Scoped Context & Outlines**: Verifies line-bounded snippet windowing and signature generation.
- **Surgical Patch Engine**: Validates conflict-free patch applications, sequential re-anchoring, and drift tolerance.
- **File History & Undo/Redo**: Validates transactional rollback and multi-file restoration.
- **Process & Lifecycle Management**: Tests Vite dev server orchestration, signal handling (`SIGSTOP`/`SIGCONT`), and Godot headless execution.
- **Workstation UI & Contracts**: Verifies layout elements, safety nets, and client UI contracts.

---

## 📡 HTTP API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/extract` | `POST` | Extracts full dependency graph manifest for a given `projectPath`. |
| `/scoped-context` | `POST` | Generates a token-optimized prompt with target snippets and dependency outlines. |
| `/add-from-clipboard` | `POST` | Parses AI clipboard content and applies `### FILE:` or `### EDIT:` changes to disk. |
| `/preview-diff` | `POST` | Computes in-memory unified diff between disk files and incoming patch without disk write. |
| `/rank-relevant-files` | `POST` | Evaluates stack traces and error messages to rank candidate project files by relevance score. |
| `/console-logs` | `GET` | Fetches captured runtime and compiler console logs for a project. |
| `/history/undo` | `POST` | Reverts the most recent file mutation or surgical patch. |
| `/history/redo` | `POST` | Re-applies the most recent undone file transaction. |
| `/debug-sessions` | `GET`, `POST` | Creates and lists persistent multi-turn iterative sidecar debugging sessions. |
| `/compare-verification`| `POST` | Compares pre- and post-patch error fingerprints to detect regressions or resolution. |
| `/game/pause` | `POST` | Toggles pause state (`SIGSTOP`/`SIGCONT`) on active Godot runtime process. |
| `/game/stop` | `POST` | Terminates active game runtime and associated dev servers. |
| `/dev-server/start` | `POST` | Automatically runs npm setup and boots local Vite dev server. |
| `/file-tree` | `GET` | Recursively returns the directory tree of the target project. |
| `/file-content` | `GET` | Reads raw content of a specific file from disk. |

---

## 📄 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.
