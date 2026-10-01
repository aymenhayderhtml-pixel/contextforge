# Fix the Motor-Racing Game's ContextForge Modeling Hook

Project: `/home/aymen/Documents/class trash/test oen/motor-racing`
Date: 2026-09-28
Status: diagnosed, not yet applied

---

# Prompt for the Engine AI

You are fixing a bug in **motor-racing**, a Three.js + Vite racing game. This is
the game project itself, not the ContextForge tool. Your changes belong in this
repo only. Do not edit anything under `/home/aymen/Documents/contextforge`.

## The symptom

Open the game in ContextForge's Modeling view. The viewport sits on
"Starting Project Server…" forever. The outliner reads "0 objects", the
inspector reads "None", and the connection pill reads "No Game". The game itself
runs perfectly when opened directly — this is purely a missing integration.

## Root cause

`src/main.js` is the entire entry point:

```js
import { Game } from './game.js';

export const GAME_TITLE = 'Motor Racing';

const container = document.getElementById('game-container') || document.body;

const game = new Game(container);
game.start();
```

It never calls `installContextForge`. ContextForge's Modeling view mirrors the
live Three.js scene by receiving a serialized `scene.toJSON()` snapshot that the
**runtime** publishes over a WebSocket. The runtime is never loaded, so no
snapshot is ever produced and the Modeling view has nothing to draw.

The runtime module is **already present** in this project:

```
contextforge/runtime.js
contextforge/vendor/GLTFLoader.js
contextforge/vendor/SkeletonUtils.js
```

Only the call site is missing. You are not adding a dependency — you are
calling something that is already there.

## The fix

Rewrite `src/main.js` to install the runtime after constructing the game and
before starting it. **This is the whole corrected file:**

```js
import * as THREE from 'three';
import { Game } from './game.js';
import { installContextForge } from '../contextforge/runtime.js';

export const GAME_TITLE = 'Motor Racing';

const container = document.getElementById('game-container') || document.body;

const game = new Game(container);

// ContextForge Modeling Runtime Hook
// Installed after construction (the scene is fully built in the Game
// constructor) and before start(), so the runtime can serialize a complete
// scene. No-op unless the URL carries ?cf=1, so the game is unaffected in
// normal play.
installContextForge({
  THREE,
  scene: game.scene,
  getCamera: () => game.camera,
  renderer: game.renderer,
  GLTFLoader: null,
});

game.start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.dispose();
  });
}
```

`GLTFLoader: null` is **correct and intentional**, not a placeholder to fill in.
The runtime resolves its own loader through four fallbacks (`runtime.js`
`getGLTFLoader`, around line 182): a game-supplied loader, then `window.GLTFLoader`,
then the game's own `node_modules/three/examples/jsm/`, then ContextForge's
vendored copy at `/contextforge/vendor/GLTFLoader.js`. Passing `null` lets that
chain work. Passing a real loader would take priority and bypass the fallbacks.

## Why this exact shape

Read the actual `Game` class before assuming anything. Verified facts from
`src/game.js`:

| Fact | Location | Consequence for the hook |
|---|---|---|
| `this.scene` assigned in the constructor | `game.js:132` | Scene exists after `new Game(container)` |
| Scene fully populated in the constructor | `game.js:136-180` (track, world, effects, ghost player, cars) | Hook must run **after** construction |
| `this.camera` assigned in the constructor | `game.js:133` | Pass a getter, not a value, so camera moves stay live |
| `this.renderer` assigned in the constructor | `game.js:119` | Pass it so renderer settings are reported accurately |
| `this.sceneManager` | does not exist | Do **not** reference it. The ContextForge auto-installer generates a call that does, and that call is the original bug. |
| `this.animate = this.animate.bind(this)` | does not exist | This was the installer's other anchor. Its absence is why the auto-installer fell through to a broken top-level append. |
| Loop is `const loop = () => { ...; this.step(); }` inside `start()` | `game.js:341-348` | The runtime wraps `requestAnimationFrame`, not an `animate` method. Compatible. |
| `import * as THREE from 'three'` lives in `game.js:1` | `game.js:1` | `main.js` does not currently import THREE — you must add it |
| `import.meta.hot` dispose block | present in `main.js` | Keep it. Vite HMR must still dispose the game. |

## Critical constraints

- **Do not change `src/game.js`.** The hook is added in `main.js` only. The `Game`
  class, its loop, and every other module stay exactly as they are.
- **Do not pass a `sceneManager`.** It does not exist on this class.
- **Keep `GLTFLoader: null`.** See above.
- **Keep the HMR dispose block.** Removing it leaks a WebGL context and two RAF
  loops on every hot reload.
- **Do not add a dependency.** `three` is already in `package.json`.
- **Do not modify `contextforge/runtime.js`.** It is a tool-owned file. If you
  believe the runtime has a bug, report it as a finding — do not patch it.
- **Preserve `export const GAME_TITLE`.** It may be referenced elsewhere.

## Verification

Work through these in order. Do not report success until the last one passes.

