/**
 * godot-large-test.js — Verifies extraction of medium-scale fixture (T032).
 *
 * Run: node test-fixtures/godot-large-test.js
 */

import { extract } from '../server/extractors/godot-extractor.js';
import { validateManifest } from '../server/schema/validate.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = join(__dirname, 'godot-large-sample');

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

console.log('Medium-scale fixture tests (T032):\n');

const result = await extract(fixturePath);

// Wrap in full manifest
const manifest = {
  project_root: fixturePath,
  generated_at: new Date().toISOString(),
  nodes: result.nodes.map(n => ({
    ...n,
    depended_on_by: []
  })),
  edges: result.edges
};

test('fixture has 25-35 nodes (~30 nodes per spec)', () => {
  assert(result.nodes.length >= 25 && result.nodes.length <= 35,
    `Expected between 25 and 35 nodes, got ${result.nodes.length}`);
});

test('manifest validates against schema', () => {
  const v = validateManifest(manifest);
  if (!v.valid) {
    throw new Error(`Validation errors:\n  - ${v.errors.join('\n  - ')}`);
  }
});

test('has connected clusters (levels, entities, ui, core)', () => {
  const level1 = result.nodes.find(n => n.id === 'scenes/levels/Level1.tscn');
  assert(level1, 'Level1.tscn not found');
  assert(level1.depends_on.length >= 3, `Expected at least 3 dependencies, got ${level1.depends_on.length}`);

  const boss = result.nodes.find(n => n.id === 'scenes/entities/Boss.tscn');
  assert(boss, 'Boss.tscn not found');
  assert(boss.depends_on.includes('scenes/entities/Enemy.tscn'), 'Boss should depend on Enemy.tscn');
});

test('has requires edges from scripts to autoloads', () => {
  const player = result.nodes.find(n => n.id === 'scripts/entities/Player.gd');
  assert(player, 'Player.gd not found');
  assert(player.contract.requires.includes('GameManager'), 'Player should require GameManager');
  assert(player.contract.requires.includes('AudioManager'), 'Player should require AudioManager');

  const reqEdge = result.edges.find(e => e.from === 'scripts/entities/Player.gd' && e.to === 'scripts/core/GameManager.gd');
  assert(reqEdge && reqEdge.kind === 'requires', 'Missing requires edge to GameManager.gd');
});

test('identifies orphaned/unconnected nodes with zero edges', () => {
  // Compute edge endpoints
  const connectedNodes = new Set();
  for (const e of result.edges) {
    connectedNodes.add(e.from);
    connectedNodes.add(e.to);
  }

  const orphans = result.nodes.filter(n => !connectedNodes.has(n.id));
  assert(orphans.length >= 6, `Expected at least 6 orphaned nodes, got ${orphans.length}: ${orphans.map(o => o.id).join(', ')}`);
  assert(orphans.some(o => o.id.includes('MathHelpers')), 'MathHelpers should be an orphan');
  assert(orphans.some(o => o.id.includes('TestCombat')), 'TestCombat should be an orphan');
});

test('determinism: two runs produce identical output', async () => {
  const run2 = await extract(fixturePath);
  assert(JSON.stringify(result) === JSON.stringify(run2), 'Extractor output is not deterministic');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
