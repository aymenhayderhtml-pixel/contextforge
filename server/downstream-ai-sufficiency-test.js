/**
 * server/downstream-ai-sufficiency-test.js
 *
 * Automated verification for Phase 25: Blind Downstream AI Code-Generation Sufficiency Test (T106).
 * Verifies:
 * 1. Interface outline extraction preserves method signatures inside exported objects & classes.
 * 2. Scoped context bundle provides sufficient ground-truth interface contracts for downstream AI.
 * 3. Surgical patch produced from handoff bundle applies cleanly with syntax validation.
 * 4. Context-insufficient signal produced when interfaces are absent parses into auto-expandable file requests.
 * 5. Prompt re-compilation with expanded files closes the context loop.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import clipboardRouter from './routes/clipboard.js';
import contextRouter from './routes/context.js';
import extractRouter from './routes/extract.js';
import { HeadlessClient } from '../scripts/headless-runner.js';
import { generateJsOutline, generateGdScriptOutline, clearOutlineCache } from './outline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const jsFixture = join(root, 'test-fixtures', 'js-sample');
const godotFixture = join(root, 'test-fixtures', 'godot-sample');

let server;
let port;
let client;

before(async () => {
  clearOutlineCache();
  const app = express();
  app.use(express.json());
  app.use(extractRouter);
  app.use(contextRouter);
  app.use(clipboardRouter);

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      client = new HeadlessClient(`http://localhost:${port}`);
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
});

test('Phase 25: Blind Downstream AI Code-Generation Sufficiency Tests (T106)', async (t) => {
  await t.test('T106.1: generateJsOutline extracts object literal and class member signatures', () => {
    const sampleUtils = readFileSync(join(jsFixture, 'src', 'utils.js'), 'utf-8');
    const outline = generateJsOutline(sampleUtils);

    assert.ok(outline.includes('export const MathUtils = {'), 'Must include exported object declaration');
    assert.ok(outline.includes('clamp(value, min, max)'), 'Must include clamp signature');
    assert.ok(outline.includes('clampDelta(dt)'), 'Must include clampDelta signature');
    assert.ok(outline.includes('lerp(a, b, t)'), 'Must include lerp signature');
    assert.ok(outline.includes('export function randomRange(min, max)'), 'Must include exported function');
  });

  await t.test('T106.2: Compiled scoped-context bundle contains complete dependency contracts without full source leak', async () => {
    await client.extract(jsFixture);

    const handoff = await client.getScopedContext({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      attachedFiles: ['src/player.js', 'src/utils.js'],
      issueDescription: 'Add heal(amount) method using MathUtils.clamp and smoothMoveTo(targetX, factor) using MathUtils.lerp'
    });

    assert.ok(handoff.success);
    const prompt = handoff.prompt;

    // Target file has focused lines
    assert.ok(prompt.includes('### FILE: src/player.js (Scoped Context)'));
    assert.ok(prompt.includes('export class Player'));

    // Dependency file has interface outline with signatures verbatim
    assert.ok(prompt.includes('### FILE: src/utils.js (Outline / Interface Only)'));
    assert.ok(prompt.includes('export const MathUtils = {'));
    assert.ok(prompt.includes('clamp(value, min, max)'));
    assert.ok(prompt.includes('clampDelta(dt)'));
    assert.ok(prompt.includes('lerp(a, b, t)'));
    assert.ok(prompt.includes('export function randomRange(min, max)'));
    assert.ok(!prompt.includes('Math.min(Math.max(value, min), max)'), 'Interface outline must not leak function bodies');

    // Prompt contains strict surgical format instructions
    assert.ok(prompt.includes('### EDIT: relative/path.ext'));
    assert.ok(prompt.includes('<<<<<<< FIND'));
    assert.ok(prompt.includes('CONTEXT INSUFFICIENT'));
  });

  await t.test('T106.3: Downstream AI surgical patch applies cleanly with verified syntax', async () => {
    const sandbox = join(tmpdir(), `cf-downstream-ai-test-${Date.now()}`);
    mkdirSync(join(sandbox, 'src'), { recursive: true });
    copyFileSync(join(jsFixture, 'src', 'player.js'), join(sandbox, 'src', 'player.js'));

    // Literal response emitted by downstream AI strictly following handoff prompt:
    const aiPatch = [
      '### EDIT: src/player.js',
      '<<<<<<< FIND',
      '  update(dt) {',
      '    this.position.x += MathUtils.clampDelta(dt) * 10;',
      '  }',
      '=======',
      '  update(dt) {',
      '    this.position.x += MathUtils.clampDelta(dt) * 10;',
      '  }',
      '',
      '  heal(amount) {',
      '    this.health = MathUtils.clamp(this.health + amount, 0, 100);',
      '  }',
      '',
      '  smoothMoveTo(targetX, factor) {',
      '    this.position.x = MathUtils.lerp(this.position.x, targetX, factor);',
      '  }',
      '>>>>>>> REPLACE'
    ].join('\n');

    try {
      const applyResult = await client.applyPatch(sandbox, aiPatch);
      assert.strictEqual(applyResult.success, true);
      assert.strictEqual(applyResult.count, 1);
      assert.strictEqual(applyResult.syntaxValid, true);
      assert.strictEqual(applyResult.syntaxError, null);

      const modifiedContent = readFileSync(join(sandbox, 'src', 'player.js'), 'utf-8');
      assert.ok(modifiedContent.includes('heal(amount)'));
      assert.ok(modifiedContent.includes('MathUtils.clamp(this.health + amount, 0, 100)'));
      assert.ok(modifiedContent.includes('smoothMoveTo(targetX, factor)'));
      assert.ok(modifiedContent.includes('MathUtils.lerp(this.position.x, targetX, factor)'));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  await t.test('T106.4: Downstream AI context-insufficient response cleanly expands context bundle', async () => {
    // Literal response emitted by downstream AI when asked for unprovided dependencies:
    const aiInsufficientResponse = 'CONTEXT INSUFFICIENT: Need to inspect `src/asset-loader.js` (AssetLoader.loadCharacterModel) and `src/scene-manager.js` (scene registration).';

    const parseResult = await client.applyPatch(jsFixture, aiInsufficientResponse);
    assert.strictEqual(parseResult.success, false);
    assert.strictEqual(parseResult.isContextInsufficient, true);
    assert.ok(parseResult.requestedFiles.includes('src/asset-loader.js'));
    assert.ok(parseResult.requestedFiles.includes('src/scene-manager.js'));

    // Recompilation with requested files expands bundle
    const expandedHandoff = await client.getScopedContext({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      attachedFiles: ['src/player.js', 'src/utils.js', ...parseResult.requestedFiles],
      fileModes: {
        'src/asset-loader.js': 'full',
        'src/scene-manager.js': 'full'
      },
      issueDescription: 'Load character mesh and register entity'
    });

    assert.ok(expandedHandoff.success);
    assert.ok(expandedHandoff.prompt.includes('### FILE: src/asset-loader.js (Full Source)'));
    assert.ok(expandedHandoff.prompt.includes('### FILE: src/scene-manager.js (Full Source)'));
  });

  await t.test('T106.5: GDScript interface outlines preserve public member variables, exports, signals, and functions', async () => {
    const playerGd = readFileSync(join(godotFixture, 'scripts', 'Player.gd'), 'utf-8');
    const gmGd = readFileSync(join(godotFixture, 'scripts', 'GameManager.gd'), 'utf-8');

    const playerOutline = generateGdScriptOutline(playerGd);
    assert.ok(playerOutline.includes('extends CharacterBody2D'));
    assert.ok(playerOutline.includes('signal died()'));
    assert.ok(playerOutline.includes('signal health_changed(new_value: int)'));
    assert.ok(playerOutline.includes('@export var speed: float = 200.0'));
    assert.ok(playerOutline.includes('var health: int = 100'), 'Must include top-level var');
    assert.ok(playerOutline.includes('func take_damage(amount: int) -> void'));
    assert.ok(playerOutline.includes('func get_health() -> int'));
    assert.ok(!playerOutline.includes('func _process'), 'Must exclude private funcs');
    assert.ok(!playerOutline.includes('health -= amount'), 'Must not include function body');

    const gmOutline = generateGdScriptOutline(gmGd);
    assert.ok(gmOutline.includes('extends Node'));
    assert.ok(gmOutline.includes('var score: int = 0'));
    assert.ok(gmOutline.includes('var is_game_over: bool = false'));
    assert.ok(gmOutline.includes('func add_score(points: int) -> void'));
    assert.ok(gmOutline.includes('func reset() -> void'));
    assert.ok(!gmOutline.includes('score += points'), 'Must not include function body');

    // Test compiled Godot handoff prompt
    await client.extract(godotFixture);
    const handoff = await client.getScopedContext({
      projectPath: godotFixture,
      targetFile: 'scripts/Player.gd',
      attachedFiles: ['scripts/Player.gd', 'scripts/GameManager.gd'],
      issueDescription: 'Deduct points when taking damage and check if game is over'
    });

    assert.ok(handoff.success);
    const prompt = handoff.prompt;
    assert.ok(prompt.includes('### FILE: scripts/GameManager.gd (Outline / Interface Only)'));
    assert.ok(prompt.includes('var score: int = 0'));
    assert.ok(prompt.includes('var is_game_over: bool = false'));
    assert.ok(prompt.includes('func add_score(points: int) -> void'));
    assert.ok(!prompt.includes('score += points'));
  });
});
