# ContextForge — Project Map & AI Navigation Guide

> **START HERE**: If you are an external coding AI (Claude, ChatGPT, Gemini, DeepSeek, etc.) tasked with inspecting, modifying, or extending ContextForge, read this document first.

---

## 1. What ContextForge Is (and What It Is NOT)

- **ContextForge IS**: A local-first developer tool that sits between a game developer and external coding AIs. It acts as the **context compiler, runtime debugger, surgical patch validator, and transaction safety harness**.
- **ContextForge IS NOT**: An AI model. It does not generate code itself. It compiles dense, high-relevance source context for external AIs, validates returned surgical patches, and verifies that the game builds and runs cleanly after edits.

---

## 2. Fast Navigation: Subsystems & Directory Map

```text
contextforge/
├── docs/                           # Architectural specs & AI navigation
│   ├── PROJECT_MAP.md              # 📍 THIS FILE: Primary AI entrypoint
│   ├── ARCHITECTURE.md             # Subsystem contracts, lifecycle & data flow
│   ├── CONTEXT_COMPILER.md         # Relevance ranking & exact code slicing
│   ├── PATCH_ENGINE.md             # Surgical patch format, safety & transactions
│   ├── DIAGNOSTICS.md              # Terminal logs, error parsing & runtime probe
│   └── DEVELOPMENT.md              # Commands, testing & coding guidelines
│
├── public/                         # Client Frontend (Vanilla JS + D3)
│   ├── index.html                  # Minimal boot shell with semantic DOM IDs
│   ├── css/                        # Feature-scoped modular stylesheets
│   │   ├── variables.css           # Color tokens & theme
│   │   ├── base.css                # Typography & layout
│   │   ├── graph.css               # D3 canvas styles & badges
│   │   ├── sidebar.css             # Left file tree mirror
│   │   ├── terminal.css            # Bottom diagnostic drawer
│   │   ├── modals.css              # Shared modal styles
│   │   └── workstation.css         # 3-Pane Workstation layout & timeline stepper
│   ├── js/                         # ES modules
│   │   ├── app.js                  # Main UI bootstrapper & event wiring
│   │   ├── state.js                # Central observable client state
│   │   ├── workstation/            # 🔬 3-Pane Debugging Workstation
│   │   │   ├── workstation.js      # Master workstation orchestrator & view mode toggle
│   │   │   ├── problem-pane.js     # Left Pane: Problem input, console box, screenshot
│   │   │   ├── workspace-pane.js   # Center Pane: State A Handoff & State B Response/Patch
│   │   │   ├── inspector-pane.js   # Right Pane: Ranked context, file tree, deps, verify
│   │   │   └── session-stepper.js  # Iteration timeline stepper (Problem -> Handoff -> Patch)
│   │   ├── graph/render.js         # D3 Force simulation, clustering, zoom
│   │   ├── sidebar/tree.js         # Disk file tree mirror & selection
│   │   ├── terminal/terminal.js    # Bottom terminal drawer & badge polling
│   │   ├── preview/preview.js      # Web preview iframe & dev-server state
│   │   ├── clipboard/clipboard.js  # 1-Click Paste & surgical patch caller
│   │   ├── history/history.js      # 20-step undo/redo & shortcuts
│   │   ├── issue/issue-modal.js    # Issue compiler UI & slice preview
│   │   └── shared/toast.js         # User toast notifications
│   └── contextforge-bridge.js      # Browser runtime diagnostics bridge
│
├── server/                         # Backend (Node.js / Express ES modules)
│   ├── index.js                    # Minimal server bootstrapper & route mounting
│   ├── routes/                     # Domain-partitioned Express routers
│   │   ├── extract.js              # Project extraction & graph nodes
│   │   ├── scaffold.js             # Node scaffolding & locks
│   │   ├── paste.js                # Node writeback & asset slot validation
│   │   ├── devserver.js            # Vite process manager & preview URL
│   │   ├── files.js                # Disk file tree & raw content save
│   │   ├── clipboard.js            # AI clipboard bridge & project wizard
│   │   ├── context.js              # Outlines, scoped prompts, context packaging
│   │   ├── console.js              # Compiler logs, client error reporting
│   │   ├── history.js              # Undo, redo, status, transaction clearing
│   │   └── sessions.js             # Debug sessions & verification comparison
│   ├── debug-session-manager.js    # Sidecar persistence (.contextforge.sessions.json)
│   ├── verification-comparator.js  # Structured comparison engine (SAME_ERROR, RESOLVED)
│   ├── history-manager.js          # 20-step transaction stack with disk snapshots
│   ├── console-manager.js          # Log buffers, headless checks, bridge injection
│   ├── dev-server.js               # Child-process management for Vite
│   ├── outline.js                  # Symbol outline extractors (JS, HTML, GDScript)
│   ├── project-init.js             # Game starters & patch block parser
│   ├── slot-contract.js            # Binary 3D asset & texture validation
│   ├── scaffold-validator.js       # Node ID rules & path normalization
│   └── extractors/                 # Engine extractors (Godot 4 & JavaScript)
```

