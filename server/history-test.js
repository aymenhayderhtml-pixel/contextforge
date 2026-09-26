import assert from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { recordHistoryStep, undo, redo, getHistoryStatus, clearHistory } from './history-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BASE_URL = 'http://localhost:3000';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('File History & Transaction System (Undo / Redo) tests:\n');

const testProj = '/tmp/cf-history-unit-test';
if (existsSync(testProj)) rmSync(testProj, { recursive: true, force: true });
mkdirSync(testProj, { recursive: true });

// 1. Basic recordHistoryStep, undo, and redo
await test('records transaction step, undoes change, and redoes change', () => {
  clearHistory(testProj);
  const file1 = join(testProj, 'hello.txt');
  writeFileSync(file1, 'initial content', 'utf-8');

  // Modify file
  writeFileSync(file1, 'modified content', 'utf-8');
  const step = recordHistoryStep(testProj, 'Changed hello.txt', [
    { path: 'hello.txt', before: 'initial content', after: 'modified content' }
  ]);

  assert(step, 'Step should be recorded');
  assert.strictEqual(step.patchId, 'PATCH #001');

  let status = getHistoryStatus(testProj);
  assert.strictEqual(status.canUndo, true);
  assert.strictEqual(status.canRedo, false);
  assert.strictEqual(status.undoCount, 1);

  // Undo
  const undoResult = undo(testProj);
  assert(undoResult.success, 'Undo should succeed');
  assert.strictEqual(readFileSync(file1, 'utf-8'), 'initial content', 'File should be restored to initial');

  status = getHistoryStatus(testProj);
  assert.strictEqual(status.canUndo, false);
  assert.strictEqual(status.canRedo, true);
  assert.strictEqual(status.redoCount, 1);

  // Redo
  const redoResult = redo(testProj);
  assert(redoResult.success, 'Redo should succeed');
  assert.strictEqual(readFileSync(file1, 'utf-8'), 'modified content', 'File should be reapplied to modified');

  status = getHistoryStatus(testProj);
  assert.strictEqual(status.canUndo, true);
  assert.strictEqual(status.canRedo, false);
});

// 2. Undo creation of a brand new file (deletes on undo, recreates on redo)
await test('undoes creation of new file and re-creates on redo', () => {
  clearHistory(testProj);
  const newFilePath = join(testProj, 'new-file.js');
  writeFileSync(newFilePath, 'console.log("hello");', 'utf-8');

  recordHistoryStep(testProj, 'Created new-file.js', [
    { path: 'new-file.js', before: null, after: 'console.log("hello");' }
  ]);

  assert(existsSync(newFilePath), 'File should exist');

  // Undo creation
  undo(testProj);
  assert(!existsSync(newFilePath), 'File should be deleted on undo');

  // Redo creation
  redo(testProj);
  assert(existsSync(newFilePath), 'File should be re-created on redo');
  assert.strictEqual(readFileSync(newFilePath, 'utf-8'), 'console.log("hello");');
});

// 3. Multi-file surgical edit transaction & undo
await test('records multi-file transaction with patch ID and metadata', () => {
  clearHistory(testProj);
  const f1 = join(testProj, 'a.js');
  const f2 = join(testProj, 'b.js');
  writeFileSync(f1, 'var a = 1;', 'utf-8');
  writeFileSync(f2, 'var b = 2;', 'utf-8');

  writeFileSync(f1, 'var a = 10;', 'utf-8');
  writeFileSync(f2, 'var b = 20;', 'utf-8');

  const step = recordHistoryStep(testProj, 'Updated 2 files', [
    { path: 'a.js', before: 'var a = 1;', after: 'var a = 10;' },
    { path: 'b.js', before: 'var b = 2;', after: 'var b = 20;' }
  ]);

  assert.strictEqual(step.metadata.filesCount, 2);
  assert.deepStrictEqual(step.metadata.paths, ['a.js', 'b.js']);

  undo(testProj);
  assert.strictEqual(readFileSync(f1, 'utf-8'), 'var a = 1;');
  assert.strictEqual(readFileSync(f2, 'utf-8'), 'var b = 2;');
});

