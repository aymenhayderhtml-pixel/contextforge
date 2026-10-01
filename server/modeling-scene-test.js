import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';
import filesRouter from './routes/files.js';

test('Modeling Viewport & Empty Scene Verification', async (t) => {
  const root = process.cwd();

  await t.test('index.html contains Modeling button and workspace containers', () => {
    const html = readFileSync(join(root, 'public/index.html'), 'utf-8');
    assert.ok(html.includes('id="btn-view-model"'), 'Should have btn-view-model button');
    assert.ok(html.includes('id="modeling-container"'), 'Should have modeling-container');
    assert.ok(html.includes('id="modeling-canvas"'), 'Should have modeling-canvas');
    assert.ok(html.includes('id="modeling-empty-notice"'), 'Should have empty scene notice');
    assert.ok(html.includes('id="modeling-outliner-list"'), 'Should have scene outliner list');
    assert.ok(html.includes('id="modeling-inspector-form"'), 'Should have inspector form');
    assert.ok(html.includes('data-add-primitive="cube"'), 'Should have add cube action');
    assert.ok(html.includes('data-add-primitive="sphere"'), 'Should have add sphere action');
  });

  await t.test('Three.js vendor bundle and styling exist', () => {
    const bundle = join(root, 'public/vendor/three.min.js');
    assert.ok(existsSync(bundle), 'three.min.js must exist');
    // Three.js and its addons ship as one bundled r160 file with the addons on window.
    const src = readFileSync(bundle, 'utf-8');
    for (const sym of ['OrbitControls', 'TransformControls', 'GLTFLoader']) {
      assert.ok(src.includes(sym), `bundle must provide ${sym}`);
    }
    assert.ok(existsSync(join(root, 'public/css/modeling.css')), 'modeling.css must exist');
    assert.ok(existsSync(join(root, 'public/js/modeling/modeling-view.js')), 'modeling-view.js must exist');
  });

  await t.test('GET /project-raw-file endpoint streams target project assets', async () => {
    const app = express();
    app.use(filesRouter);

    const server = http.createServer(app);
    await new Promise(res => server.listen(0, res));
    const port = server.address().port;

    try {
      const fixtureDir = join(root, 'test-fixtures', 'js-sample');
      const res = await fetch(`http://localhost:${port}/project-raw-file?projectPath=${encodeURIComponent(fixtureDir)}&filePath=models/character.slot.json`);
      assert.strictEqual(res.status, 200, 'Should return HTTP 200 for project-raw-file');
      const buf = await res.arrayBuffer();
      assert.ok(buf.byteLength > 0, 'Should stream binary asset content');
    } finally {
      server.close();
    }
  });

  await t.test('Swap 3D model UI elements and exports are wired', () => {
    const html = readFileSync(join(root, 'public/index.html'), 'utf-8');
    assert.ok(html.includes('id="model-swap-file-input"'), 'Should have model-swap-file-input');
    assert.ok(html.includes('accept=".glb,.gltf,model/gltf-binary,model/gltf+json"'), 'Should accept .glb and .gltf with MIME types');

    const css = readFileSync(join(root, 'public/css/modeling.css'), 'utf-8');
    assert.ok(css.includes('#prop-btn-swap'), 'Should have #prop-btn-swap CSS rules');

    const js = readFileSync(join(root, 'public/js/modeling/modeling-view.js'), 'utf-8');
    assert.ok(js.includes('prop-btn-swap'), 'Should have prop-btn-swap button logic');
    assert.ok(js.includes('swapSelectedModel'), 'Should export or define swapSelectedModel');
    assert.ok(js.includes('loadModelFromFile'), 'Should export or define loadModelFromFile');
    assert.ok(js.includes('disposeHierarchy'), 'Should export or define disposeHierarchy');
    assert.ok(js.includes('centerAndScaleModel'), 'Should center and scale new models');

    // Phase 2: the swap is non-destructive. The original is never deleted; its
    // visual children are only hidden and the new mesh is added as CF_Model.
    assert.ok(js.includes('CF_Model'), 'Swapped model must be added as CF_Model');
    assert.ok(js.includes('hideOriginalVisuals'), 'Must hide the original visual children');
    assert.ok(js.includes('restoreOriginalVisibility'), 'Reset must restore original visibility');
    assert.ok(js.includes("'Instanced objects cannot be swapped'"),
      'Instanced objects must report they cannot be swapped');
    assert.ok(js.includes('updateModelParam'), 'Should expose model param updates (scale/fit/offset/rotation)');
    assert.ok(js.includes('resetSelectedModel'), 'Should export or define resetSelectedModel');
    assert.ok(js.includes("type: 'set_model'"), 'Should broadcast set_model over the WebSocket');

    const rt = readFileSync(join(root, 'server/runtime.js'), 'utf-8');
    assert.ok(rt.includes('CF_Model'), 'Runtime must attach swapped models as CF_Model');
    assert.ok(rt.includes("type === 'set_model'"), 'Runtime must handle set_model messages');
    assert.ok(rt.includes("type: 'model_error'"), 'Runtime must report model errors to the editor');
    assert.ok(rt.includes('SkeletonUtils'), 'Runtime must use SkeletonUtils for skinned models');
  });

  await t.test('TransformControls gizmo files, UI controls, and logic are wired', () => {
    assert.ok(existsSync(join(root, 'public/vendor/three.min.js')), 'bundled three.min.js must exist');

    const html = readFileSync(join(root, 'public/index.html'), 'utf-8');
    assert.ok(html.includes('/vendor/three.min.js'), 'index.html must load the bundled three.min.js');
    assert.ok(!html.includes('/vendor/TransformControls.js'), 'TransformControls must not be a separate script tag');
    assert.ok(html.includes('id="btn-gizmo-translate"'), 'index.html must have translate button');
    assert.ok(html.includes('id="btn-gizmo-rotate"'), 'index.html must have rotate button');
    assert.ok(html.includes('id="btn-gizmo-scale"'), 'index.html must have scale button');
    assert.ok(html.includes('id="btn-gizmo-space"'), 'index.html must have coordinate space button');

    const css = readFileSync(join(root, 'public/css/modeling.css'), 'utf-8');
    assert.ok(css.includes('modeling-mode-pill-group'), 'modeling.css must style gizmo mode pill group');
    assert.ok(css.includes('btn-gizmo-space'), 'modeling.css must style gizmo space toggle button');

    const js = readFileSync(join(root, 'public/js/modeling/modeling-view.js'), 'utf-8');
    assert.ok(js.includes('THREE.TransformControls'), 'modeling-view.js must instantiate THREE.TransformControls');
    assert.ok(js.includes('dragging-changed'), 'modeling-view.js must handle dragging-changed to toggle OrbitControls');
    assert.ok(js.includes('syncInspectorFromTransform'), 'modeling-view.js must define syncInspectorFromTransform');
    assert.ok(js.includes('setGizmoMode'), 'modeling-view.js must define setGizmoMode');
    assert.ok(js.includes('toggleGizmoSpace'), 'modeling-view.js must define toggleGizmoSpace');
    assert.ok(js.includes('setupKeyboardShortcuts'), 'modeling-view.js must define setupKeyboardShortcuts');
    assert.ok(js.includes("'translate'"), 'modeling-view.js must support translate mode');
    assert.ok(js.includes("'rotate'"), 'modeling-view.js must support rotate mode');
    assert.ok(js.includes("'scale'"), 'modeling-view.js must support scale mode');
  });

  await t.test('Live game scene sync endpoints and modeling sync are wired', async () => {
    const devserverRouter = (await import('./routes/devserver.js')).default;
    const app = express();
    app.use(express.json());
    app.use(devserverRouter);

    const server = http.createServer(app);
    await new Promise(res => server.listen(0, res));
    const port = server.address().port;

    try {
      // 1. Post scene snapshot
      const sampleScene = {
        metadata: { version: 4.5, type: 'Object' },
        object: {
          uuid: 'scene-root-1',
          type: 'Scene',
          children: [
            { uuid: 'road-1', type: 'Mesh', name: 'Road Surface' },
            { uuid: 'car-1', type: 'Mesh', name: 'Player Car (Prototype)' }
          ]
        }
      };

      const postRes = await fetch(`http://localhost:${port}/game-scene-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: '/fake/game', sceneJson: sampleScene })
      });
      assert.strictEqual(postRes.status, 200, 'POST /game-scene-snapshot should succeed');

      // 2. Get scene snapshot
      const getRes = await fetch(`http://localhost:${port}/game-scene-snapshot?projectPath=/fake/game`);
      assert.strictEqual(getRes.status, 200, 'GET /game-scene-snapshot should succeed');
      const retrieved = await getRes.json();
      assert.ok(retrieved.sceneJson, 'Retrieved snapshot should include sceneJson');
      assert.strictEqual(retrieved.sceneJson.object.uuid, 'scene-root-1');

      // 3. Post transform update
      const updateRes = await fetch(`http://localhost:${port}/game-scene-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: '/fake/game',
          update: { uuid: 'car-1', position: { x: 0, y: 0.45, z: 10 } }
        })
      });
      assert.strictEqual(updateRes.status, 200, 'POST /game-scene-update should succeed');

      // 4. Retrieve transform updates
      const listRes = await fetch(`http://localhost:${port}/game-scene-updates?projectPath=/fake/game`);
      assert.strictEqual(listRes.status, 200, 'GET /game-scene-updates should succeed');
      const listData = await listRes.json();
      assert.strictEqual(listData.updates.length, 1);
      assert.strictEqual(listData.updates[0].uuid, 'car-1');
    } finally {
      server.close();
    }

    const html = readFileSync(join(root, 'public/index.html'), 'utf-8');
    assert.ok(html.includes('id="btn-model-sync-game"'), 'index.html must have btn-model-sync-game');

    const js = readFileSync(join(root, 'public/js/modeling/modeling-view.js'), 'utf-8');
    assert.ok(js.includes('loadSceneFromGame'), 'modeling-view.js must define loadSceneFromGame');
    assert.ok(js.includes('requestGameSceneSync'), 'modeling-view.js must define requestGameSceneSync');
    assert.ok(js.includes('broadcastTransformUpdate'), 'modeling-view.js must define broadcastTransformUpdate');

    const bridge = readFileSync(join(root, 'public/contextforge-bridge.js'), 'utf-8');
    assert.ok(bridge.includes('CF_SCENE_SNAPSHOT'), 'bridge must broadcast CF_SCENE_SNAPSHOT');
    assert.ok(bridge.includes('CF_UPDATE_TRANSFORM'), 'bridge must handle CF_UPDATE_TRANSFORM');

    assert.ok(html.includes('id="modeling-outliner-search"'), 'index.html must have outliner search input');
    assert.ok(js.includes('prop-btn-save-code'), 'modeling-view.js must have prop-btn-save-code button');
    assert.ok(js.includes('saveSelectedObjectToCode'), 'modeling-view.js must define saveSelectedObjectToCode');
    assert.ok(js.includes('getObjectPriority'), 'modeling-view.js must prioritize key interactive objects');
  });
});
