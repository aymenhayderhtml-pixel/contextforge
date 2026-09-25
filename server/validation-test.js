/**
 * Test Validation on Write-back (Phase 6):
 * - T025: re-run extractor on changed file only & compare new contract to dependent expectations
 * - T026: surface mismatches clearly (signals, exports), release lock on completion
 *
 * Run: node server/validation-test.js
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const godotFixture = join(projectRoot, 'test-fixtures', 'godot-sample');
const jsFixture = join(projectRoot, 'test-fixtures', 'js-sample');

const BASE_URL = 'http://localhost:3000';
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  })();
}

console.log('Validation on Write-back (Phase 6) tests:\n');

// 1. Setup: Extract Godot project
const extractRes = await fetch(`${BASE_URL}/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectPath: godotFixture })
});
assert(extractRes.ok, 'Failed to extract Godot project');

const playerGdPath = join(godotFixture, 'scripts/Player.gd');
const originalPlayerGd = readFileSync(playerGdPath, 'utf-8');

try {
  // Lock Player.gd
  const lockRes = await fetch(`${BASE_URL}/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 'scripts/Player.gd', holder: 'test-agent' })
  });
  assert(lockRes.ok, 'Failed to lock Player.gd');

  await test('Detects missing signal expected by dependent scene (T025, T026)', async () => {
    // Code with `died` signal removed!
    const brokenCode = `extends CharacterBody2D
signal health_changed(new_value: int)

@export var speed: float = 200.0
@export var jump_force: float = 400.0
var health: int = 100

func take_damage(amount: int) -> void:
\thealth -= amount
\thealth_changed.emit(health)

func get_health() -> int:
\treturn health
`;

    const res = await fetch(`${BASE_URL}/paste-back`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'scripts/Player.gd',
        holder: 'test-agent',
        code: brokenCode
      })
    });
    assert(res.ok, `Status ${res.status}`);
    const data = await res.json();

    assert(data.success === true, 'write should succeed');
    assert(data.validation, 'should have validation property');
    assert(data.validation.valid === false, 'validation should fail due to missing signal');
    assert(data.validation.mismatches.length > 0, 'should have mismatches');

    const hasExpectedSignalMismatch = data.validation.mismatches.some(m =>
      m.includes('Level1 expects Player to emit `died()`') ||
      (m.includes('Player') && m.includes('died()') && m.includes('does not declare that signal'))
    );
    assert(hasExpectedSignalMismatch, `Mismatch message not formatted as expected: ${JSON.stringify(data.validation.mismatches)}`);
  });

  await test('Detects missing exported function expected by dependents (T025, T026)', async () => {
    // Code with `take_damage` function removed
    const brokenExportCode = `extends CharacterBody2D
signal died()
signal health_changed(new_value: int)

@export var speed: float = 200.0
@export var jump_force: float = 400.0
var health: int = 100

func get_health() -> int:
\treturn health
`;

    const res = await fetch(`${BASE_URL}/paste-back`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'scripts/Player.gd',
        holder: 'test-agent',
        code: brokenExportCode
      })
    });
    const data = await res.json();
    assert(data.validation.valid === false, 'validation should fail due to missing export');
    const hasExportMismatch = data.validation.mismatches.some(m =>
      m.includes('take_damage') && m.includes('missing from the new contract')
    );
    assert(hasExportMismatch, `Expected export mismatch for take_damage, got: ${JSON.stringify(data.validation.mismatches)}`);
  });

  await test('Valid contract passes validation and releases lock when requested (T026)', async () => {
    // Restore original code
    const res = await fetch(`${BASE_URL}/paste-back`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'scripts/Player.gd',
        holder: 'test-agent',
        code: originalPlayerGd,
        releaseLock: true
      })
    });
    const data = await res.json();
    assert(data.validation.valid === true, `Expected valid=true, got: ${JSON.stringify(data.validation.mismatches)}`);
    assert(data.validation.mismatches.length === 0, 'Expected no mismatches');
    assert(data.lockReleased === true, 'Lock should be released');

    // Confirm node is unlocked
    const locksRes = await fetch(`${BASE_URL}/locks`);
    const locks = await locksRes.json();
    assert(!locks['scripts/Player.gd'], 'Player.gd should no longer be locked');
  });

  // 2. Test JS Module write-back validation
  await test('Detects missing JS named export expected by dependent module (T025, T026)', async () => {
    // Extract JS project
    await fetch(`${BASE_URL}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: jsFixture })
    });

    const playerJsPath = join(jsFixture, 'src/player.js');
    const originalPlayerJs = readFileSync(playerJsPath, 'utf-8');

    // Lock player.js
    await fetch(`${BASE_URL}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'src/player.js', holder: 'js-agent' })
    });

    // Remove `createPlayer` export
    const brokenJsCode = `import { MathUtils } from './utils.js';
export class Player { constructor(name) { this.name = name; } }
export const MAX_PLAYERS = 4;
`;

    const res = await fetch(`${BASE_URL}/paste-back`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'src/player.js',
        holder: 'js-agent',
        code: brokenJsCode
      })
    });
    const data = await res.json();
    assert(data.validation.valid === false, 'validation should fail due to missing JS export');
    const hasJsMismatch = data.validation.mismatches.some(m =>
      m.includes('createPlayer') && m.includes('missing from the new contract')
    );
    assert(hasJsMismatch, `Expected JS export mismatch for createPlayer, got: ${JSON.stringify(data.validation.mismatches)}`);

    // Restore original file and release lock
    await fetch(`${BASE_URL}/paste-back`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'src/player.js',
        holder: 'js-agent',
        code: originalPlayerJs,
        releaseLock: true
      })
    });
  });

} finally {
  // Always ensure original fixture file is restored
  writeFileSync(playerGdPath, originalPlayerGd, 'utf-8');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
