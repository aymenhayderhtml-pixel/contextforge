# ContextForge — Patch Safety & Transaction Subsystem

> **Core Purpose**: Parse AI responses, strictly validate surgical patches against the filesystem, record reversible disk transactions, and verify that code changes build cleanly.

---

## 1. Supported AI Formats

### Format 1: Surgical Edit (Preferred)
```text
### EDIT: relative/path/to/file.ext
<<<<<<< FIND
exact original lines of code
=======
corrected replacement lines
>>>>>>> REPLACE
```
*Also accepts `<<<<<<< SEARCH`, `EDIT:`, `PATCH:`, `UPDATE:`, and backtick wrapping.*

### Format 2: Full File (Create / Overwrite)
```text
### FILE: relative/path/to/file.ext
```javascript
<full file contents>
```
```

---

## 2. Strict Safety & Matching Rules

1. **Exact 1-Match Rule**:
   - `0 matches`: **REJECT**. File is unmodified; error is returned showing the unfindable snippet.
   - `2+ matches`: **REJECT**. Ambiguous target; error requires the AI to include more surrounding lines.
   - `1 match`: **SAFE TO APPLY**.
2. **Directory Traversal Guard**:
   - `norm.includes('..')` is strictly rejected to prevent writes outside project root.
3. **No Silent Fuzzy Writes**:
   - If an exact match fails due to minor whitespace or indentation, ContextForge **never silently writes to the wrong location**.
   - Instead, it highlights the mismatch and offers a 1-click **Recovery Prompt** containing the exact 10 lines from disk.

---

## 3. Transaction & Rollback Engine

Every applied patch receives a sequential ID (`PATCH #001`, `PATCH #002`...):
- Snapshots before/after state of all touched files.
- Automatically handles new file creation (deletes on Undo; restores on Redo).
- Capped at 20 steps per project.
- Exposes:
  - `POST /history/undo`
  - `POST /history/redo`
  - `GET /history/status`
  - `POST /history/clear`
- Accessible via UI buttons (`↺` / `↻`) and `Ctrl+Z` / `Ctrl+Y` shortcuts.