// 4. Maximum 20 steps cap
await test('caps undo stack at 20 steps and shifts oldest', () => {
  clearHistory(testProj);
  for (let i = 1; i <= 25; i++) {
    recordHistoryStep(testProj, `Step ${i}`, [
      { path: 'counter.txt', before: `val ${i - 1}`, after: `val ${i}` }
    ]);
  }
  const status = getHistoryStatus(testProj);
  assert.strictEqual(status.undoCount, 20, 'Undo stack must cap at 20');
});

// 5. HTTP Endpoints: /history/status, /history/undo, /history/redo
await test('HTTP endpoints /history/status, /history/undo, /history/redo operate cleanly', async () => {
  const httpProj = '/tmp/cf-history-http-test';
  if (existsSync(httpProj)) rmSync(httpProj, { recursive: true, force: true });
  mkdirSync(httpProj, { recursive: true });
  await fetch(`${BASE_URL}/history/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: httpProj })
  });

  const testFile = join(httpProj, 'test.txt');
  writeFileSync(testFile, 'version 1', 'utf-8');

  // Modify via save-file endpoint
  const saveRes = await fetch(`${BASE_URL}/save-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: httpProj, filePath: 'test.txt', content: 'version 2' })
  });
  assert(saveRes.ok, 'Save file must succeed');
  const saveData = await saveRes.json();
  assert(saveData.patchId, 'Save response should include patchId');

  // Check /history/status
  const statusRes = await fetch(`${BASE_URL}/history/status?projectPath=${encodeURIComponent(httpProj)}`);
  assert(statusRes.ok);
  const status = await statusRes.json();
  assert.strictEqual(status.canUndo, true);
  assert.strictEqual(status.undoCount, 1);

  // Undo via POST /history/undo
  const undoRes = await fetch(`${BASE_URL}/history/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: httpProj })
  });
  assert(undoRes.ok);
  const undoData = await undoRes.json();
  assert(undoData.success);
  assert.strictEqual(readFileSync(testFile, 'utf-8'), 'version 1');

  // Redo via POST /history/redo
  const redoRes = await fetch(`${BASE_URL}/history/redo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: httpProj })
  });
  assert(redoRes.ok);
  const redoData = await redoRes.json();
  assert(redoData.success);
  assert.strictEqual(readFileSync(testFile, 'utf-8'), 'version 2');
});

// 6. POST /add-from-clipboard records history step and allows undo
await test('POST /add-from-clipboard records surgical patch transaction and allows undo', async () => {
  const clipProj = '/tmp/cf-history-clip-test';
  if (existsSync(clipProj)) rmSync(clipProj, { recursive: true, force: true });
  mkdirSync(clipProj, { recursive: true });
  await fetch(`${BASE_URL}/history/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: clipProj })
  });

  const gameFile = join(clipProj, 'game.js');
  writeFileSync(gameFile, 'export function run() {\n  let speed = 5;\n}', 'utf-8');

  const patchText = `### EDIT: game.js
<<<<<<< FIND
  let speed = 5;
=======
  let speed = 25;
>>>>>>> REPLACE`;

  const clipRes = await fetch(`${BASE_URL}/add-from-clipboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: clipProj, content: patchText })
  });
  assert(clipRes.ok, `add-from-clipboard status: ${clipRes.status}`);
  const clipData = await clipRes.json();
  assert(clipData.patchId, 'Response should contain patchId');
  assert(readFileSync(gameFile, 'utf-8').includes('let speed = 25;'));

  // Undo the patch
  const undoRes = await fetch(`${BASE_URL}/history/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: clipProj })
  });
  assert(undoRes.ok);
  assert(readFileSync(gameFile, 'utf-8').includes('let speed = 5;'), 'Should be restored to speed = 5');
});

// Clean up
if (existsSync(testProj)) rmSync(testProj, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
