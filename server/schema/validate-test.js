/**
 * Quick smoke test for validate.js — run with: node server/schema/validate-test.js
 */

import { validateManifest } from './validate.js';

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

// A minimal valid manifest
const validManifest = {
  project_root: '/home/user/my-game',
  generated_at: '2026-09-25T10:00:00.000Z',
  nodes: [
    {
      id: 'scenes/Player.tscn',
      engine: 'godot',
      type: 'scene',
      contract: {
        exports: ['speed: float'],
        signals: ['died()'],
        requires: []
      },
      depends_on: ['scripts/Player.gd'],
      depended_on_by: ['scenes/Level1.tscn']
    },
    {
      id: 'scripts/Player.gd',
      engine: 'godot',
      type: 'script',
      contract: {
        exports: ['speed: float'],
        signals: ['died()', 'health_changed(new_value)'],
        requires: ['GameManager']
      },
      depends_on: [],
      depended_on_by: ['scenes/Player.tscn']
    },
    {
      id: 'scenes/Level1.tscn',
      engine: 'godot',
      type: 'scene',
      contract: {
        exports: [],
        signals: [],
        requires: []
      },
      depends_on: ['scenes/Player.tscn'],
      depended_on_by: []
    }
  ],
  edges: [
    { from: 'scenes/Player.tscn', to: 'scripts/Player.gd', kind: 'ext_resource' },
    { from: 'scenes/Level1.tscn', to: 'scenes/Player.tscn', kind: 'ext_resource' }
  ]
};

console.log('validate.js tests:');

test('valid manifest passes', () => {
  const result = validateManifest(validManifest);
  assert(result.valid === true, `Expected valid=true, got ${result.valid}`);
  assert(result.errors.length === 0, `Expected no errors, got: ${result.errors.join(', ')}`);
});

test('missing project_root fails with clear error', () => {
  const { project_root, ...noRoot } = validManifest;
  const result = validateManifest(noRoot);
  assert(result.valid === false, 'Expected valid=false');
  assert(result.errors.some(e => e.includes('project_root')),
    `Expected error mentioning project_root, got: ${result.errors.join('; ')}`);
});

test('bad engine enum fails with allowed values', () => {
  const bad = structuredClone(validManifest);
  bad.nodes[0].engine = 'unity';
  const result = validateManifest(bad);
  assert(result.valid === false, 'Expected valid=false');
  assert(result.errors.some(e => e.includes('godot') && e.includes('js')),
    `Expected error listing allowed enums, got: ${result.errors.join('; ')}`);
});

test('bad edge kind fails', () => {
  const bad = structuredClone(validManifest);
  bad.edges[0].kind = 'magic';
  const result = validateManifest(bad);
  assert(result.valid === false, 'Expected valid=false');
  assert(result.errors.some(e => e.includes('ext_resource')),
    `Expected error listing allowed edge kinds, got: ${result.errors.join('; ')}`);
});

test('extra property on node fails', () => {
  const bad = structuredClone(validManifest);
  bad.nodes[0].banana = 'yes';
  const result = validateManifest(bad);
  assert(result.valid === false, 'Expected valid=false');
  assert(result.errors.some(e => e.includes('banana')),
    `Expected error mentioning "banana", got: ${result.errors.join('; ')}`);
});

test('missing contract field fails', () => {
  const bad = structuredClone(validManifest);
  delete bad.nodes[0].contract.signals;
  const result = validateManifest(bad);
  assert(result.valid === false, 'Expected valid=false');
  assert(result.errors.some(e => e.includes('signals')),
    `Expected error mentioning signals, got: ${result.errors.join('; ')}`);
});

test('empty manifest (no nodes/edges) is valid', () => {
  const empty = {
    project_root: '/tmp/empty',
    generated_at: '2026-01-01T00:00:00.000Z',
    nodes: [],
    edges: []
  };
  const result = validateManifest(empty);
  assert(result.valid === true, `Expected valid=true, got errors: ${result.errors.join('; ')}`);
});

test('asset node with slot contract validates against schema', () => {
  const manifestWithAsset = {
    project_root: '/home/user/my-game',
    generated_at: '2026-09-25T10:00:00.000Z',
    nodes: [
      {
        id: 'models/character.glb',
        engine: 'js',
        type: 'asset',
        contract: {
          exports: ['animation: idle', 'animation: walk', 'format: glb', 'rigged: true'],
          signals: [],
          requires: [],
          slot: {
            slot: 'character',
            format: 'glb',
            expected_animations: ['idle', 'walk'],
            rigged: true
          }
        },
        slot: {
          slot: 'character',
          format: 'glb',
          expected_animations: ['idle', 'walk'],
          rigged: true
        },
        depends_on: [],
        depended_on_by: ['src/main.js']
      }
    ],
    edges: [
      { from: 'src/main.js', to: 'models/character.glb', kind: 'asset_ref' }
    ]
  };
  const result = validateManifest(manifestWithAsset);
  assert(result.valid === true, `Expected valid=true, got errors: ${result.errors.join('; ')}`);
});

test('requires edge kind validates against schema', () => {
  const manifestWithRequires = {
    project_root: '/home/user/my-game',
    generated_at: '2026-09-25T10:00:00.000Z',
    nodes: [
      {
        id: 'scripts/Player.gd',
        engine: 'godot',
        type: 'script',
        contract: { exports: [], signals: [], requires: ['GameManager'] },
        depends_on: ['scripts/GameManager.gd'],
        depended_on_by: []
      },
      {
        id: 'scripts/GameManager.gd',
        engine: 'godot',
        type: 'script',
        contract: { exports: [], signals: [], requires: [] },
        depends_on: [],
        depended_on_by: ['scripts/Player.gd']
      }
    ],
    edges: [
      { from: 'scripts/Player.gd', to: 'scripts/GameManager.gd', kind: 'requires' }
    ]
  };
  const result = validateManifest(manifestWithRequires);
  assert(result.valid === true, `Expected valid=true, got errors: ${result.errors.join('; ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
