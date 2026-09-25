# LOOP.md — Autonomous Working Loop

Follow this loop for every work session. Do not deviate without logging why.

1. Read `TASKS.md`. Find the next unchecked task in the **current** phase (do not jump
   ahead to a later phase while tasks remain unchecked in this one).
2. Read the relevant section of `docs/ARCHITECTURE.md` before writing code for that task.
   Don't re-derive the design from scratch or invent a different shape for the manifest,
   the extractor interface, or the API — if the doc is unclear or wrong, say so under
   "Blocked / Needs Input" in TASKS.md rather than silently deciding your own version.
3. If Phase 4 (Task Locking) has already been built: before editing any file tied to a
   manifest node, call `POST /lock` for that node first. If it's already locked by another
   session, do not edit that file — log it and pick a different task instead. Release the
   lock (`POST /unlock`) when the task is checked off or abandoned.
4. Implement the task.
5. Test it against the relevant fixture project in `/test-fixtures`. If no fixture exists
   yet for what you're testing, create a minimal one first (a handful of files is enough —
   do not build a large fixture).
6. **If the test passes:** check the task off in TASKS.md with a one-line note of what was
   built/changed, and commit.
7. **If the test fails or reveals a design gap:** do not silently reinterpret the spec or
   patch around it with a guess. Add a note under "## Blocked / Needs Input" in TASKS.md
   describing exactly what's ambiguous, broken, or missing — then move to the next
   independent task rather than guessing and continuing.
8. **Phase discipline:** finish all of a phase's tasks (or explicitly block them) before
   starting the next phase. Do not batch several phases into one pass.
9. Checkpoint after each phase: summarize in TASKS.md what phase just completed and what
   the tool can now actually do, in plain language, before starting the next phase.
10. **Never hand-edit `manifest.json`.** If its output looks wrong, the fix is always in the
    extractor that generated it.

## When you're unsure
Prefer stopping and logging a question over guessing silently. This tool exists to
eliminate silent, wrong guesses about how code connects — it should not itself be built by
making silent, wrong guesses about its own spec.

## Resuming a session
On "continue", re-read TASKS.md's checked/unchecked state and the most recent "Blocked /
Needs Input" entries before doing anything else — don't assume you remember where you left
off.
