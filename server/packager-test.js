/**
 * Test Context Packager endpoints (Phase 5):
 * - POST /package-context
 * - POST /scaffold
 * - POST /paste-back
 *
 * Run: node server/packager-test.js
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const godotFixture = join(projectRoot, 'test-fixtures', 'godot-sample');

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

console.log('Context Packager (Phase 5) tests:\n');

// 1. First extract godot fixture to set currentManifest and currentProjectPath
const extractRes = await fetch(`${BASE_URL}/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectPath: godotFixture })
});
assert(extractRes.ok, 'Failed to extract project');

await test('POST /package-context returns target file, stubs, and conventions', async () => {
  const res = await fetch(`${BASE_URL}/package-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 'scenes/Player.tscn' })
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await res.json();

  assert(data.nodeId === 'scenes/Player.tscn', 'nodeId mismatch');
  assert(typeof data.context === 'string', 'context must be a string');
  assert(data.context.includes('## Target File: scenes/Player.tscn'), 'missing target file header');
  assert(data.context.includes('ExtResource'), 'missing target file content');
  assert(data.context.includes('## Direct Dependencies (interface only)'), 'missing dependencies header');
  assert(data.context.includes('scripts/Player.gd'), 'missing Player.gd stub');
  assert(data.context.includes('died()'), 'missing signal in stub');
  assert(data.context.includes('## Dependents (what expects this node\'s contract)'), 'missing dependents header');
  assert(data.context.includes('scenes/Level1.tscn'), 'missing Level1.tscn stub');
  assert(data.context.includes('## Project Conventions'), 'missing conventions snippet');
});

await test('POST /package-context returns 404 for unknown node', async () => {
  const res = await fetch(`${BASE_URL}/package-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 'scenes/NonExistent.tscn' })
  });
  assert(res.status === 404, `Expected 404, got ${res.status}`);
});

await test('POST /scaffold fails if another holder already holds lock', async () => {
  // Lock scenes/Player.tscn for agent-1
  await fetch(`${BASE_URL}/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 'scenes/Player.tscn', holder: 'agent-1' })
  });

  // agent-2 attempts to scaffold it
  const res = await fetch(`${BASE_URL}/scaffold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId: 'scenes/Player.tscn',
      engine: 'godot',
      type: 'scene',
      holder: 'agent-2'
    })
  });
  assert(res.status === 409, `Expected 409, got ${res.status}`);

  // Cleanup lock
  await fetch(`${BASE_URL}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 'scenes/Player.tscn', force: true })
  });
});

const tempScaffoldNode = 'scripts/TempScaffoldTest.gd';
const tempScaffoldPath = join(godotFixture, tempScaffoldNode);

await test('POST /scaffold locks node, writes boilerplate, and generates prompt', async () => {
  // Clean up if already exists
  if (existsSync(tempScaffoldPath)) unlinkSync(tempScaffoldPath);

  const res = await fetch(`${BASE_URL}/scaffold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId: tempScaffoldNode,
      engine: 'godot',
      type: 'script',
      holder: 'scaffold-agent'
    })
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await res.json();

  assert(data.nodeId === tempScaffoldNode, 'nodeId mismatch');
  assert(data.lock.status === 'locked', 'should be locked');
  assert(data.lock.holder === 'scaffold-agent', 'holder mismatch');
  assert(existsSync(tempScaffoldPath), 'boilerplate file should be created on disk');
  assert(data.prompt.includes('TempScaffoldTest.gd'), 'prompt should mention filename');
  assert(data.prompt.includes('Existing godot nodes'), 'prompt should list existing nodes');

  // Verify lock is recorded in GET /locks
  const locksRes = await fetch(`${BASE_URL}/locks`);
  const locks = await locksRes.json();
  assert(locks[tempScaffoldNode], 'Lock should be present in /locks');
});

await test('POST /paste-back rejects write when node is not locked', async () => {
  // Unlock tempScaffoldNode first
  await fetch(`${BASE_URL}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: tempScaffoldNode, force: true })
  });

  const res = await fetch(`${BASE_URL}/paste-back`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId: tempScaffoldNode,
      holder: 'scaffold-agent',
      code: 'extends Node\n# Unauthorized paste'
    })
  });
  assert(res.status === 403, `Expected 403, got ${res.status}`);
});

await test('POST /paste-back rejects write when holder does not match lock', async () => {
  // Lock for agent-A
  await fetch(`${BASE_URL}/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: tempScaffoldNode, holder: 'agent-A' })
  });

  // agent-B tries to paste-back
  const res = await fetch(`${BASE_URL}/paste-back`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId: tempScaffoldNode,
      holder: 'agent-B',
      code: 'extends Node\n# Wrong agent'
    })
  });
  assert(res.status === 403, `Expected 403, got ${res.status}`);
});

await test('POST /paste-back writes code when caller holds lock', async () => {
  const newCode = 'extends Node\n\nfunc hello() -> void:\n\tprint("Hello from paste-back")\n';
  const res = await fetch(`${BASE_URL}/paste-back`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId: tempScaffoldNode,
      holder: 'agent-A',
      code: newCode
    })
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await res.json();
  assert(data.success === true, 'Expected success=true');

  const contentOnDisk = readFileSync(tempScaffoldPath, 'utf-8');
  assert(contentOnDisk === newCode, 'Content on disk does not match written code');

  // Clean up test file and lock
  if (existsSync(tempScaffoldPath)) unlinkSync(tempScaffoldPath);
  await fetch(`${BASE_URL}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: tempScaffoldNode, force: true })
  });
});

await test('POST /scaffold rejects invalid nodeId with spaces ("scene 1") (T031)', async () => {
  const res = await fetch(`${BASE_URL}/scaffold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId: 'scene 1',
      engine: 'godot',
      type: 'scene',
      holder: 'agent-1'
    })
  });
  assert(res.status === 400, `Expected 400, got ${res.status}`);
  const data = await res.json();
  assert(data.error.includes('spaces'), `Expected error mentioning spaces, got: ${data.error}`);
});

await test('POST /scaffold rejects invalid nodeId with wrong extension (T031)', async () => {
  const res = await fetch(`${BASE_URL}/scaffold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeId: 'scenes/Boss.js',
      engine: 'godot',
      type: 'scene',
      holder: 'agent-1'
    })
  });
  assert(res.status === 400, `Expected 400, got ${res.status}`);
  const data = await res.json();
  assert(data.error.includes('.tscn extension'), `Expected error mentioning .tscn, got: ${data.error}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