1. **Static check — the game must still boot.** Run `npm run build`. A
   `ReferenceError` at module evaluation would fail here, which is exactly the
   failure mode of the original ContextForge auto-installer's output. Must pass
   with zero errors.

2. **Static check — the hook is actually reached.** Confirm `main.js` contains
   the `installContextForge` import and call, and that the path
   `../contextforge/runtime.js` resolves. From the project root:
   ```bash
   node --input-type=module -e "import('./contextforge/runtime.js').then(()=>console.log('runtime resolves')).catch(e=>console.log('FAIL',e.message))"
   ```
   Must print `runtime resolves`.

3. **Behaviour check — the game is unchanged without `?cf=1`.** Open
   `http://localhost:5173/` normally. The race must run exactly as before: menu,
   countdown, driving, HUD, audio. The runtime self-disables when the URL has no
   `?cf=1` (`runtime.js:11-13`), so this must be a true no-op. If anything about
   the game changed in normal play, the hook is mis-installed and must be
   re-examined.

4. **Behaviour check — snapshots flow with `?cf=1`.** Start ContextForge, open
   this project, go to the Modeling view, press Play. The Modeling view must:
   - stop showing "Starting Project Server…"
   - show a populated scene outliner (this track has many objects: track
     segments, barriers, trees, mountains, 6 cars, HUD elements)
   - show the connection pill as connected
   - show a rendered viewport instead of an empty grid

5. **Live-edit check — the round trip works.** In the Modeling view, select any
   object in the outliner, move it, and confirm the change appears in the running
   game tab. Then move it back. This proves the socket is bidirectional, not just
   a one-way snapshot feed. If the game tab does not update, the snapshot loaded
   but the reverse channel is broken — report that as a separate finding.

6. **Non-regression — existing tests still pass.** Run the existing test:
   ```bash
   node tests/race.test.mjs
   ```
   Must report 0 failures, unchanged from before your change. Record the exact
   count before and after.

7. **Scope check — nothing else changed.** Run `git status` and `git diff` in
   this project. The only modified file must be `src/main.js`. If any other
   file under `src/`, `contextforge/`, or `index.html` shows as modified, revert
   it — the fix is one file.

## Failure modes to recognise

- **Modeling view still spins.** The hook did not run. Check: is the import path
  right? Did you place the call before `game.start()`? Is the server serving the
  project root so `/contextforge/runtime.js` resolves?
- **Blank game, console error.** You broke module evaluation — most likely an
  unresolved import path. `npm run build` catches this; run it first.
- **Game works but Modeling view is empty.** The hook installed but the socket
  did not connect. Open the game tab's devtools console and look for
  `[ContextForge Runtime] Connected to /cf WebSocket`. Absent means the runtime
  never activated, i.e. the URL lacked `?cf=1`.
- **Modeling view populates but only on reload.** A timing issue between
  `installContextForge` and the first snapshot. The hook must be installed
  *before* `start()` so the editor's connect-time `req_snapshot` is answered.
- **Objects appear but transforms do not apply.** The socket connects but the
  reverse channel is not delivering. Check `getCamera` is passed as a function,
  not a captured value.

## Report back

Report in this order, with file:line citations for every claim:

1. **What changed** — per file, not as a diff narrative.
2. **Verification results** — the actual output of each of the 7 checks above,
   with concrete pass/fail numbers. Do not write "pass" or "works" without the
   evidence behind it. If a check could not be run and why, say so plainly
   rather than glossing over it.
3. **Remaining known issues** — anything you noticed but did not fix, and why.

Do not commit. Do not push. Do not touch the ContextForge repo.

---

## Appendix — why the ContextForge auto-installer failed

Background, so you can confirm the fix addresses the real cause. ContextForge's
"Install Hook" button generates the hook call automatically. In
`server/modeling-project-server.js` (`checkHookInstallation`, around lines
597-605) it looks for an anchor:

```js
if (modified.includes('this.animate = this.animate.bind(this);')) {
  // insert here
} else if (modified.includes('requestAnimationFrame(`)) {
  // insert here
} else {
  modified += `\n${hookCall}\n`;   // <-- this project's main.js landed here
}
```

This project's `main.js` has neither anchor, so the generated call was appended
at module top level. The generated call reads `this.scene`, `this.camera` and a
bare `THREE` — all invalid at ESM top level, where `this` is `undefined`. That is
a `ReferenceError` raised during module evaluation, which prevents `main.js` from
evaluating at all, so the game never starts. Pressing "Install Hook" would have
made the bug strictly worse.

The fix above avoids that by placing the call where `this` is irrelevant — a
module-level `const game` — and importing `THREE` explicitly. It also passes the
real property names this class actually has (`scene`, `camera`, `renderer`) rather
than the `sceneManager` shape the installer assumes.

Two further issues live in the ContextForge tool itself and are **out of scope**:
a missing connect watchdog that turns silence into a diagnosis, and a mismatch
between the globals the diagnostics bridge and the runtime each rely on. Both are
recorded in `docs/MODELING_HOOK_REPORT.md` and tracked as T132–T136 in ContextForge's
`TASKS.md`. Raise them as findings if you hit them, but do not fix them here.
