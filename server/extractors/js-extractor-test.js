/**
 * Test the JS extractor against test-fixtures/js-sample.
 * Validates output against the manifest schema.
 *
 * Run: node server/extractors/js-extractor-test.js
 */

import { extract } from './js-extractor.js';
import { validateManifest } from '../schema/validate.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');
const fixturePath = join(projectRoot, 'test-fixtures', 'js-sample');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

console.log('JS extractor tests:\n');

// Run the extractor
const result = await extract(fixturePath);

console.log('--- Raw extractor output ---');
console.log(JSON.stringify(result, null, 2));
console.log('---\n');

// Wrap in a full manifest for validation
const manifest = {
  project_root: fixturePath,
  generated_at: new Date().toISOString(),
  nodes: result.nodes.map(n => ({
    ...n,
    depended_on_by: [] // Server computes this
  })),
  edges: result.edges
};

test('extractor returns nodes array', () => {
  assert(Array.isArray(result.nodes), 'nodes should be an array');
});

test('extractor returns edges array', () => {
  assert(Array.isArray(result.edges), 'edges should be an array');
});

test('manifest validates against schema', () => {
  const v = validateManifest(manifest);
  if (!v.valid) {
    throw new Error(`Validation errors:\n  - ${v.errors.join('\n  - ')}`);
  }
});

test('finds all JS modules (at least 4)', () => {
  const modules = result.nodes.filter(n => n.type === 'module');
  assert(modules.length >= 4, `Expected at least 4 modules, got ${modules.length}: ${modules.map(m=>m.id).join(', ')}`);
});

test('all module nodes have engine=js', () => {
  for (const node of result.nodes.filter(n => n.type === 'module')) {
    assert(node.engine === 'js', `Node ${node.id} has engine=${node.engine}`);
  }
});

test('main.js depends on scene-manager.js, player.js, and asset-loader.js', () => {
  const main = result.nodes.find(n => n.id.includes('main.js'));
  assert(main, 'main.js node not found');
  assert(main.depends_on.some(d => d.includes('scene-manager')), `Missing dep on scene-manager`);
  assert(main.depends_on.some(d => d.includes('player')), `Missing dep on player`);
  assert(main.depends_on.some(d => d.includes('asset-loader')), `Missing dep on asset-loader`);
});

test('scene-manager.js depends on utils.js', () => {
  const sm = result.nodes.find(n => n.id.includes('scene-manager.js'));
  assert(sm, 'scene-manager.js node not found');
  assert(sm.depends_on.some(d => d.includes('utils')), `Missing dep on utils.js, got: ${sm.depends_on}`);
});

test('utils.js has no dependencies (leaf module)', () => {
  const utils = result.nodes.find(n => n.id.includes('utils.js'));
  assert(utils, 'utils.js node not found');
  // Only check import deps, not asset refs
  const importDeps = utils.depends_on.filter(d => !d.includes('.glb') && !d.includes('.png'));
  assert(importDeps.length === 0, `Expected no import deps, got: ${importDeps}`);
});

test('import edges exist', () => {
  const importEdges = result.edges.filter(e => e.kind === 'import');
  assert(importEdges.length >= 4, `Expected at least 4 import edges, got ${importEdges.length}`);
});

test('main.js contract has exports (startGame, GAME_VERSION)', () => {
  const main = result.nodes.find(n => n.id.includes('main.js'));
  assert(main, 'main.js not found');
  assert(main.contract.exports.length >= 2, `Expected at least 2 exports, got: ${main.contract.exports}`);
  assert(main.contract.exports.some(e => e.includes('startGame')), `Missing startGame export`);
  assert(main.contract.exports.some(e => e.includes('GAME_VERSION')), `Missing GAME_VERSION export`);
});

test('player.js contract has class and function exports', () => {
  const player = result.nodes.find(n => n.id.includes('player.js'));
  assert(player, 'player.js not found');
  assert(player.contract.exports.some(e => e.includes('Player')), `Missing Player class export`);
  assert(player.contract.exports.some(e => e.includes('createPlayer')), `Missing createPlayer export`);
  assert(player.contract.exports.some(e => e.includes('MAX_PLAYERS')), `Missing MAX_PLAYERS export`);
});

test('utils.js contract has default export', () => {
  const utils = result.nodes.find(n => n.id.includes('utils.js'));
  assert(utils, 'utils.js not found');
  assert(utils.contract.exports.some(e => e.includes('default')), `Missing default export, got: ${utils.contract.exports}`);
});

test('asset-loader.js contract has async function exports', () => {
  const loader = result.nodes.find(n => n.id.includes('asset-loader.js'));
  assert(loader, 'asset-loader.js not found');
  assert(loader.contract.exports.some(e => e.includes('loadModel')), `Missing loadModel, got: ${loader.contract.exports}`);
  assert(loader.contract.exports.some(e => e.includes('loadTexture')), `Missing loadTexture, got: ${loader.contract.exports}`);
});

test('all JS nodes have signals=[] (no signals for JS)', () => {
  for (const node of result.nodes) {
    assert(Array.isArray(node.contract.signals), `${node.id} signals should be array`);
    assert(node.contract.signals.length === 0, `${node.id} should have no signals, got: ${node.contract.signals}`);
  }
});

test('detects asset reference (models/character.glb)', () => {
  const assetEdges = result.edges.filter(e => e.kind === 'asset_ref');
  // main.js references 'models/character.glb'
  assert(assetEdges.length >= 1, `Expected at least 1 asset_ref edge, got ${assetEdges.length}`);
  assert(assetEdges.some(e => e.to.includes('character.glb')),
    `Expected asset_ref to character.glb, got: ${assetEdges.map(e => e.to)}`);
});

// ── Determinism test ──
console.log('\n  --- Determinism ---');
const result2 = await extract(fixturePath);
const s1 = JSON.stringify(result, null, 2);
const s2 = JSON.stringify(result2, null, 2);

test('determinism: two runs produce identical output', () => {
  assert(s1 === s2, 'Outputs differ between runs');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
