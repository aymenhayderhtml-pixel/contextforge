/**
 * server/prompt-template-quality-test.js
 *
 * Automated regression suite for Phase 25: Prompt Template Quality & Regression Tracking
 * (T103, T104, T105).
 * Asserts structural integrity and quality invariants of all generated prompts:
 * 1. Scaffold prompt structure (worked example, closing fences, strict rules)
 * 2. Scoped Context AI Handoff prompt (engine branding, error block, symbol outline, strict surgical contract)
 * 3. Engine-tailored sample paths in instructions (no Three.js paths in Godot prompts)
 * 4. Folding of surgical edit contract and CONTEXT INSUFFICIENT into project conventions block
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import contextRouter from './routes/context.js';
import extractRouter from './routes/extract.js';
import { HeadlessClient } from '../scripts/headless-runner.js';
import { getStrictPatchContract } from './context-compiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const jsFixture = join(root, 'test-fixtures', 'js-sample');
const godotFixture = join(root, 'test-fixtures', 'godot-sample');

let server;
let port;
let client;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(extractRouter);
  app.use(contextRouter);

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

test('Phase 25: Prompt Template Quality & Regression Tests', async (t) => {
  // --- T103: Generated Prompt Structural Invariants ---
  await t.test('T103: POST /scoped-context prompt contains all mandatory structural blocks', async () => {
    const res = await client.getScopedContext({
      projectPath: jsFixture,
      targetFile: 'src/main.js',
      attachedFiles: ['src/main.js'],
      issueDescription: 'Uncaught TypeError in startGame',
      consoleLogs: 'TypeError: Cannot read properties of undefined at src/main.js:10'
    });

    assert.ok(res.success);
    const p = res.prompt;

    // Structural elements required verbatim:
    assert.ok(p.includes('ISSUE DESCRIPTION / ERROR:'), 'Must contain issue header');
    assert.ok(p.includes('CONSOLE OUTPUT / ERROR LOG:'), 'Must contain console output header');
    assert.ok(p.includes('CURRENT FILE CONTEXT:'), 'Must contain context header');
    assert.ok(p.includes('### FILE: src/main.js (Scoped Context)'), 'Must contain target file header');
    assert.ok(p.includes('// --- Symbol Outline ---'), 'Must contain symbol outline header');
    assert.ok(p.includes('CRITICAL FORMAT & COLLABORATION INSTRUCTIONS FOR THE AI:'), 'Must contain collaboration contract');
    assert.ok(p.includes('### EDIT: relative/path.ext'), 'Must contain worked EDIT block format');
    assert.ok(p.includes('<<<<<<< FIND'), 'Must contain FIND marker');
    assert.ok(p.includes('>>>>>>> REPLACE'), 'Must contain REPLACE marker');
    assert.ok(p.includes('CONTEXT INSUFFICIENT'), 'Must contain CONTEXT INSUFFICIENT explanation');
  });

  // --- T104: Engine-Tailored Prompt Quality & Guidance ---
  await t.test('T104: Godot prompt renders GDScript example paths and never leaks Three.js paths', async () => {
    const res = await client.getScopedContext({
      projectPath: godotFixture,
      targetFile: 'scripts/Player.gd',
      attachedFiles: ['scripts/Player.gd'],
      issueDescription: 'Null reference in take_damage'
    });

    assert.ok(res.success);
    const p = res.prompt;

    assert.ok(p.includes('Godot 4.x (GDScript)'), 'Must brand Godot engine');
    assert.ok(p.includes('CONTEXT INSUFFICIENT: Need to inspect `scripts/Player.gd`'), 'Must reference GDScript sample path');
    assert.ok(!p.includes('src/scene-manager.js'), 'Must NOT leak JS/Three.js sample path in Godot prompt');
  });

  await t.test('T104: getStrictPatchContract explicitly permits ### FILE: for complete rewrites', () => {
    const contract = getStrictPatchContract('js');
    assert.ok(contract.includes('New Files & Complete Rewrites'), 'Must state complete rewrites are supported');
  });

  // --- T105: Package Context Conventions Embedding ---
  await t.test('T105: POST /package-context embeds surgical edit contract into project conventions block', async () => {
    await client.extract(jsFixture);
    const res = await fetch(`http://localhost:${port}/package-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'src/main.js' })
    });
    const data = await res.json();
    assert.ok(data.context);
    assert.ok(data.context.includes('## Project Conventions & Surgical Edit Contract'));
    assert.ok(data.context.includes('SURGICAL EDITS (SEARCH / REPLACE):'));
    assert.ok(data.context.includes('CONTEXT INSUFFICIENT: Need [exact file path or function name]'));
  });
});
