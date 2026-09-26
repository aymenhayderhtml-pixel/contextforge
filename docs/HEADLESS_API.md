# ContextForge Headless API Reference

This document provides complete instructions for driving ContextForge headlessly without a browser or UI. All core operations—project initialization, dependency graph extraction, issue reporting, context compilation, surgical patch application, transactional rollback, and dev server lifecycle—are exposed as REST API endpoints over HTTP (`http://localhost:3000`).

---

## 1. Project Lifecycle & Graph Extraction

### `POST /init-project`
Scaffolds a new game project directory with engine boilerplate and AI handoff docs (`GEMINI.md`, `LOOP.md`, `TASKS.md`, `docs/ARCHITECTURE.md`).
- **Body**:
  ```json
  {
    "targetFolder": "/path/to/my-new-game",
    "engine": "js" | "godot" | "mixed",
    "projectName": "MyGame"
  }
  ```
- **Response**: `{ "success": true, "projectPath": "...", "engine": "js", "projectName": "...", "filesCreated": [...] }`

### `POST /extract`
Extracts the ground-truth dependency graph manifest from actual source files (`.tscn`, `.gd`, `.js`, etc.). Sets the loaded project path in server state.
- **Body**:
  ```json
  {
    "projectPath": "/path/to/game-project"
  }
  ```
- **Response**: Full `manifest.json` schema object containing `nodes` (contracts, exports, signals, dependencies) and `edges`.

### `GET /manifest`
Returns the current active manifest in memory.

---

## 2. File Exploration & Content

### `GET /file-tree?projectPath=/path/to/project`
Returns the recursive file tree of the target project (excluding git/node_modules).
- **Response**:
  ```json
  {
    "success": true,
    "projectPath": "...",
    "files": [
      { "path": "src/main.js", "name": "main.js", "dir": "src" },
      ...
    ]
  }
  ```

### `GET /file-content?projectPath=/path/to/project&filePath=src/main.js`
Reads the exact text content of any file inside the project.
- **Response**: `{ "success": true, "filePath": "src/main.js", "content": "..." }`

### `POST /save-file`
Writes raw content to a file with automatic undo history tracking.
- **Body**:
  ```json
  {
    "projectPath": "/path/to/project",
    "filePath": "src/main.js",
    "content": "..."
  }
  ```
- **Response**: `{ "success": true, "filePath": "...", "patchId": "...", "canUndo": true }`

---

## 3. Issue Reporting & Scoped Context Compilation

### `POST /rank-relevant-files`
Analyzes error logs, stack traces, and issue descriptions to rank the most relevant files in the project.
- **Body**:
  ```json
  {
    "projectPath": "/path/to/project",
    "issueDescription": "Null pointer in player movement",
    "consoleLogs": "TypeError: Cannot read properties of undefined at src/player.js:42"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "files": [
      { "file": "src/player.js", "score": 100, "line": 42, "reason": "Error origin line 42", "isTop": true },
      { "file": "src/main.js", "score": 75, "line": null, "reason": "Caller / Dependent of src/player.js", "isTop": false }
    ]
  }
  ```

### `POST /scoped-context`
Generates a token-optimized AI handoff prompt. Includes focused code snippet around the error, outline/signatures of dependencies, console output, and optional screenshot evidence.
- **Body**:
  ```json
  {
    "projectPath": "/path/to/project",
    "targetFile": "src/player.js",
    "targetLine": 42,
    "issueDescription": "Player movement crashes when key pressed",
    "attachedFiles": ["src/player.js", "src/main.js"],
    "fileModes": { "src/player.js": "scoped", "src/main.js": "scoped" },
    "consoleLogs": "TypeError: Cannot read properties of undefined (reading 'x') at src/player.js:42",
    "screenshotBase64": "data:image/png;base64,..."
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "prompt": "I am working on the game \"MyGame\" using HTML5, Vite, and Three.js...\n\n...",
    "chars": 1850,
    "tokens": 463,
    "savingsPercent": 72
  }
  ```

---

## 4. Ingesting AI Fixes & Surgical Patching

### `POST /preview-diff`
Simulates applying an AI patch block without writing to disk. Returns unified diff chunks (additions/deletions).
- **Body**:
  ```json
  {
    "projectPath": "/path/to/project",
    "content": "### EDIT: src/player.js\n<<<<<<< FIND\n  this.x = undefined;\n=======\n  this.x = 0;\n>>>>>>> REPLACE"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "type": "edit",
    "files": [
      { "file": "src/player.js", "additions": 1, "deletions": 1, "chunks": [...] }
    ]
  }
  ```

