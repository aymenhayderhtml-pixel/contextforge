# ContextForge — AI Pair-Programming & System Context Guide

> **Instructions for External AI Assistants (ChatGPT, Claude, Gemini, DeepSeek, etc.)**
> You are collaborating with a developer using **ContextForge**, a local-first architectural workbench and dependency graph dashboard for game development (Godot 4.x and JS/Three.js/HTML5).
> Read this document to understand the project architecture, file protocols, and how to format your code changes so the user can apply them instantly with 1 click.

---

## 1. How ContextForge Works

ContextForge connects the developer's game repository to external AI models:
1. **Extraction**: ContextForge scans the project tree, parses scene files (`.tscn`), scripts (`.gd`, `.js`, `.ts`), slot contracts (`.slot.json`), and static assets into an interactive dependency graph.
2. **Context Packaging (Issue Report)**: When reporting a bug or requesting a feature, ContextForge generates a **Scoped Context Prompt** containing:
   - Target file outline + target code snippet (windowed around the error or relevant function).
   - Dependency files outline (contracts, exported functions/signals, without full function bodies) to conserve AI context tokens.
   - Live compiler and runtime console output (including exact Godot stack traces or browser errors).
3. **Clipboard Bridge (`Paste` button)**: When you reply with code, the user clicks **Paste** in ContextForge. ContextForge automatically parses your output and writes files or applies surgical edits directly to disk!

---

## 2. STRICT Code Output Format Rules

When generating code or modifications for the developer, **ALWAYS use one of these two standard block formats**:

### Format A: Surgical Edits (`### EDIT:`) — PREFERRED for existing files
Use this when modifying existing files. It prevents overwriting user modifications and minimizes tokens:

```markdown
### EDIT: scripts/Player.gd
<<<<<<< SEARCH
func take_damage(amount: int) -> void:
	health -= amount
=======
func take_damage(amount: int) -> void:
	health = max(0, health - amount)
	emit_signal("health_changed", health)
>>>>>>>
```

**Surgical Edit Rules:**
- The relative path MUST follow `### EDIT: ` exactly.
- The `<<<<<<< SEARCH` block MUST match existing code on disk **character-for-character**, including exact indentation (tabs or spaces).
- Include 1–2 unchanged lines before and after if needed to ensure the search target is unique in the file.
- The `=======` divider separates the search target from the replacement.
- The `>>>>>>>` closes the edit block.
- You can provide multiple `### EDIT:` blocks across different files in a single response.

---

### Format B: Full File (`### FILE:`) — For new files or complete rewrites
Use this when creating new files or when an existing file needs a total replacement:

```markdown
### FILE: scripts/autoload/GameState.gd
```gdscript
extends Node

signal coins_changed(new_count: int)
signal lives_changed(new_count: int)

var coins: int = 0
var lives: int = 3

func add_coins(amount: int) -> void:
	coins += amount
	coins_changed.emit(coins)

func reset() -> void:
	coins = 0
	lives = 3
```
```

**Full File Rules:**
- The relative path MUST follow `### FILE: ` exactly.
- Wrap the file contents in triple backticks with the language tag (`gdscript`, `javascript`, `html`, `json`, `svg`, etc.).
- Never use placeholder comments like `// rest of the code unchanged...` inside a `### FILE:` block; provide the complete runnable file.

---

## 3. Engine-Specific Architectural Guidelines

### Godot 4.x / GDScript Rules
1. **Engine Property Inheritance**:
   - `CharacterBody3D` / `CharacterBody2D` already provide `position`, `velocity`, `rotation`, etc.
   - **CRITICAL**: NEVER declare `var velocity: Vector3` or `var position: Vector3` in a script extending `CharacterBody3D`. Doing so causes a fatal Godot 4 parser collision.
   - If player script uses `velocity`, it MUST extend `CharacterBody3D`, NOT `Node3D`.
2. **Autoload Access**:
   - Autoload singletons (e.g. `GameState`, `Audio`) defined in `project.godot` are globally available.
   - Always verify if singletons exist before calling methods, or register them under `[autoload]` in `project.godot`.
3. **Signal Emission**:
   - Godot 4 uses `my_signal.emit(args)` syntax or `emit_signal("my_signal", args)`.
4. **Scene Nodes & References**:
   - Use `@onready var child = $Path/To/Node` or pass references cleanly via dependency injection.
   - Keep scripts decoupled from scene layout where possible.

---

### JavaScript / Three.js / Web Rules
1. **Module Architecture**:
   - Use ES6 modules (`import * as THREE from 'three'`).
   - Vite is the standard development server used by ContextForge for web projects.
2. **Lifecycle & Cleanup**:
   - Maintain a clear game loop (`requestAnimationFrame`).
   - Handle window resize events (`camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(...)`).
   - Clean up event listeners on game restarts.

---

## 4. How to Handle User Requests

- **Bug Reports**: Read the `CONSOLE OUTPUT` and `TARGET SNIPPET` provided in the prompt. Identify the exact root cause and return surgical `### EDIT:` blocks fixing the error.
- **New Features**: If adding a new system (e.g., an inventory manager or particle effect), supply a new file with `### FILE:` and surgical `### EDIT:` blocks to integrate it into the main scene/scripts.
- **Clarity**: Keep conversational explanations concise; place the code blocks prominently so ContextForge's clipboard parser can ingest them without ambiguity.
