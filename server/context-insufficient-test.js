/**
 * server/context-insufficient-test.js
 *
 * Automated verification for Phase 24: Context-Insufficient Loop Closure (T101, T102).
 * Verifies:
 * 1. POST /add-from-clipboard explicitly detects CONTEXT INSUFFICIENT pattern instead of treating as malformed patch.
 * 2. Extracts referenced file names accurately.
 * 3. Expands the context bundle with the requested file when recompiling.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import clipboardRouter from './routes/clipboard.js';
import contextRouter from './routes/context.js';
import extractRouter from './routes/extract.js';
import { HeadlessClient } from '../scripts/headless-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const jsFixture = join(root, 'test-fixtures', 'js-sample');

let server;
let port;
let client;

before(async () => {
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

test('Phase 24: Context-Insufficient Loop Closure Tests', async (t) => {
  await t.test('T101: POST /add-from-clipboard intercepts CONTEXT INSUFFICIENT response cleanly', async () => {
    const aiResponse = 'CONTEXT INSUFFICIENT: Need to inspect `src/utils.js` (MathUtils functions) and `src/scene-manager.js` to verify scene load contract.';

    const result = await client.applyPatch(jsFixture, aiResponse);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.isContextInsufficient, true);
    assert.ok(Array.isArray(result.requestedFiles));
    assert.ok(result.requestedFiles.includes('src/utils.js'));
    assert.ok(result.requestedFiles.includes('src/scene-manager.js'));
  });

  await t.test('T101b: Patch mentioning CONTEXT INSUFFICIENT in a comment applies normally without false-positive intercept', async () => {
    const sandbox = join(tmpdir(), `cf-false-pos-${Date.now()}`);
    mkdirSync(join(sandbox, 'src'), { recursive: true });
    const targetFile = join(sandbox, 'src', 'player.js');
    writeFileSync(targetFile, 'export class Player {\n  constructor() {\n    this.speed = 5;\n  }\n}\n', 'utf-8');

    const patchWithMention = [
      'Here is the requested fix:',
      '// Note: Previous issue was marked as CONTEXT INSUFFICIENT, but resolved with internal logic.',
      '### EDIT: src/player.js',
      '<<<<<<< FIND',
      '    this.speed = 5;',
      '=======',
      '    this.speed = 10; // Handled CONTEXT INSUFFICIENT edgecase',
      '>>>>>>> REPLACE'
    ].join('\n');

    try {
      const result = await client.applyPatch(sandbox, patchWithMention);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.isContextInsufficient, undefined);
      assert.strictEqual(result.count, 1);
      const updated = readFileSync(targetFile, 'utf-8');
      assert.ok(updated.includes('this.speed = 10;'));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  await t.test('T102: Auto-expanded context bundle includes full source of requested file', async () => {
    // 1. Initial investigation has only src/player.js attached
    const initialHandoff = await client.getScopedContext({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      attachedFiles: ['src/player.js'],
      issueDescription: 'Cannot find MathUtils.clamp'
    });

    // Verify utils.js was NOT initially full source
    assert.ok(!initialHandoff.prompt.includes('### FILE: src/utils.js (Full Source)'));

    // 2. Expand context by adding requested file in full mode
    const expandedHandoff = await client.getScopedContext({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      attachedFiles: ['src/player.js', 'src/utils.js'],
      fileModes: {
        'src/player.js': 'scoped',
        'src/utils.js': 'full'
      },
      issueDescription: 'Cannot find MathUtils.clamp'
    });

    assert.ok(expandedHandoff.success);
    assert.ok(expandedHandoff.prompt.includes('### FILE: src/utils.js (Full Source)'));
    assert.ok(expandedHandoff.prompt.includes('MathUtils'));
  });
});
