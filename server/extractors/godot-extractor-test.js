/**
 * Test the Godot extractor against test-fixtures/godot-sample.
 * Validates output against the manifest schema.
 *
 * Run: node server/extractors/godot-extractor-test.js
 */

import { extract } from './godot-extractor.js';
import { validateManifest } from '../schema/validate.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');
const fixturePath = join(projectRoot, 'test-fixtures', 'godot-sample');

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

console.log('Godot extractor tests:\n');

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
    depended_on_by: [] // Server computes this, not the extractor
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

test('finds all 3 scenes', () => {
  const scenes = result.nodes.filter(n => n.type === 'scene');
  assert(scenes.length === 3, `Expected 3 scenes, got ${scenes.length}: ${scenes.map(s=>s.id).join(', ')}`);
});

test('finds all 3 scripts', () => {
  const scripts = result.nodes.filter(n => n.type === 'script');
  assert(scripts.length === 3, `Expected 3 scripts, got ${scripts.length}: ${scripts.map(s=>s.id).join(', ')}`);
});

test('total node count is 6', () => {
  assert(result.nodes.length === 6, `Expected 6 nodes, got ${result.nodes.length}`);
});

test('Player.gd has correct signals', () => {
  const player = result.nodes.find(n => n.id === 'scripts/Player.gd');
  assert(player, 'Player.gd node not found');
  assert(player.contract.signals.includes('died()'), `Missing signal 'died()', got: ${player.contract.signals}`);
  assert(player.contract.signals.includes('health_changed(new_value: int)'), `Missing signal 'health_changed(new_value: int)', got: ${player.contract.signals}`);
});

test('Player.gd has correct @export vars in contract', () => {
  const player = result.nodes.find(n => n.id === 'scripts/Player.gd');
  assert(player, 'Player.gd node not found');
  assert(player.contract.exports.some(e => e.includes('speed')), `Missing export 'speed', got: ${player.contract.exports}`);
  assert(player.contract.exports.some(e => e.includes('jump_force')), `Missing export 'jump_force', got: ${player.contract.exports}`);
});

test('Player.gd has public funcs but no private (_-prefixed) funcs', () => {
  const player = result.nodes.find(n => n.id === 'scripts/Player.gd');
  assert(player, 'Player.gd node not found');
  assert(player.contract.exports.some(e => e.includes('take_damage')), `Missing public func 'take_damage'`);
  assert(player.contract.exports.some(e => e.includes('get_health')), `Missing public func 'get_health'`);
  assert(!player.contract.exports.some(e => e.includes('_process')), `Should not include '_process'`);
  assert(!player.contract.exports.some(e => e.includes('_physics_process')), `Should not include '_physics_process'`);
});

test('Player.tscn depends_on includes scripts/Player.gd', () => {
  const scene = result.nodes.find(n => n.id === 'scenes/Player.tscn');
  assert(scene, 'Player.tscn node not found');
  assert(scene.depends_on.includes('scripts/Player.gd'), `Missing dependency on Player.gd, got: ${scene.depends_on}`);
});

test('Level1.tscn depends_on includes both Player and Enemy scenes', () => {
  const level = result.nodes.find(n => n.id === 'scenes/Level1.tscn');
  assert(level, 'Level1.tscn node not found');
  assert(level.depends_on.includes('scenes/Player.tscn'), `Missing dep on Player.tscn`);
  assert(level.depends_on.includes('scenes/Enemy.tscn'), `Missing dep on Enemy.tscn`);
});

test('has ext_resource edges from scenes to scripts', () => {
  const playerEdge = result.edges.find(e => e.from === 'scenes/Player.tscn' && e.to === 'scripts/Player.gd');
  assert(playerEdge, 'Missing ext_resource edge Player.tscn → Player.gd');
  assert(playerEdge.kind === 'ext_resource', `Expected ext_resource, got ${playerEdge.kind}`);
});

test('has signal_connection edges in Level1', () => {
  const signalEdges = result.edges.filter(e => e.kind === 'signal_connection');
  assert(signalEdges.length > 0, 'No signal_connection edges found');
  const toPlayer = signalEdges.find(e => e.to === 'scenes/Player.tscn');
  assert(toPlayer, 'Missing signal_connection edge to Player.tscn');
});

test('Player.tscn scene contract inherits from Player.gd script', () => {
  const scene = result.nodes.find(n => n.id === 'scenes/Player.tscn');
  assert(scene, 'Player.tscn node not found');
  assert(scene.contract.signals.length > 0, 'Scene should inherit signals from script');
  assert(scene.contract.exports.length > 0, 'Scene should inherit exports from script');
});

test('all nodes have engine=godot', () => {
  for (const node of result.nodes) {
    assert(node.engine === 'godot', `Node ${node.id} has engine=${node.engine}`);
  }
});

test('Player.gd requires GameManager autoload', () => {
  const player = result.nodes.find(n => n.id === 'scripts/Player.gd');
  assert(player, 'Player.gd node not found');
  assert(player.contract.requires.includes('GameManager'),
    `Expected requires to include GameManager, got: ${player.contract.requires}`);
});

test('Player.gd has requires edge to scripts/GameManager.gd (T029)', () => {
  const reqEdge = result.edges.find(e => e.from === 'scripts/Player.gd' && e.to === 'scripts/GameManager.gd');
  assert(reqEdge, 'Missing requires edge from Player.gd to GameManager.gd');
  assert(reqEdge.kind === 'requires', `Expected kind=requires, got ${reqEdge.kind}`);
});

test('Player.gd depends_on includes scripts/GameManager.gd', () => {
  const player = result.nodes.find(n => n.id === 'scripts/Player.gd');
  assert(player, 'Player.gd node not found');
  assert(player.depends_on.includes('scripts/GameManager.gd'),
    `Expected depends_on to include scripts/GameManager.gd, got: ${player.depends_on}`);
});

test('determinism: two runs produce identical output', async () => {
  const run2 = await extract(fixturePath);
  assert(JSON.stringify(result) === JSON.stringify(run2), 'Extractor output is not deterministic');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
