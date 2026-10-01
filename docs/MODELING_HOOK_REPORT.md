# Modeling View Shows No Scene — Root-Cause Report

Date: 2026-09-28
Reported by: live session (motor-racing project)
Status: diagnosed, not fixed

## Executive Summary

The Modeling view never populates. Two independent breaks sit in the snapshot
chain, and both must be fixed — fixing either alone still leaves the view empty.

1. The game's `main.js` has no `installContextForge` hook, so the game never
   opens a `role=game` socket to the project server's `/cf` endpoint. The editor's
   snapshot request is forwarded to a `null` game socket and dropped.
2. The HTTP fallback that would otherwise cover break #1 is dead for a second,
   independent reason: `public/contextforge-bridge.js` polls for a global
   (`window.__CONTEXTFORGE_GAME__`) that no code in the project ever sets.

Because no snapshot arrives and no error is raised, the loading overlay raised in
`launchGameSession` is never dismissed — it sits on "Starting Project Server…"
forever. That is the exact state in the screenshot.

**A third defect makes this unrecoverable by the user:** the "Install Hook" button
would corrupt the project rather than fix it. `checkHookInstallation` anchors the
injected call on a template assumption that this project's `main.js` does not
satisfy, so it falls through to a top-level append that is a guaranteed
`ReferenceError` at module evaluation. Pressing it breaks the game entirely.

## Causal Chain

1. **`/home/aymen/Documents/class trash/test oen/motor-racing/src/main.js` has no hook.**
   The whole file is `new Game(container); game.start();`. There is no
   `installContextForge` import and no call. `server/modeling-project-server.js:569`
   detects this correctly (`code.includes('installContextForge')` → false).

2. **So `server/runtime.js` never executes in the game tab.** The `role=game` socket
   is opened from `server/runtime.js:1433`, and that module is only reached through
   the missing hook. No game socket exists.

3. **So the editor's `req_snapshot` goes nowhere.** `public/js/modeling/modeling-view.js:1755`
   sends `{type:'req_snapshot'}` on connect. The server forwards it at
   `server/modeling-project-server.js:247` guarded by
   `if (serverEntry.gameWs && ... readyState === OPEN)`. `gameWs` is `null`, so the
   message is silently discarded.

4. **And the HTTP fallback is independently dead.**
   `modeling-view.js:1706` falls back to `GET /game-scene-snapshot`. That endpoint is
   populated only by `public/contextforge-bridge.js:183`, inside `sendSceneSnapshot()`,
   which begins at `contextforge-bridge.js:159`:
   ```js
   if (!window.__CONTEXTFORGE_GAME__ || !window.__CONTEXTFORGE_GAME__.scene) return;
   ```
   Grepping the project returns **no definition of `__CONTEXTFORGE_GAME__` anywhere**
   in `src/` or `index.html`. The bridge polls 60 times (`contextforge-bridge.js:240`),
   abandons, and never POSTs.

5. **So the overlay never clears.** `hideLoadingState()` is called from exactly five
   places: snapshot success (`modeling-view.js:913`), snapshot error (`:929`), the
   `launchGameSession` catch (`:1885`), and the hook-check modal (`:3663`, `:3672`).
   With no snapshot and no thrown error, the call at `modeling-view.js:1857`
   ```js
   showLoadingState('Starting Project Server...');
   ```
   is never followed by its counterpart. There is no timeout, no watchdog, and no
   "no game detected" branch. The user gets a spinner, not a diagnosis.

## The Third Defect: the installer would break the game

`server/modeling-project-server.js:597-605` picks an anchor for the injected call:

```js
if (modified.includes('this.animate = this.animate.bind(this);')) {
  ...
} else if (modified.includes('requestAnimationFrame(')) {
  ...
} else {
  modified += `\n${hookCall}\n`;   // line 604
}
```

The motor-racing `main.js` contains **neither** anchor, so the `else` branch runs and
appends the hook verbatim to module top level:

```js
installContextForge({
  THREE,
  scene: this.scene,
  getCamera: () => (this.sceneManager ? this.sceneManager.camera : this.camera),
  renderer: (this.sceneManager ? this.sceneManager.renderer : this.renderer),
  GLTFLoader: null
});
```

That is a `ReferenceError` at module evaluation, not a runtime hiccup. Two independent
reasons it cannot work there:

