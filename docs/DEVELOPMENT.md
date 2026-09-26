# ContextForge — Development & Contributing Guide

## 1. Quick Start Commands

```bash
# Start ContextForge server on port 3000
npm start

# Run all 162 unit & integration tests
npm test

# Run individual subsystem tests
node server/history-test.js          # Undo/redo transaction tests
node server/console-test.js          # Compiler & terminal diagnostics
node server/dev-server-test.js       # Vite process manager
node server/new-project-flow-test.js # AI clipboard & wizard flow
```

---

## 2. File Size & Cohesion Policy

To keep ContextForge easy for both human developers and external AIs to understand:
- **Normal**: `< 400 lines` (Target size for cohesive modules).
- **Review Architecture**: `400–700 lines`.
- **Refactor Candidate**: `> 700 lines` (Split into submodules).

---

## 3. Preserving Test Safety

Before committing any change:
1. Run `npm test`.
2. Ensure all tests pass.
3. Keep all DOM element IDs (`btn-sidebar-toggle`, `files-menu`, `btn-add-from-clipboard`, `btn-console`) intact in `public/index.html`.
4. Ensure new routes or endpoints have corresponding unit tests in `server/*-test.js`.
