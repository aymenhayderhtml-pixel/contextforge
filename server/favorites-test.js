/**
 * server/favorites-test.js
 * Comprehensive tests for Phase 28:
 * - T124: Favorites library persistent cross-project storage (outside project folder)
 * - T125: Browse... file-picker button alongside drag-and-drop swap
 * - T126: Favorites picker UI & slot contract compatibility filtering
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

import {
  getFavoritesDirectory,
  getFavoritesFilePath,
  loadFavorites,
  saveFavorites,
  addFavorite,
  removeFavorite,
  updateFavorite,
  getFavorite
} from './favorites-manager.js';

import { checkFavoriteCompatibility } from '../public/js/panel/favorites-modal.js';
import { serverState } from './state.js';
import express from 'express';
import favoritesRouter from './routes/favorites.js';

// Setup isolated favorites test directory
const testFavDir = join(tmpdir(), `cf-fav-test-${Date.now()}`);
process.env.CF_FAVORITES_DIR = testFavDir;

function makeRequest(method, path, body = null, port = 3000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          resolve({ status: res.statusCode, data: parsed });
        } catch (_) {
          resolve({ status: res.statusCode, raw: responseBody });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('Phase 28 — T124: Cross-Project Favorites Manager Unit Tests', async (t) => {
  t.after(() => {
    try {
      if (existsSync(testFavDir)) {
        rmSync(testFavDir, { recursive: true, force: true });
      }
    } catch (_) {}
  });

  await t.test('1. Favorites directory is outside project folder and creates on demand', () => {
    const dir = getFavoritesDirectory();
    assert.strictEqual(dir, testFavDir);
    assert(getFavoritesFilePath().endsWith('favorites.json'));
  });

  await t.test('2. addFavorite persists asset with tags, metadata, and format', () => {
    const item = addFavorite({
      name: 'Knight_Hero.glb',
      format: 'glb',
      tags: ['hero', 'character', 'rigged'],
      thumbnail: 'data:image/svg+xml;base64,mockThumbnail',
      fileContent: Buffer.from('glTFmock-binary-data').toString('base64'),
      assetInfo: {
        format: 'glb',
        rigged: true,
        animations: ['Idle', 'Walk', 'Attack', 'Death']
      },
      sourceProject: '/test/project-a'
    });

    assert(item.id.startsWith('fav-'));
    assert.strictEqual(item.name, 'Knight_Hero.glb');
    assert.strictEqual(item.format, 'glb');
    assert.deepStrictEqual(item.tags, ['hero', 'character', 'rigged']);
    assert.strictEqual(item.assetInfo.rigged, true);
    assert.strictEqual(item.starred, true);

    const loaded = loadFavorites();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, item.id);
  });

  await t.test('3. updateFavorite modifies tags and metadata', () => {
    const [first] = loadFavorites();
    const updated = updateFavorite(first.id, { tags: ['hero', 'warrior', 'epic'] });
    assert(updated);
    assert.deepStrictEqual(updated.tags, ['hero', 'warrior', 'epic']);

    const fetched = getFavorite(first.id);
    assert.deepStrictEqual(fetched.tags, ['hero', 'warrior', 'epic']);
  });

  await t.test('4. removeFavorite deletes asset from library', () => {
    const [first] = loadFavorites();
    const removed = removeFavorite(first.id);
    assert.strictEqual(removed, true);
    assert.strictEqual(loadFavorites().length, 0);
  });
});

test('Phase 28 — T126: Slot Contract Compatibility Filtering Unit Tests', async (t) => {
  const targetSlot = {
    slot: 'character',
    format: 'glb',
    rigged: true,
    expected_animations: ['Idle', 'Walk', 'Attack']
  };

  const compatibleFav = {
    name: 'Paladin.glb',
    format: 'glb',
    assetInfo: {
      format: 'glb',
      rigged: true,
      animations: ['Idle', 'Walk', 'Attack', 'Jump', 'Cheer']
    }
  };

  const wrongFormatFav = {
    name: 'PlayerIcon.png',
    format: 'png',
    assetInfo: {
      format: 'png',
      rigged: false,
      animations: []
    }
  };

  const missingAnimFav = {
    name: 'Zombie.glb',
    format: 'glb',
    assetInfo: {
      format: 'glb',
      rigged: true,
      animations: ['Idle', 'Walk'] // missing 'Attack'
    }
  };

  const unriggedFav = {
    name: 'Statue.glb',
    format: 'glb',
    assetInfo: {
      format: 'glb',
      rigged: false,
      animations: ['Idle', 'Walk', 'Attack']
    }
  };

  await t.test('1. Compatible favorite passes all contract checks', () => {
    const result = checkFavoriteCompatibility(compatibleFav, targetSlot);
    assert.strictEqual(result.compatible, true);
    assert.strictEqual(result.reasons.length, 0);
  });

  await t.test('2. Format mismatch is detected and rejected', () => {
    const result = checkFavoriteCompatibility(wrongFormatFav, targetSlot);
    assert.strictEqual(result.compatible, false);
    assert(result.reasons.some(r => r.includes('Format')));
  });

  await t.test('3. Missing required animation is detected and rejected', () => {
    const result = checkFavoriteCompatibility(missingAnimFav, targetSlot);
    assert.strictEqual(result.compatible, false);
    assert(result.reasons.some(r => r.includes('Missing animation')));
  });

  await t.test('4. Rigging mismatch is detected and rejected', () => {
    const result = checkFavoriteCompatibility(unriggedFav, targetSlot);
    assert.strictEqual(result.compatible, false);
    assert(result.reasons.some(r => r.includes('Rigging')));
  });
});

test('Phase 28 — T124, T125, T126: HTTP Routes and Frontend Integration Tests', async (t) => {
  // Test project setup
  const tmpProject = join(tmpdir(), `cf-swap-test-${Date.now()}`);
  mkdirSync(join(tmpProject, 'assets', 'models'), { recursive: true });
  writeFileSync(join(tmpProject, 'assets', 'models', 'hero.glb'), 'placeholder-hero-glb');

  serverState.currentProjectPath = tmpProject;
  serverState.currentManifest = {
    engine: 'js',
    nodes: [
      {
        id: 'assets/models/hero.glb',
        engine: 'js',
        type: 'asset',
        slot: {
          slot: 'hero',
          format: 'glb',
          rigged: true,
          expected_animations: ['Idle', 'Run']
        }
      }
    ]
  };

  const testApp = express();
  testApp.use(express.json({ limit: '50mb' }));
  testApp.use(favoritesRouter);

  let testServer;
  let testPort;

  await new Promise((resolve) => {
    testServer = testApp.listen(0, '127.0.0.1', () => {
      testPort = testServer.address().port;
      resolve();
    });
  });

  t.after(() => {
    try {
      if (testServer) testServer.close();
      if (existsSync(tmpProject)) rmSync(tmpProject, { recursive: true, force: true });
    } catch (_) {}
  });

  let createdFavId = null;

  await t.test('T124: POST /favorites adds asset to cross-project library', async () => {
    const res = await makeRequest('POST', '/favorites', {
      name: 'CustomHero.glb',
      format: 'glb',
      tags: ['hero', 'swappable'],
      fileContent: Buffer.from('glTFvalid-hero-binary-data').toString('base64'),
      assetInfo: {
        format: 'glb',
        rigged: true,
        animations: ['Idle', 'Run', 'Special']
      }
    }, testPort);

    assert.strictEqual(res.status, 201);
    assert(res.data.success);
    assert.strictEqual(res.data.favorite.name, 'CustomHero.glb');
    createdFavId = res.data.favorite.id;
  });

  await t.test('T124: GET /favorites lists stored favorites with tag filtering', async () => {
    const res = await makeRequest('GET', '/favorites?tag=hero', null, testPort);
    assert.strictEqual(res.status, 200);
    assert(res.data.success);
    assert(res.data.favorites.length >= 1);
    assert(res.data.favorites.some(f => f.id === createdFavId));
  });

  await t.test('T126: POST /favorites/:id/swap-into swaps compatible favorite into target project slot', async () => {
    const res = await makeRequest('POST', `/favorites/${createdFavId}/swap-into`, {
      nodeId: 'assets/models/hero.glb',
      projectPath: tmpProject
    }, testPort);

    assert.strictEqual(res.status, 200);
    assert(res.data.success);
    assert.strictEqual(res.data.nodeId, 'assets/models/hero.glb');
    assert.strictEqual(res.data.validation.valid, true);

    // Verify file content on disk was actually updated
    const written = readFileSync(join(tmpProject, 'assets', 'models', 'hero.glb'), 'utf-8');
    assert.strictEqual(written, 'glTFvalid-hero-binary-data');
  });

  await t.test('T125: detail-panel.js includes Browse... button and unified handleAssetSwapFile', () => {
    const panelJs = readFileSync(join(process.cwd(), 'public', 'js', 'panel', 'detail-panel.js'), 'utf-8');
    assert(panelJs.includes('id="btn-browse-asset-file"'), 'Missing btn-browse-asset-file button');
    assert(panelJs.includes('id="asset-file-picker-input"'), 'Missing asset-file-picker-input element');
    assert(panelJs.includes('handleAssetSwapFile'), 'Missing unified handleAssetSwapFile function');
    assert(panelJs.includes('/validate-asset'), 'handleAssetSwapFile must call /validate-asset');
  });

  await t.test('T126: detail-panel.js and favorites-modal.js provide contract-filtered favorites picker', () => {
    const panelJs = readFileSync(join(process.cwd(), 'public', 'js', 'panel', 'detail-panel.js'), 'utf-8');
    const modalJs = readFileSync(join(process.cwd(), 'public', 'js', 'panel', 'favorites-modal.js'), 'utf-8');

    assert(panelJs.includes('id="btn-open-favorites-picker"'), 'Missing btn-open-favorites-picker button');
    assert(panelJs.includes('openFavoritesPickerModal'), 'detail-panel.js must call openFavoritesPickerModal');
    assert(modalJs.includes('checkFavoriteCompatibility'), 'favorites-modal.js must export checkFavoriteCompatibility');
    assert(modalJs.includes('chk-filter-compatible'), 'favorites-modal.js must include slot compatibility filter toggle');
    assert(modalJs.includes('/swap-into'), 'favorites-modal.js must wire swap-into action');
  });
});