- `this` is `undefined` at ESM top level, so `this.scene` throws on first property access.
- `THREE` was never imported into `main.js`; it is imported in `game.js` (`game.js:1`).

A module-evaluation `ReferenceError` prevents the whole module graph from evaluating, so
`game.start()` never runs. The game stops loading completely — a strictly worse outcome
than the current "Modeling view is empty" bug.

The generated code also assumes a `this.sceneManager` shape that this project does not
have. `game.js:119-133` shows the real shape: `Game` holds `this.scene`, `this.camera`,
and `this.renderer` **directly**, with the world built in the constructor.

### The correct hook for this project

`contextforge/runtime.js` is already copied into the project
(`<project>/contextforge/runtime.js`, and vendored loaders in `contextforge/vendor/`).
Only the call site is missing. For a project whose `Game` class owns the scene directly:

```js
// src/main.js
import * as THREE from 'three';
import { Game } from './game.js';
import { installContextForge } from '../contextforge/runtime.js';

const container = document.getElementById('game-container') || document.body;
const game = new Game(container);

installContextForge({
  THREE,
  scene: game.scene,
  getCamera: () => game.camera,
  renderer: game.renderer,
  GLTFLoader: null
});

game.start();
```

Notes on the shape, all verified against the project:

- `GLTFLoader: null` is correct and intentional. `runtime.js:182-236` resolves a loader
  itself through four fallbacks and chains to ContextForge's vendored copy at
  `/contextforge/vendor/GLTFLoader.js`. The project's own node_modules is tried first.
- The hook must be installed **after** `new Game(container)` and **before** `game.start()`,
  because the `Game` constructor builds the entire scene (`game.js:132-180`).
- `getCamera` is a getter, not a value, so editor camera moves stay live.
- Installing the runtime does not modify the game's behaviour unless the URL carries
  `?cf=1` (`runtime.js:11-13`); outside that the install is a no-op.

## Why the user could not self-diagnose

- The connection pill reads **"No Game"** while the overlay claims the server is
  *starting* — two contradictory signals, because the pill tracks WebSocket state and
  the overlay tracks fetch state.
- No error is surfaced. The failure is a silent null-socket drop inside the server
  (`modeling-project-server.js:247`), not an exception.
- The one affordance that looks like a remedy ("Install Hook") is the thing that
  would break the project.

## Recommendations

Ordered by dependency. The first is a prerequisite for the rest.

**1. Never auto-inject a call without a verified anchor (correctness, high severity).**
`checkHookInstallation` should verify its hook is being placed at module top level vs.
inside a class method. If no anchor is found, it must return an explicit
"cannot auto-install — manual hook required" result rather than appending. The
`else` branch at `modeling-project-server.js:604` is the defect.

**2. Add a connect watchdog so silence becomes a diagnosis (UX, high severity).**
`launchGameSession` should race the snapshot against a timeout. On timeout, hide the
overlay and state the actual cause: "Game started but has not connected to ContextForge.
Install the runtime hook in `src/main.js`." That single change turns this bug class
from undebuggable into self-diagnosing.

**2b. Surface hook status in the disconnected card (UX).**
`updateDisconnectedCard()` (`modeling-view.js:4048`) already renders the project path.
It should also show whether the runtime hook is installed, by reusing the existing
`POST /modeling/hook/check` route. Reuse, not a new endpoint.

**3. Reconcile the bridge's global with the runtime (correctness, moderate).**
`contextforge-bridge.js:159` depends on `window.__CONTEXTFORGE_GAME__`, but
`runtime.js` never sets it. The runtime publishes `window.__CONTEXTFORGE_RUNTIME__`
instead (`runtime.js:1656`). A project with the hook installed but no
`__CONTEXTFORGE_GAME__` still has no HTTP fallback. Either have the runtime set
`__CONTEXTFORGE_GAME__` from its own instance, or have the bridge accept
`__CONTEXTFORGE_RUNTIME__` as an equivalent source. Today the two subsystems assume
different globals and assume each other is handling it.

**4. Add a regression test asserting the overlay clears (correctness, moderate).**
`server/modeling-phase1-test.js` exists and is already in `npm test` (40 assertions,
40 in the `assert` count). It does not cover the failure path. Add a case that
drives `launchGameSession` against a project with no hook installed and asserts the
overlay is dismissed with a diagnostic, rather than left spinning.

## Scoping Notes

