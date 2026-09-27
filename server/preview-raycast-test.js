/**
 * server/preview-raycast-test.js
 *
 * Automated tests for Phase 28 (T128):
 * - Live preview click/raycast listener
 * - Raycast against exposed Three.js scene
 * - Walk up parent chain to resolve tagged root Object3D (userData.cfAssetId)
 * - Message back to ContextForge (CF_ASSET_SELECTED)
 * - Edge case handling: untagged object, missed click, missing exposed scene (T131)
 * - Camera drag/orbit gesture disambiguation
 *
 * Run: node --test server/preview-raycast-test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const bridgeSource = readFileSync(join(__dirname, '..', 'public', 'contextforge-bridge.js'), 'utf-8');

function setupTestEnvironment() {
  const messagesSent = [];
  const logsSent = [];
  const listeners = {};

  const parentWindow = {
    postMessage(data) {
      messagesSent.push(data);
    }
  };

  const fakeDocument = {
    currentScript: {
      getAttribute(attr) {
        if (attr === 'data-project') return '/home/user/games/my-threejs-game';
        if (attr === 'data-server') return 'http://localhost:3000';
        return null;
      }
    },
    querySelector(selector) {
      if (selector === 'canvas') {
        return {
          getBoundingClientRect() {
            return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
          }
        };
      }
      return null;
    }
  };

  const fakeWindow = {
    parent: parentWindow,
    opener: null,
    location: { origin: 'http://localhost:5173' },
    innerWidth: 800,
    innerHeight: 600,
    addEventListener(event, handler, useCapture) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    dispatchEvent(event) {
      if (listeners[event.type]) {
        for (const handler of listeners[event.type]) {
          handler(event);
        }
      }
    }
  };

  fakeWindow.window = fakeWindow;

  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {}
    },
    setTimeout,
    clearTimeout,
    Date,
    Math,
    String,
    JSON,
    Map,
    fetch: async (url, opts) => {
      if (url.includes('/client-log')) {
        try {
          logsSent.push(JSON.parse(opts.body));
        } catch (_) {}
      }
      return { ok: true };
    }
  };

  vm.runInNewContext(bridgeSource, sandbox);

  return {
    window: sandbox.window,
    bridge: sandbox.window.__CONTEXTFORGE_BRIDGE__,
    messagesSent,
    logsSent,
    dispatchEvent: fakeWindow.dispatchEvent
  };
}

test('Phase 28 — T128: Preview Click / Raycast Diagnostics Bridge Tests', async (t) => {
  await t.test('1. Bridge exposes raycastAndSelect and handleCanvasClick helpers', () => {
    const env = setupTestEnvironment();
    assert.ok(env.bridge, 'Bridge helper must be exposed on window.__CONTEXTFORGE_BRIDGE__');
    assert.strictEqual(typeof env.bridge.raycastAndSelect, 'function');
    assert.strictEqual(typeof env.bridge.handleCanvasClick, 'function');
  });

  await t.test('2. Missing exposed scene detects and dispatches CF_PREVIEW_CLICK_MISSING_SCENE (T131)', () => {
    const env = setupTestEnvironment();
    // Do not set window.__CONTEXTFORGE_GAME__
    const result = env.bridge.raycastAndSelect({ x: 0, y: 0 });

    assert.strictEqual(result, null);
    const missingMsg = env.messagesSent.find(m => m.type === 'CF_PREVIEW_CLICK_MISSING_SCENE');
    assert.ok(missingMsg, 'Must dispatch CF_PREVIEW_CLICK_MISSING_SCENE when no scene exposed');
    assert.strictEqual(missingMsg.projectPath, '/home/user/games/my-threejs-game');
  });

  await t.test('3. Raycast hitting directly tagged Object3D resolves asset id and sends CF_ASSET_SELECTED', () => {
    const env = setupTestEnvironment();

    const mockCube = {
      name: 'StarterCube',
      userData: { cfAssetId: 'assets/cube.glb', assetId: 'assets/cube.glb' }
    };

    env.window.__CONTEXTFORGE_GAME__ = {
      scene: {
        children: [mockCube]
      },
      camera: { isCamera: true },
      renderer: {},
      raycast(x, y) {
        return [{ object: mockCube, point: { x: 0, y: 0, z: -3 } }];
      }
    };

    const result = env.bridge.raycastAndSelect({ x: 0, y: 0 });
    assert.ok(result, 'Expected raycast result');
    assert.strictEqual(result.type, 'CF_ASSET_SELECTED');
    assert.strictEqual(result.assetId, 'assets/cube.glb');
    assert.strictEqual(result.hitPoint.x, 0);
    assert.strictEqual(result.hitPoint.y, 0);
    assert.strictEqual(result.hitPoint.z, -3);

    const sent = env.messagesSent.find(m => m.type === 'CF_ASSET_SELECTED');
    assert.ok(sent, 'Must postMessage CF_ASSET_SELECTED to parent');
    assert.strictEqual(sent.assetId, 'assets/cube.glb');
  });

  await t.test('4. Raycast hitting child mesh walks up parent chain to resolve tagged root asset id', () => {
    const env = setupTestEnvironment();

    // Group tagged with manifest asset ID
    const mockCharacterRoot = {
      name: 'CharacterModel',
      userData: { cfAssetId: 'assets/models/character.glb' },
      parent: null
    };

    // Deeply nested arm mesh without its own asset tag
    const mockRightArm = {
      name: 'RightArm_Mesh',
      userData: { materialIndex: 1 },
      parent: mockCharacterRoot
    };

    env.window.__CONTEXTFORGE_GAME__ = {
      scene: {
        children: [mockCharacterRoot]
      },
      camera: { isCamera: true },
      renderer: {},
      raycast(x, y) {
        // Raycast intersects the child mesh
        return [{ object: mockRightArm, point: { x: 0.5, y: 1.2, z: -1.0 } }];
      }
    };

    const result = env.bridge.raycastAndSelect({ x: 0.2, y: 0.3 });
    assert.ok(result);
    assert.strictEqual(result.type, 'CF_ASSET_SELECTED');
    assert.strictEqual(result.assetId, 'assets/models/character.glb');
    assert.strictEqual(result.objectName, 'CharacterModel');

    const sent = env.messagesSent.find(m => m.type === 'CF_ASSET_SELECTED');
    assert.ok(sent);
    assert.strictEqual(sent.assetId, 'assets/models/character.glb');
  });

  await t.test('5. Raycast hitting untagged object dispatches CF_ASSET_UNTAGGED', () => {
    const env = setupTestEnvironment();

    const untaggedMesh = {
      name: 'ProceduralFloor',
      userData: {},
      parent: null
    };

    env.window.__CONTEXTFORGE_GAME__ = {
      scene: { children: [untaggedMesh] },
      camera: {},
      raycast() {
        return [{ object: untaggedMesh, point: { x: 0, y: -1, z: 0 } }];
      }
    };

    const result = env.bridge.raycastAndSelect({ x: 0, y: -0.5 });
    assert.strictEqual(result, null);

    const untaggedMsg = env.messagesSent.find(m => m.type === 'CF_ASSET_UNTAGGED');
    assert.ok(untaggedMsg, 'Must dispatch CF_ASSET_UNTAGGED when hit object has no asset tag');
    assert.strictEqual(untaggedMsg.objectName, 'ProceduralFloor');
  });

  await t.test('6. Raycast missing all objects dispatches CF_PREVIEW_CLICK_MISSED', () => {
    const env = setupTestEnvironment();

    env.window.__CONTEXTFORGE_GAME__ = {
      scene: { children: [] },
      camera: {},
      raycast() {
        return []; // zero hits
      }
    };

    const result = env.bridge.raycastAndSelect({ x: 0.9, y: 0.9 });
    assert.strictEqual(result, null);

    const missedMsg = env.messagesSent.find(m => m.type === 'CF_PREVIEW_CLICK_MISSED');
    assert.ok(missedMsg, 'Must dispatch CF_PREVIEW_CLICK_MISSED when clicking empty space');
  });

  await t.test('7. Drag gesture (pointerdown moved > 8px) does NOT trigger click selection', () => {
    const env = setupTestEnvironment();

    let raycastCount = 0;
    const mockMesh = {
      name: 'Cube',
      userData: { cfAssetId: 'assets/cube.glb' }
    };

    env.window.__CONTEXTFORGE_GAME__ = {
      scene: { children: [mockMesh] },
      camera: {},
      raycast() {
        raycastCount++;
        return [{ object: mockMesh }];
      }
    };

    // Simulate drag gesture: pointerdown at (100, 100), mouse moves to (300, 200) on click
    env.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100 });
    env.dispatchEvent({ type: 'click', clientX: 300, clientY: 200 });

    assert.strictEqual(raycastCount, 0, 'Drag gesture should be ignored for click-to-select');

    // Simulate direct click: pointerdown at (100, 100), click at (102, 101) (delta < 8px)
    env.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100 });
    env.dispatchEvent({ type: 'click', clientX: 102, clientY: 101 });

    assert.strictEqual(raycastCount, 1, 'Small movement click must trigger raycasting');
  });
});
