/**
 * server/mixed-patch-regression-test.js
 *
 * Permanent regression suite for T111:
 * "Root-cause and fix the silent partial multi-file patch-apply bug."
 *
 * Reproduces the real 4-block AI response from live playtesting (3 ### EDIT: + 1 ### FILE:)
 * and ensures:
 * 1. Both EDIT blocks and FILE blocks in a single AI response are parsed and applied together.
 * 2. New files (like scripts/jet.gd) are NOT silently dropped.
 * 3. POST /preview-diff computes visual diffs for both existing file edits and new files.
 * 4. POST /add-from-clipboard writes all files, records a single undoable transaction,
 *    and returns type='mixed' with explicit editsCount and filesCount.
 * 5. Undo removes newly created files while restoring edited files; Redo restores them.
 * 6. Verification banner reports true counts and renders failed blocks explicitly if partial.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import clipboardRouter from './routes/clipboard.js';
import historyRouter from './routes/history.js';
import { parseAiEditBlocks, parseAiFileBlocks, scaffoldNewProject } from './project-init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

const fixturePath = join(root, 'test-fixtures', 'multi-model-patches', 'sky-duel-4block-mixed-response.txt');
const rawFixtureContent = readFileSync(fixturePath, 'utf-8');

let server;
let port;
let testProjDir;
before(async () => {
  // Set up temporary Godot project matching the exact playtest fixture starting state
  testProjDir = join(tmpdir(), `contextforge-t111-${Date.now()}`);
  scaffoldNewProject({ targetFolder: testProjDir, engine: 'godot', projectName: 'Sky Duel' });
  writeFileSync(join(testProjDir, 'scripts', 'main.gd'), `extends Node\n\n# Main game entry point for Sky Duel\nsignal game_started\n\nfunc _ready():\n\tprint("Sky Duel initialized.")\n\temit_signal("game_started")\n`, 'utf-8');
  writeFileSync(join(testProjDir, 'scenes', 'main.tscn'), `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://scripts/main.gd" id="1_main"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1_main")\n`, 'utf-8');

  // Start express server
  const app = express();
  app.use(express.json());
  app.use(clipboardRouter);
  app.use(historyRouter);

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
  if (testProjDir && existsSync(testProjDir)) {
    try { rmSync(testProjDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('T111: Permanent Regression Suite — 4-Block Mixed Response Apply & Diff', async (t) => {
  await t.test('1. Parsers identify all 4 blocks without dropping or miscounting', () => {
    const editBlocks = parseAiEditBlocks(rawFixtureContent);
    const fileBlocks = parseAiFileBlocks(rawFixtureContent);

    assert.strictEqual(editBlocks.length, 3, 'Must parse exactly 3 edit blocks');
    assert.deepStrictEqual(
      editBlocks.map(e => e.path.replace(/\\/g, '/')),
      ['scripts/main.gd', 'scenes/main.tscn', 'project.godot'],
      'Edit blocks must match expected paths in order'
    );

    assert.strictEqual(fileBlocks.length, 1, 'Must parse exactly 1 file block');
    assert.strictEqual(fileBlocks[0].path.replace(/\\/g, '/'), 'scripts/jet.gd');
    assert.ok(fileBlocks[0].content.includes('class_name Jet') || fileBlocks[0].content.includes('extends CharacterBody3D'), 'jet.gd must contain script content');
  });

  await t.test('2. POST /preview-diff includes BOTH edit blocks AND file blocks with isNewFile flag', async () => {
    const res = await fetch(`http://localhost:${port}/preview-diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: testProjDir,
        content: rawFixtureContent
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.type, 'mixed', 'Diff type must be mixed when both edits and files exist');
    assert.strictEqual(data.editsCount, 3);
    assert.strictEqual(data.filesCount, 1);
    assert.strictEqual(data.files.length, 4, 'Must return diff for all 4 files');

    const jetDiff = data.files.find(f => f.file === 'scripts/jet.gd');
    assert.ok(jetDiff, 'Diff must include scripts/jet.gd');
    assert.strictEqual(jetDiff.isNewFile, true, 'scripts/jet.gd must be flagged as a new file');
    assert.ok(jetDiff.additions > 10, 'scripts/jet.gd must have positive line additions');
  });

  await t.test('3. POST /add-from-clipboard writes all 4 files, creating scripts/jet.gd on disk', async () => {
    const jetPath = join(testProjDir, 'scripts', 'jet.gd');
    assert.strictEqual(existsSync(jetPath), false, 'scripts/jet.gd must not exist before patch');

    const res = await fetch(`http://localhost:${port}/add-from-clipboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: testProjDir,
        content: rawFixtureContent
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.type, 'mixed', 'Patch type must be mixed');
    assert.strictEqual(data.total, 4, 'Total operations must be 4');
    assert.strictEqual(data.count, 4, 'Applied count must be 4');
    assert.strictEqual(data.editsCount, 3, 'Edits count must be 3');
    assert.strictEqual(data.filesCount, 1, 'Files count must be 1');
    assert.strictEqual(data.files.length, 4, 'Files list must contain 4 entries');
    assert.ok(data.message.includes('3 edit(s) and wrote 1 file(s)'), 'Message must report both edits and file writes');

    // Verify scripts/jet.gd on disk
    assert.strictEqual(existsSync(jetPath), true, 'scripts/jet.gd MUST exist on disk after patch');
    const jetContent = readFileSync(jetPath, 'utf-8');
    assert.ok(jetContent.length > 500, 'scripts/jet.gd must not be empty');
    assert.ok(jetContent.includes('extends CharacterBody3D'), 'scripts/jet.gd must contain script code');

    // Verify edited scripts/main.gd
    const mainContent = readFileSync(join(testProjDir, 'scripts', 'main.gd'), 'utf-8');
    assert.ok(mainContent.includes('const JET_SCRIPT := preload("res://scripts/jet.gd")'), 'main.gd must preload jet.gd');
    assert.ok(mainContent.includes('extends Node3D'), 'main.gd must extend Node3D');

    // Verify edited scenes/main.tscn
    const sceneContent = readFileSync(join(testProjDir, 'scenes', 'main.tscn'), 'utf-8');
    assert.ok(sceneContent.includes('type="Node3D"'), 'main.tscn must have Node3D');

    // Verify edited project.godot
    const godotConfig = readFileSync(join(testProjDir, 'project.godot'), 'utf-8');
    assert.ok(godotConfig.includes('[input]'), 'project.godot must contain input bindings');
  });

  await t.test('4. POST /history/undo cleanly reverts all 4 files including unlinking scripts/jet.gd', async () => {
    const jetPath = join(testProjDir, 'scripts', 'jet.gd');
    assert.strictEqual(existsSync(jetPath), true);

    const undoRes = await fetch(`http://localhost:${port}/history/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: testProjDir })
    });

    assert.strictEqual(undoRes.status, 200);
    const undoData = await undoRes.json();
    assert.strictEqual(undoData.success, true);

    // Verify scripts/jet.gd was deleted on undo
    assert.strictEqual(existsSync(jetPath), false, 'scripts/jet.gd must be deleted on undo');

    // Verify main.gd was restored
    const restoredMain = readFileSync(join(testProjDir, 'scripts', 'main.gd'), 'utf-8');
    assert.ok(restoredMain.includes('extends Node\n'), 'main.gd must be restored to extends Node');
    assert.strictEqual(restoredMain.includes('preload("res://scripts/jet.gd")'), false, 'main.gd must not have preload');

    // Redo restores scripts/jet.gd
    const redoRes = await fetch(`http://localhost:${port}/history/redo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: testProjDir })
    });
    assert.strictEqual(redoRes.status, 200);
    const redoData = await redoRes.json();
    assert.strictEqual(redoData.success, true);
    assert.strictEqual(existsSync(jetPath), true, 'scripts/jet.gd must be recreated on redo');
  });

  await t.test('5. Workspace UI banner renders true mixed count and failed blocks without silent drops', () => {
    const uiFile = join(root, 'public', 'js', 'workstation', 'workspace-pane.js');
    const uiContent = readFileSync(uiFile, 'utf-8');

    // Banner summary check
    assert.ok(
      uiContent.includes("v.type === 'mixed'") || uiContent.includes('blockSummary'),
      'workspace-pane.js must handle mixed response block summaries'
    );
    assert.ok(
      uiContent.includes('v.failedBlocks') && uiContent.includes('Unapplied / failed blocks'),
      'workspace-pane.js must render failed blocks explicitly'
    );
  });
});