- The motor-racing project itself was **not modified**. No file under
  `/home/aymen/Documents/class trash/test oen/motor-racing` was touched during
  this diagnosis. The hook shown above is a proposal, not an applied change.
- Finding 3 (`__CONTEXTFORGE_GAME__`) is a real pre-existing gap, not a regression
  from recent work, and is **out of scope** for the immediate fix. It is recorded
  here so it is not rediscovered later, and it is routed to the Deferred section
  below rather than silently folded into the P0 work.
- `TASKS.md` in this working copy is **stale** relative to the committed history.
  The worktree copy ends at T123; the committed version contains T124–T131
  (favorites library, file picker, raycast selection). All IDs in the prompt below
  are computed from the committed file, so **T132 is the next free ID**.

## Deferred / Not yet scheduled

- Bridge/runtime global reconciliation (`__CONTEXTFORGE_GAME__` vs
  `__CONTEXTFORGE_RUNTIME__`) — real, pre-existing, but fixing the hook installer
  and the watchdog resolves the user's actual problem. Do it as its own change so
  the P0 fix stays reviewable.
- Make the injected hook's default argument shape engine-agnostic rather than
  hardcoded to a `sceneManager` layout — only worth doing once anchor verification
  (rec #1) exists and no broken code is being generated.

---

# Prompt for the Engine AI

The following is the task handoff. It is self-contained: an agent that has never
seen this project can execute it from the text alone.

---

You are fixing a bug in ContextForge, a Node/Express + vanilla-JS inspector for
Godot 4.x and Three.js projects. Repository root is the ContextForge repo; the game
being inspected is an external project (a Three.js racing game) that ContextForge
must never modify.

## Context: how the Modeling view is supposed to work

ContextForge's Modeling view mirrors the running Three.js game into an editor
viewport. The data path is:

```
game tab  --(ws role=game /cf)-->  project server  --(ws role=editor /cf)-->  editor
game tab  --(POST /game-scene-snapshot)-->  main server  --(GET)  -->  editor fallback
```

- `server/runtime.js` is copied into the game project and injected by the game's
  own `main.js` via an `installContextForge({...})` call. It opens the `role=game`
  socket and serializes the scene with `scene.toJSON()`.
- `server/modeling-project-server.js` runs one static+WebSocket server per project,
  exposing `/cf`. It relays between the game socket and editor sockets, and caches
  the last snapshot.
- `public/js/modeling/modeling-view.js` is the editor. It connects as `role=editor`
  and requests a snapshot on connect.
- `public/contextforge-bridge.js` is a separate HTTP-based fallback that posts the
  scene to `POST /game-scene-snapshot` when a global is present.

## The bug

The Modeling view shows "Starting Project Server…" forever. The outliner reads
"0 objects" and the inspector reads "None". Three defects, in dependency order.

### Defect 1 — the hook installer generates code that crashes the game

`server/modeling-project-server.js`, `checkHookInstallation` / `installHook`,
the anchor search at lines ~597-605:

```js
if (modified.includes('this.animate = this.animate.bind(this);')) {
  ...
} else if (modified.includes('requestAnimationFrame(')) {
  ...
} else {
  modified += `\n${hookCall}\n`;   // <-- the defect
}
```

The generated `hookCall` references `this.scene`, `this.camera`, `this.sceneManager`
and a bare `THREE`. When no anchor is found it is appended at **module top level**,
where `this` is `undefined` in ESM and `THREE` was never imported. That is a
`ReferenceError` during module evaluation, which prevents `main.js` from
evaluating at all — the game stops loading entirely.

The user hitting this bug is on a project whose `main.js` has no anchor, so
"Install Hook" would have destroyed their working game rather than fixed it.

**Fix required:** when no anchor is found, do not append. Return an explicit
result distinguishing "not installed" from "cannot auto-install, manual hook
required", and surface that in the diff modal. Optionally add a guarded variant of
the call that is safe at top level (e.g. wrapping the object literal in a
function and deferring the call), but the mandatory fix is to stop generating
broken code.

**Constraint:** ContextForge must never modify the host game's source. The hook is
delivered by the user or by the game author, not written by the tool. Do not
"fix" this by making the installer smarter about editing the host file.

### Defect 2 — a missing hook is silent; no watchdog turns it into a diagnosis

`public/js/modeling/modeling-view.js`, `launchGameSession` at line ~1847:

```js
showLoadingState('Starting Project Server...');   // line 1857
const res = await fetch('/modeling/server/start', { ... });
// on success: connectToGameWebSocket(data.wsUrl) — and then nothing.
```

`hideLoadingState()` is called from only five sites: snapshot success (~913),
snapshot error (~929), the fetch catch (~1885), and the hook-check modal
(~3663, ~3672). If the game never connects, none of them run, so the overlay
sits forever. There is no timeout.

Worse, the failure is invisible on the server side too: at
`server/modeling-project-server.js:247` the relay is guarded by

```js
if (serverEntry.gameWs && serverEntry.gameWs.readyState === WebSocket.OPEN) {
  serverEntry.gameWs.send(JSON.stringify(msg));
}
```

so the editor's `req_snapshot` is silently dropped when no game is attached.

**Fix required:** race the snapshot against a timeout. On timeout, dismiss the
overlay and state the cause — "Game started but has not connected to ContextForge.
Install the runtime hook in <entry file>." This is the single highest-value change
in the set: it converts the entire bug class from undebuggable to self-diagnosing.

**Also:** show hook status in the disconnected card. `updateDisconnectedCard()`
(~line 4048) already renders the project path; add hook presence using the
existing `POST /modeling/hook/check` route. Reuse that route, do not add a new one.

**Constraint:** the fix must not steal focus or reset editor state (selection,
camera, gizmo, expanded tree groups). A late snapshot arriving after the timeout
fired must still be applied normally, not dropped.

### Defect 3 — the HTTP fallback depends on a global nothing sets

`public/contextforge-bridge.js:159`:

```js
if (!window.__CONTEXTFORGE_GAME__ || !window.__CONTEXTFORGE_GAME__.scene) return;
```

No code in any inspected project sets `__CONTEXTFORGE_GAME__`. Meanwhile
`server/runtime.js:1656` publishes a **different** global,
`window.__CONTEXTFORGE_RUNTIME__`, which also carries `.scene`. The two
subsystems assume the other one handles the bridge. A project with the hook
correctly installed still has no working HTTP fallback.

The bridge gives up after 60 polls (`contextforge-bridge.js:240`).

**Fix required:** make the two agree. Either have `runtime.js` set
`__CONTEXTFORGE_GAME__` from its own instance for backward compatibility, or have
the bridge accept `__CONTEXTFORGE_RUNTIME__` as an equivalent source. Pick one and
make it explicit in a comment naming who sets what and who reads it.

**Scope note:** this is a pre-existing gap, not a regression. It is the lowest
priority of the three — once Defects 1 and 2 are fixed, a correctly-hooked project
works over the WebSocket and this no longer blocks anyone. Fix it in its own
commit so the P0 work stays reviewable.

### Defect 4 — no regression test for the failure path

`server/modeling-phase1-test.js` is already in `npm test`. Add a case that drives
the connect flow against a project **without** a hook installed and asserts that
the overlay is dismissed with a diagnostic message — i.e. that silence becomes a
diagnosis. Assert the timeout path fires, not just the happy path.

## Hard constraints

- **Never modify the host game's source code.** Everything is delivered through the
  injected runtime the game already loads. The motor-racing project under test is
  external; this repo is the tool.
- **Keep dependencies light.** Use `node:test` / `node:assert`. Do not add packages.
- **Surgical fixes only.** Do not refactor the modeling view, the project server, or
  the runtime while fixing these. Fix the defect; leave the surrounding system alone.
- **Preserve the existing hook contract.** `server/runtime.js` resolves its own
  GLTFLoader through four fallbacks and must not be changed to require a
  game-supplied loader.
- **Add task IDs T132+** to `TASKS.md`. Compute the next free ID from the committed
  file — the working copy in this sandbox is stale and ends at T123, while the
  committed history already contains T124–T131. Verify before assigning.

## Acceptance criteria

- [ ] Pressing "Install Hook" on a project with no anchor never writes code that
      fails at module evaluation. Verified by a test that runs the generated code.
- [ ] With a game tab open and no hook installed, the Modeling view stops spinning
      within a bounded time and names the missing hook as the cause.
- [ ] A snapshot arriving after the timeout still renders normally.
- [ ] A project with the hook installed works over the WebSocket **and** has a
      working HTTP fallback.
- [ ] `npm test` passes with zero failures, including the new failure-path test.
- [ ] The host game project's files are unmodified (`git status` on that project
      shows no changes to its own source).
