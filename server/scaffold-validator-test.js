/**
 * server/scaffold-validator-test.js — Tests for Add Node ID validation (T031).
 *
 * Run: node server/scaffold-validator-test.js
 */

import { validateNodeId } from './scaffold-validator.js';

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

console.log('Scaffold validator tests (T031):\n');

test('rejects empty string', () => {
  const res = validateNodeId('', 'godot', 'scene');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('required'), `Unexpected error: ${res.error}`);
});

test('rejects bare spaces', () => {
  const res = validateNodeId('   ', 'godot', 'scene');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('empty or whitespace'), `Unexpected error: ${res.error}`);
});

test('rejects names with spaces ("scene 1")', () => {
  const res = validateNodeId('scene 1', 'godot', 'scene');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('spaces'), `Unexpected error: ${res.error}`);
});

test('rejects paths with spaces ("scenes/my player.tscn")', () => {
  const res = validateNodeId('scenes/my player.tscn', 'godot', 'scene');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('spaces'), `Unexpected error: ${res.error}`);
});

test('rejects path traversal ("../escaped.gd")', () => {
  const res = validateNodeId('../escaped.gd', 'godot', 'script');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('traversal'), `Unexpected error: ${res.error}`);
});

test('rejects absolute paths ("/var/log/file.gd")', () => {
  const res = validateNodeId('/var/log/file.gd', 'godot', 'script');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('relative path'), `Unexpected error: ${res.error}`);
});

test('rejects node ID without extension ("scenes/Boss")', () => {
  const res = validateNodeId('scenes/Boss', 'godot', 'scene');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('missing a file extension'), `Unexpected error: ${res.error}`);
});

test('rejects wrong extension for Godot scene ("scenes/Boss.gd")', () => {
  const res = validateNodeId('scenes/Boss.gd', 'godot', 'scene');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('.tscn extension'), `Unexpected error: ${res.error}`);
});

test('rejects wrong extension for Godot script ("scripts/Player.js")', () => {
  const res = validateNodeId('scripts/Player.js', 'godot', 'script');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('.gd extension'), `Unexpected error: ${res.error}`);
});

test('rejects wrong extension for JS module ("src/player.gd")', () => {
  const res = validateNodeId('src/player.gd', 'js', 'module');
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('.js'), `Unexpected error: ${res.error}`);
});

test('rejects duplicate existing node', () => {
  const res = validateNodeId('scenes/Player.tscn', 'godot', 'scene', ['scenes/Player.tscn', 'scripts/Player.gd']);
  assert(!res.valid, 'Expected invalid');
  assert(res.error.includes('already exists'), `Unexpected error: ${res.error}`);
});

test('accepts valid Godot scene path ("scenes/Boss.tscn")', () => {
  const res = validateNodeId('scenes/Boss.tscn', 'godot', 'scene');
  assert(res.valid, `Expected valid, got error: ${res.error}`);
  assert(res.normalizedId === 'scenes/Boss.tscn');
});

test('accepts valid Godot script path ("scripts/Boss.gd")', () => {
  const res = validateNodeId('scripts/Boss.gd', 'godot', 'script');
  assert(res.valid, `Expected valid, got error: ${res.error}`);
  assert(res.normalizedId === 'scripts/Boss.gd');
});

test('accepts valid JS module path ("src/enemies/boss.js")', () => {
  const res = validateNodeId('src/enemies/boss.js', 'js', 'module');
  assert(res.valid, `Expected valid, got error: ${res.error}`);
  assert(res.normalizedId === 'src/enemies/boss.js');
});

test('normalizes backslashes to forward slashes', () => {
  const res = validateNodeId('scenes\\sub\\Boss.tscn', 'godot', 'scene');
  assert(res.valid, `Expected valid, got error: ${res.error}`);
  assert(res.normalizedId === 'scenes/sub/Boss.tscn');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
