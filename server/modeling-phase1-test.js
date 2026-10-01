import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import express from 'express';
import modelingRouter from './routes/modeling.js';
import {
  startProjectGameServer,
  stopProjectGameServer,
  saveLayout,
  loadLayout,
  checkHookInstallation,
  installHook,
  ensureRuntimeCopied
} from './modeling-project-server.js';

test('Phase 1: Modeling Server, WebSocket, Layout & Hook Lifecycle', async (t) => {
  const root = process.cwd();
  const testDir = join(root, 'test-fixtures', 'phase1-sample');

  // Clean / setup test project
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(join(testDir, 'src'), { recursive: true });

  const initialMainJs = `import * as THREE from 'three';

export class Game {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.renderer = new THREE.WebGLRenderer();

    this.animate = this.animate.bind(this);
    this.animate();
  }

  animate() {
    requestAnimationFrame(this.animate);
  }
}

new Game();
`;
  writeFileSync(join(testDir, 'src', 'main.js'), initialMainJs, 'utf-8');
  writeFileSync(join(testDir, 'index.html'), '<!DOCTYPE html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>', 'utf-8');

  t.after(() => {
    stopProjectGameServer(testDir);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  await t.test('1. Hook check and atomic installation with diff', async () => {
    // Check initial state
    const check1 = checkHookInstallation(testDir);
    assert.strictEqual(check1.installed, false);
    assert.ok(check1.diff.includes('installContextForge'));
    assert.ok(check1.diff.includes('runtime.js'));

    // Install hook
    const installRes = await installHook(testDir);
    assert.strictEqual(installRes.success, true);
    assert.ok(existsSync(join(testDir, 'contextforge', 'runtime.js')));

    const modifiedMain = readFileSync(join(testDir, 'src', 'main.js'), 'utf-8');
    assert.ok(modifiedMain.includes('installContextForge'));
    assert.ok(modifiedMain.includes("from '../contextforge/runtime.js'"));

    // Check again - should be marked installed
    const check2 = checkHookInstallation(testDir);
    assert.strictEqual(check2.installed, true);
  });

  await t.test('2. Atomic Layout Save & Load with .bak copy', async () => {
    // 'Crate_0' is NOT in config.json drivenIds, so position/rotation are persisted.
    // (Driven ids like Kart_Player are covered separately in test 2b.)
    const sampleLayout = {
      version: 1,
      objects: {
        'Crate_0': {
          position: [1.2, 0.45, -3.5],
          rotation: [0, 1.57, 0],
          scale: [1, 1, 1],
          visible: true
        }
      }
    };

    // Save initial
    await saveLayout(testDir, sampleLayout);
    assert.ok(existsSync(join(testDir, 'contextforge', 'layout.json')));

    const loaded1 = await loadLayout(testDir);
    assert.strictEqual(loaded1.version, 1);
    assert.deepStrictEqual(loaded1.objects['Crate_0'].position, [1.2, 0.45, -3.5]);

    // Save update — verify .bak is created
    const updatedLayout = {
      version: 1,
      objects: {
        'Crate_0': {
          position: [5.0, 0.45, 10.0],
          rotation: [0, 3.14, 0],
          scale: [1.2, 1.2, 1.2],
          visible: true
        }
      }
    };

    await saveLayout(testDir, updatedLayout);
    assert.ok(existsSync(join(testDir, 'contextforge', 'layout.json.bak')), 'Should create .bak copy');

    const bakData = JSON.parse(readFileSync(join(testDir, 'contextforge', 'layout.json.bak'), 'utf-8'));
    assert.deepStrictEqual(bakData.objects['Crate_0'].position, [1.2, 0.45, -3.5], 'Bak must have previous position');

    const loaded2 = await loadLayout(testDir);
    assert.deepStrictEqual(loaded2.objects['Crate_0'].position, [5.0, 0.45, 10.0], 'Current must have updated position');
  });

  await t.test('2b. Driven ids strip position/rotation but keep scale/visible', async () => {
    // Kart_Player and Kart_AI_* are driven: game code owns their transform,
    // so saveLayout must never persist position or rotation for them.
    const layout = {
      version: 1,
      objects: {
        'Kart_Player': {
          position: [7.5, 1.25, -9.0],
          rotation: [0.1, 1.57, 0.2],
          scale: [1.5, 1.5, 1.5],
          visible: true
        },
        'Kart_AI_2': {
          position: [3.0, 0.5, 4.0],
          rotation: [0, 0.5, 0],
          scale: [1.18, 1.18, 1.18],
          visible: false
        }
      }
    };

    await saveLayout(testDir, layout);
    const saved = await loadLayout(testDir);

    for (const id of ['Kart_Player', 'Kart_AI_2']) {
      const o = saved.objects[id];
      assert.ok(o, `${id} should be present in saved layout`);
      assert.strictEqual(o.position, undefined, `${id}.position must be stripped (driven)`);
      assert.strictEqual(o.rotation, undefined, `${id}.rotation must be stripped (driven)`);
    }

    // Scale and visible are NOT stripped — they are editor-owned.
    assert.deepStrictEqual(saved.objects['Kart_Player'].scale, [1.5, 1.5, 1.5],
      'Kart_Player.scale must be persisted');
    assert.strictEqual(saved.objects['Kart_Player'].visible, true,
      'Kart_Player.visible must be persisted');
    assert.deepStrictEqual(saved.objects['Kart_AI_2'].scale, [1.18, 1.18, 1.18],
      'Kart_AI_2.scale must be persisted');
    assert.strictEqual(saved.objects['Kart_AI_2'].visible, false,
      'Kart_AI_2.visible must be persisted');
  });

  await t.test('3. Static Project Server & /cf WebSocket Communication', async () => {
    const srvInfo = await startProjectGameServer(testDir);
    assert.ok(srvInfo.port > 0);
    assert.ok(srvInfo.url.includes(String(srvInfo.port)));
    assert.ok(srvInfo.wsUrl.includes('/cf'));

    // Verify static serving
    const indexRes = await fetch(`${srvInfo.url}index.html`);
    assert.strictEqual(indexRes.status, 200);

    const runtimeRes = await fetch(`${srvInfo.url}contextforge/runtime.js`);
    assert.strictEqual(runtimeRes.status, 200);

    const layoutRes = await fetch(`${srvInfo.url}contextforge/layout.json`);
    assert.strictEqual(layoutRes.status, 200);

    // Connect editor WebSocket
    const editorWs = new WebSocket(`${srvInfo.wsUrl}?role=editor`);
    await new Promise((res) => (editorWs.onopen = res));

    let editorReceivedSnapshot = false;
    let editorReceivedConnectedStatus = false;

    editorWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'status' && msg.connected === true) {
        editorReceivedConnectedStatus = true;
      }
      if (msg.type === 'snapshot') {
        editorReceivedSnapshot = true;
      }
    });

    // Connect game WebSocket
    const gameWs = new WebSocket(`${srvInfo.wsUrl}?role=game`);
    await new Promise((res) => (gameWs.onopen = res));

    // Game sends snapshot
    const testSnapshot = {
      metadata: { version: 4.5, type: 'Object' },
      object: {
        uuid: 'test-scene-uuid',
        name: 'SceneRoot',
        children: [
          { uuid: 'kart-mesh-uuid', name: 'Kart_Player', type: 'Mesh' }
        ]
      }
    };

    gameWs.send(JSON.stringify({ version: 1, type: 'snapshot', scene: testSnapshot }));

    // Wait for editor to receive snapshot
    await new Promise((res) => setTimeout(res, 200));
    assert.strictEqual(editorReceivedSnapshot, true, 'Editor should receive game snapshot');
    assert.strictEqual(editorReceivedConnectedStatus, true, 'Editor should receive connected status');

    // Editor sends transform delta to game
    let gameReceivedXform = null;
    gameWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'xform') {
        gameReceivedXform = msg;
      }
    });

    editorWs.send(
      JSON.stringify({
        version: 1,
        type: 'xform',
        id: 'Kart_Player',
        position: [2.5, 0.45, 8.0],
        rotation: [0, 1.57, 0],
        scale: [1, 1, 1]
      })
    );

    await new Promise((res) => setTimeout(res, 200));
    assert.ok(gameReceivedXform, 'Game should receive transform delta from editor');
    assert.strictEqual(gameReceivedXform.id, 'Kart_Player');
    assert.deepStrictEqual(gameReceivedXform.position, [2.5, 0.45, 8.0]);

    // Cleanup WebSockets
    gameWs.close();
    editorWs.close();
  });

  await t.test('4. Express API Routes (/modeling/*)', async () => {
    const app = express();
    app.use(express.json());
    app.use(modelingRouter);

    const srv = http.createServer(app);
    await new Promise((res) => srv.listen(0, res));
    const port = srv.address().port;

    try {
      // Seed a known non-driven object so this test does not depend on prior subtests.
      await saveLayout(testDir, {
        version: 1,
        objects: { 'Crate_0': { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true } }
      });

      // GET /modeling/server/status
      const statusRes = await fetch(`http://localhost:${port}/modeling/server/status?projectPath=${encodeURIComponent(testDir)}`);
      assert.strictEqual(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.strictEqual(statusData.running, true);

      // GET /modeling/layout
      const layoutRes = await fetch(`http://localhost:${port}/modeling/layout?projectPath=${encodeURIComponent(testDir)}`);
      assert.strictEqual(layoutRes.status, 200);
      const layoutData = await layoutRes.json();
      assert.strictEqual(layoutData.success, true);
      assert.ok(layoutData.layout.objects['Crate_0']);

      // POST /modeling/layout — Crate_0 is non-driven, so its position round-trips.
      const postLayoutRes = await fetch(`http://localhost:${port}/modeling/layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: testDir,
          layout: { version: 1, objects: { 'Crate_0': { position: [9, 0, 9] } } }
        })
      });
      assert.strictEqual(postLayoutRes.status, 200);

      const checkSaved = await loadLayout(testDir);
      assert.deepStrictEqual(checkSaved.objects['Crate_0'].position, [9, 0, 9]);
    } finally {
      srv.close();
    }
  });
});