---

## 3. Where to Look For Common Tasks

| If you need to modify... | Look in... | Key symbols / endpoints |
|---|---|---|
| **Issue Prompt Generation** | `server/routes/context.js` & `server/outline.js` | `POST /scoped-context`, `extractScopedSnippet` |
| **3-Pane Workstation** | `public/js/workstation/` | `initWorkstation`, `switchViewMode`, `problem-pane.js`, `workspace-pane.js` |
| **Debug Sessions & Sidecar** | `server/debug-session-manager.js` & `server/routes/sessions.js` | `createSession`, `addSessionIteration`, `.contextforge.sessions.json` |
| **Verification Comparison** | `server/verification-comparator.js` | `compareVerification`, `extractErrorFingerprints` |
| **Surgical Patch Parsing** | `server/project-init.js` & `server/routes/clipboard.js` | `parseAiEditBlocks`, `applyAiEditBlocks`, `POST /add-from-clipboard` |
| **Undo / Redo / Transactions**| `server/history-manager.js` & `server/routes/history.js` | `recordHistoryStep`, `undo`, `redo`, `POST /history/*` |
| **Browser Runtime Errors** | `public/contextforge-bridge.js` & `server/routes/console.js`| `window.onerror`, `POST /client-log`, `GET /console-logs` |
| **Godot Headless Checks** | `server/console-manager.js` | `runGodotCheck`, `isErrorLine` |
| **File Tree & Raw Viewer** | `server/routes/files.js` | `GET /file-tree`, `GET /file-content`, `POST /save-file` |
| **Vite Dev Server** | `server/dev-server.js` | `setupAndStartDevServer`, `stopDevServer` |
| **D3 Force Graph** | `public/js/graph/render.js` | `renderGraph`, `fitToView`, `applyGraphFilters` |
| **Bottom Terminal Drawer** | `public/js/terminal/terminal.js` | `toggleBottomTerminal`, `fetchBottomTerminalLogs` |
| **1-Click Paste & Apply** | `public/js/clipboard/clipboard.js` | `handleQuickPaste`, `applyClipboardContentDirectly` |

---

## 4. Strict Safety & Modification Rules

1. **Never Break Test Contracts**:
   - ContextForge has **186 passing unit & integration tests** in `server/*-test.js`.
   - Before modifying any endpoint or DOM element, run `npm test`.
   - Never change existing DOM IDs (`btn-sidebar-toggle`, `files-menu`, `btn-add-from-clipboard`, `btn-console`, `btn-view-graph`, `btn-view-workstation`) as tests rely on them.
2. **Never Silently Apply Fuzzy Matches**:
   - In the patch engine, `<<<<<<< FIND` must match **exactly once**. If exact match fails, prompt the user with a preview or recovery prompt. Never alter disk code blindly.
3. **Preserve Single Responsibility**:
   - Keep files below 400 lines where practical.
   - Do not add network calls or UI rendering directly to route handlers or parsers.
4. **All File Writes Must Be Transactional**:
   - Every modification to project code must call `recordHistoryStep()` so the user can hit `Ctrl+Z` to rollback.