### `POST /add-from-clipboard`
The primary bridge for applying AI responses. Auto-detects surgical `### EDIT:` or full `### FILE:` blocks.
- **Features**:
  - In-memory syntax pre-check (blocks invalid JS/GDScript before touching disk).
  - Multi-pass anchor matching (handles whitespace, comments, and CRLF drift).
  - Detects `CONTEXT INSUFFICIENT: Need [file]` signal and returns missing files.
  - Automatically records transaction in undo stack.
- **Format Requirements**:
  - `### EDIT:` requires `<<<<<<< FIND` (or `SEARCH`), `=======`, and `>>>>>>> REPLACE` markers.
  - `### FILE:` requires markdown code fencing with language tag:
    ```markdown
    ### FILE: path/to/file.ext
    ```language
    <full file content>
    ```
    ```
- **Body**:
  ```json
  {
    "projectPath": "/path/to/project",
    "content": "### EDIT: src/player.js\n<<<<<<< FIND\n  this.x = undefined;\n=======\n  this.x = 0;\n>>>>>>> REPLACE",
    "preCheckSyntax": true,
    "applyAnyway": false
  }
  ```
- **Response (Success)**:
  ```json
  {
    "success": true,
    "files": ["src/player.js"],
    "patchId": "tx-1727376000000-1234",
    "canUndo": true,
    "syntaxValid": true
  }
  ```
- **Response (Syntax Block)**:
  ```json
  {
    "success": false,
    "preCheckFailed": true,
    "canApplyAnyway": true,
    "files": ["src/player.js"],
    "syntaxError": { "file": "src/player.js", "message": "Unexpected token (", "line": 10 },
    "error": "Syntax error in src/player.js: Unexpected token ("
  }
  ```
- **Response (Context Insufficient Signal)**:
  ```json
  {
    "success": false,
    "isContextInsufficient": true,
    "requestedFiles": ["src/scene-manager.js"],
    "message": "CONTEXT INSUFFICIENT: Need src/scene-manager.js"
  }
  ```

---

## 5. Transaction History & Rollback

### `POST /history/undo`
Reverts the most recent file mutation or surgical patch.
- **Body**: `{ "projectPath": "/path/to/project" }`
- **Response**: `{ "success": true, "undone": true, "message": "Reverted Applied surgical patch (...)" }`

### `POST /history/redo`
Re-applies the undone transaction.
- **Body**: `{ "projectPath": "/path/to/project" }`

### `GET /history/status?projectPath=/path/to/project`
Returns current undo/redo stack counts.

---

## 6. Console, Diagnostics & Verification

### `GET /console-logs?projectPath=/path/to/project&clear=false`
Returns runtime browser errors and Godot compiler errors.
- **Response**:
  ```json
  {
    "success": true,
    "logs": [...],
    "redLogs": [{ "text": "Uncaught TypeError: ...", "type": "error", "timestamp": "..." }],
    "totalCount": 14,
    "errorCount": 1
  }
  ```

### `POST /compare-verification`
Compares pre-patch error state with post-patch error state.
- **Body**:
  ```json
  {
    "projectPath": "/path/to/project",
    "prePatchErrors": ["TypeError: Cannot read properties of undefined at src/player.js:42"],
    "postPatchErrors": []
  }
  ```
- **Response**:
  ```json
  {
    "comparison": "ERROR_RESOLVED",
    "summary": "Previous error resolved and no new errors observed."
  }
  ```

---

## 7. Multi-Agent Locking

### `POST /lock`
Claims a lock on a file node before editing.
- **Body**: `{ "nodeId": "src/player.js", "holder": "qa-subagent-1" }`
- **Response**: `{ "success": true, "nodeId": "...", "lock": { "status": "locked", "holder": "qa-subagent-1" } }`

### `POST /unlock`
Releases a lock.
- **Body**: `{ "nodeId": "src/player.js", "holder": "qa-subagent-1", "force": false }`

---

## 8. Dev Server & Process Lifecycle

### `POST /dev-server/start`
Installs missing npm dependencies and boots the project's Vite dev server.
- **Body**: `{ "projectPath": "/path/to/project" }`
- **Response**: `{ "success": true, "url": "http://localhost:5173", "status": "running" }`

### `POST /dev-server/stop`
Stops running dev server and terminates child processes.
- **Body**: `{ "projectPath": "/path/to/project" }`

### `POST /game/launch`
Launches the Godot editor or game process (`--path`).
- **Body**: `{ "projectPath": "/path/to/project", "mode": "run" | "editor" }`

### `POST /game/pause`
Toggles SIGSTOP / SIGCONT pause on active Godot runtime.

### `POST /game/stop`
Terminates active Godot game runtime process and dev server.
