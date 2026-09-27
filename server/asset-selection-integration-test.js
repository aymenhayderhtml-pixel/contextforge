/**
 * server/asset-selection-integration-test.js
 * Comprehensive tests for Phase 28:
 * - T129: Wire live preview click into UI to open asset swap panel directly
 * - T130: Godot asset node selection by name in sidebar/graph in 1-2 clicks with swap panel
 * - T131: Missing exposed scene detection banner & toast rather than silent no-op
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAssetNode, normalizeAssetPath, getAssetBasename } from '../public/js/shared/asset-resolver.js';

test('Phase 28 — T129: Asset Resolver Unit Tests', async (t) => {
  const sampleManifest = {
    engine: 'js',
    nodes: [
      {
        id: 'src/main.js',
        engine: 'js',
        type: 'module',
        contract: { exports: ['start'] },
        depends_on: ['assets/models/character.glb', 'assets/textures/ground.png']
      },
      {
        id: 'assets/models/character.glb',
        engine: 'js',
        type: 'asset',
        slot: {
          slot: 'character',
          format: 'glb',
          rigged: true,
          expected_animations: ['Idle', 'Run', 'Jump']
        },
        contract: {
          slot: {
            slot: 'character',
            format: 'glb',
            rigged: true,
            expected_animations: ['Idle', 'Run', 'Jump']
          }
        },
        depends_on: []
      },
      {
        id: 'res://assets/sprites/icon.png',
        engine: 'godot',
        type: 'asset',
        slot: {
          slot: 'icon',
          format: 'png',
          dimensions: '64x64'
        },
        contract: {
          slot: {
            slot: 'icon',
            format: 'png',
            dimensions: '64x64'
          }
        },
        depends_on: []
      }
    ]
  };

  await t.test('1. Exact match on asset node ID', () => {
    const match = resolveAssetNode(sampleManifest, 'assets/models/character.glb');
    assert(match, 'Expected match for exact asset node ID');
    assert.strictEqual(match.id, 'assets/models/character.glb');
    assert.strictEqual(match.type, 'asset');
  });

  await t.test('2. Normalized match with leading slash or relative dot-slash', () => {
    const matchSlash = resolveAssetNode(sampleManifest, '/assets/models/character.glb');
    assert(matchSlash, 'Expected match with leading slash');
    assert.strictEqual(matchSlash.id, 'assets/models/character.glb');

    const matchDotSlash = resolveAssetNode(sampleManifest, './assets/models/character.glb');
    assert(matchDotSlash, 'Expected match with leading ./');
    assert.strictEqual(matchDotSlash.id, 'assets/models/character.glb');
  });

  await t.test('3. Windows backslash normalization', () => {
    const matchWin = resolveAssetNode(sampleManifest, 'assets\\models\\character.glb');
    assert(matchWin, 'Expected match for Windows backslashes');
    assert.strictEqual(matchWin.id, 'assets/models/character.glb');
  });

  await t.test('4. Godot res:// prefix matching in both directions (T130)', () => {
    // Exact res:// path
    const matchRes = resolveAssetNode(sampleManifest, 'res://assets/sprites/icon.png');
    assert(matchRes, 'Expected match with res://');
    assert.strictEqual(matchRes.id, 'res://assets/sprites/icon.png');

    // Matching disk relative path to Godot res:// node
    const matchDisk = resolveAssetNode(sampleManifest, 'assets/sprites/icon.png');
    assert(matchDisk, 'Expected relative disk path to match res:// node');
    assert.strictEqual(matchDisk.id, 'res://assets/sprites/icon.png');
  });

  await t.test('5. Basename fallback match prioritizing type=asset', () => {
    const matchBase = resolveAssetNode(sampleManifest, 'character.glb');
    assert(matchBase, 'Expected basename match');
    assert.strictEqual(matchBase.id, 'assets/models/character.glb');
  });

  await t.test('6. Unmatched asset returns null cleanly', () => {
    const noMatch = resolveAssetNode(sampleManifest, 'assets/models/nonexistent.glb');
    assert.strictEqual(noMatch, null);
  });
});

test('Phase 28 — T129 / T130 / T131: Frontend Wiring & UI Integration Tests', async (t) => {
  const indexPath = join(process.cwd(), 'public', 'index.html');
  const indexHtml = readFileSync(indexPath, 'utf-8');

  const appJsPath = join(process.cwd(), 'public', 'js', 'app.js');
  const appJs = readFileSync(appJsPath, 'utf-8');

  const detailPanelPath = join(process.cwd(), 'public', 'js', 'panel', 'detail-panel.js');
  const detailPanelJs = readFileSync(detailPanelPath, 'utf-8');

  const treePath = join(process.cwd(), 'public', 'js', 'sidebar', 'tree.js');
  const treeJs = readFileSync(treePath, 'utf-8');

  await t.test('T131: Missing scene notice banner exists in public/index.html', () => {
    assert(indexHtml.includes('id="preview-scene-notice"'), 'Missing preview-scene-notice element in index.html');
    assert(indexHtml.includes('id="btn-dismiss-scene-notice"'), 'Missing btn-dismiss-scene-notice in index.html');
    assert(indexHtml.includes('window.__CONTEXTFORGE_GAME__'), 'Notice text should reference window.__CONTEXTFORGE_GAME__');
  });

  await t.test('T129: app.js listens for CF_ASSET_SELECTED and triggers selectNode directly', () => {
    assert(appJs.includes("event.data.type === 'CF_ASSET_SELECTED'"), 'Missing CF_ASSET_SELECTED handler in app.js');
    assert(appJs.includes('resolveAssetNode(state.manifest, assetId)'), 'Missing resolveAssetNode call in app.js');
    assert(appJs.includes('selectNode(matchedNode.id)'), 'Missing selectNode call when asset resolved');
  });

  await t.test('T131: app.js listens for CF_PREVIEW_CLICK_MISSING_SCENE and shows notice & toast', () => {
    assert(appJs.includes("event.data.type === 'CF_PREVIEW_CLICK_MISSING_SCENE'"), 'Missing CF_PREVIEW_CLICK_MISSING_SCENE handler');
    assert(appJs.includes("preview-scene-notice"), 'Handler should reference preview-scene-notice');
    assert(appJs.includes("btn-dismiss-scene-notice"), 'Handler should dismiss notice on button click');
  });

  await t.test('T130: sidebar tree.js routes asset files directly to selectNode swap panel in 1 click', () => {
    assert(treeJs.includes('resolveAssetNode'), 'tree.js must import/use resolveAssetNode');
    assert(treeJs.includes("manifestNode.type === 'asset'"), 'tree.js must check if clicked item is an asset node');
    assert(treeJs.includes('selectNode(manifestNode.id)'), 'tree.js must call selectNode for asset nodes');
  });

  await t.test('T130: detail-panel.js renders Godot open button and syncs sidebar tree selection', () => {
    assert(detailPanelJs.includes('btn-panel-open-godot'), 'detail-panel.js must provide Open in Godot button for Godot assets');
    assert(detailPanelJs.includes('.tree-item'), 'detail-panel.js selectNode must sync sidebar tree-item selection');
  });
});
