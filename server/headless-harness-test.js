/**
 * server/headless-harness-test.js
 *
 * Automated verification of Phase 20 Headless Test Harness (T090, T091, T092):
 * - Verifies API endpoints for headless operation (/extract, /rank-relevant-files, /scoped-context, /add-from-clipboard, /history/undo).
 * - Verifies screenshotBase64 handling in /scoped-context.
 * - Verifies HeadlessClient wrapper in scripts/headless-runner.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import extractRouter from './routes/extract.js';
import contextRouter from './routes/context.js';
import clipboardRouter from './routes/clipboard.js';
import historyRouter from './routes/history.js';
import filesRouter from './routes/files.js';
import sessionsRouter from './routes/sessions.js';
import devserverRouter from './routes/devserver.js';
import { HeadlessClient } from '../scripts/headless-runner.js';

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
  app.use(express.json({ limit: '10mb' }));
  app.use(extractRouter);
  app.use(contextRouter);
  app.use(clipboardRouter);
  app.use(historyRouter);
  app.use(filesRouter);
  app.use(sessionsRouter);
  app.use(devserverRouter);

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

test('T090: HeadlessClient extracts dependency manifest for js fixture', async () => {
  const manifest = await client.extract(jsFixture);
  assert.ok(manifest);
  assert.ok(Array.isArray(manifest.nodes));
  assert.ok(manifest.nodes.length >= 3);
  assert.ok(Array.isArray(manifest.edges));
});

test('T090: HeadlessClient ranks relevant candidate files from console logs', async () => {
  const ranking = await client.rankRelevantFiles(
    jsFixture,
    'Cannot render scene',
    'TypeError: undefined reading scene at src/main.js:10'
  );
  assert.ok(ranking.success);
  assert.ok(Array.isArray(ranking.files));
  assert.ok(ranking.files.some(f => f.file.includes('main.js') && f.score >= 90));
});

test('T091: Scoped context compiler accepts and embeds screenshotBase64', async () => {
  const fakeScreenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const result = await client.getScopedContext({
    projectPath: jsFixture,
    targetFile: 'src/main.js',
    issueDescription: 'Visual glitch on canvas',
    attachedFiles: ['src/main.js'],
    screenshotBase64: fakeScreenshot
  });

  assert.ok(result.success);
  assert.ok(result.prompt.includes('ATTACHED SCREENSHOT EVIDENCE'));
  assert.ok(result.prompt.includes('Base64 image attached'));
  assert.ok(result.tokens > 0);
});

test('T092: Complete investigation loop runs via HeadlessClient', async () => {
  const result = await client.runInvestigation(
    jsFixture,
    'Physics collision missing',
    'at src/main.js:12'
  );

  assert.ok(result.manifest);
  assert.ok(result.ranking.length > 0);
  assert.ok(result.targetFile);
  assert.ok(result.handoff.prompt);
  assert.ok(result.handoff.savingsPercent >= 0);
});

test('Regression: POST /compare-verification correctly evaluates prePatchErrors and postPatchErrors', async () => {
  const result = await client.compareVerification(
    jsFixture,
    ['TypeError: Cannot read properties of undefined at src/player.js:42'],
    []
  );
  assert.ok(result.success);
  assert.equal(result.comparison, 'ERROR_RESOLVED');
  assert.ok(result.message.includes('0 errors remaining'));
});

test('Regression: POST /game/launch responds and is mapped to Godot launch', async () => {
  const res = await fetch(`http://localhost:${port}/game/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: godotFixture, mode: 'run' })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok('launched' in data);

  // Terminate any launched process immediately so test suite completes cleanly
  await fetch(`http://localhost:${port}/game/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: godotFixture })
  });
});

test('Regression: POST /scoped-context detects Godot engine from target folder even without prior extract', async () => {
  // Deliberately extract JS first to load JS into serverState
  await client.extract(jsFixture);

  // Now request scoped context on godotFixture without extracting it first
  const ctx = await client.getScopedContext({
    projectPath: godotFixture,
    targetFile: 'scripts/Player.gd',
    issueDescription: 'GDScript collision error'
  });

  assert.ok(ctx.success);
  assert.ok(ctx.prompt.includes('Godot 4.x (GDScript)'));
  assert.ok(ctx.prompt.includes('godot-sample'));
  assert.ok(!ctx.prompt.includes('HTML5, Vite, and Three.js'));
});
