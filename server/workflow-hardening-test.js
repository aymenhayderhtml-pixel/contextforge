/**
 * server/workflow-hardening-test.js
 *
 * Automated verification for Phase 26: Post-v0.0.3 Practical Workflow Hardening (T107-T110).
 * Verifies:
 * 1. T107: Gate "Fix This Issue" compilation on non-empty issue description or captured runtime error (HTTP 400).
 * 2. T108: Interface stub extraction handles SceneManager, export default class, methods with default params.
 * 3. T109: Incremental Phase 0/1 scoping in new-project scaffold prompt anchored to TASKS.md.
 * 4. T110: Scaffold prompt context completeness (scaffolded file contents) and CONTEXT INSUFFICIENT protocol.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import contextRouter from './routes/context.js';
import extractRouter from './routes/extract.js';
import { HeadlessClient } from '../scripts/headless-runner.js';
import { generateJsOutline, clearOutlineCache } from './outline.js';
import { scaffoldNewProject } from './project-init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const jsFixture = join(root, 'test-fixtures', 'js-sample');

let server;
let port;
let client;

before(async () => {
  clearOutlineCache();
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

// ── T107: "Fix This Issue" Gatekeeping ────────────────────────────────────────

test('T107: POST /scoped-context rejects compilation when both issueDescription and consoleLogs are empty (HTTP 400)', async () => {
  await client.extract(jsFixture);

  const res = await fetch(`http://localhost:${port}/scoped-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      issueDescription: '',
      consoleLogs: ''
    })
  });

  assert.equal(res.status, 400, 'Expected HTTP 400 when compiling with no issue description and no console logs');
  const body = await res.json();
  assert(body.error && body.error.includes('Cannot compile fix handoff'), 'Expected descriptive error message');
});

test('T107: POST /scoped-context allows compilation when issueDescription is provided', async () => {
  const res = await fetch(`http://localhost:${port}/scoped-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      issueDescription: 'Player takes damage improperly',
      consoleLogs: ''
    })
  });

  assert.equal(res.status, 200, 'Expected HTTP 200 when issueDescription is non-empty');
  const body = await res.json();
  assert(body.prompt && body.prompt.includes('Player takes damage improperly'));
});

test('T107: POST /scoped-context allows compilation when consoleLogs has error lines', async () => {
  const res = await fetch(`http://localhost:${port}/scoped-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      issueDescription: '',
      consoleLogs: 'TypeError: Cannot read property "clamp" of undefined at src/player.js:20:15'
    })
  });

  assert.equal(res.status, 200, 'Expected HTTP 200 when console error is provided');
  const body = await res.json();
  assert(body.prompt && body.prompt.includes('TypeError'));
});

test('T107: POST /scoped-context allows compilation with allowEmpty flag for testing/headless', async () => {
  const res = await fetch(`http://localhost:${port}/scoped-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      issueDescription: '',
      consoleLogs: '',
      allowEmpty: true
    })
  });

  assert.equal(res.status, 200, 'Expected HTTP 200 when allowEmpty is true');
});

// ── T108: SceneManager & Class Method Interface Outline ───────────────────────

test('T108: SceneManager interface stub in js-sample fixture extracts all methods', () => {
  const sceneManagerContent = readFileSync(join(jsFixture, 'src', 'scene-manager.js'), 'utf8');
  const outline = generateJsOutline(sceneManagerContent);

  assert(outline.includes('export class SceneManager {'), 'Missing SceneManager class declaration');
  assert(outline.includes('constructor()'), 'Missing constructor()');
  assert(outline.includes('addEntity(entity)'), 'Missing addEntity(entity)');
  assert(outline.includes('removeEntity(entity)'), 'Missing removeEntity(entity)');
  assert(outline.includes('start()'), 'Missing start()');
  assert(outline.includes('stop()'), 'Missing stop()');
  assert(outline.includes('_loop()'), 'Missing _loop()');
  assert(outline.includes('export function createScene(name)'), 'Missing createScene(name)');
});

test('T108: generateJsOutline handles export default class, extends, and methods without function keyword', () => {
  const code = `
export default class BaseSceneManager extends EventEmitter {
  constructor(options = { debug: false }) {
    super();
    this.options = options;
  }
  loadTrack(trackName) {
    return true;
  }
}
class HelperClass {
  compute() {}
}
`;
  const outline = generateJsOutline(code);
  assert(outline.includes('export default class BaseSceneManager extends EventEmitter {'));
  assert(outline.includes('constructor(options = { debug: false })'));
  assert(outline.includes('loadTrack(trackName)'));
  assert(outline.includes('class HelperClass {'));
  assert(outline.includes('compute()'));
});

test('T108: generateJsOutline handles methods with default parameter values (objects, callbacks, calls)', () => {
  const code = `
export class MathHelper {
  clamp(value, min = 0, max = 100) {}
  find(predicate = () => true) {}
  init(config = getDefaultConfig()) {}
  transform({ x = 0, y = 0 } = {}) {}
}
`;
  const outline = generateJsOutline(code);
  assert(outline.includes('clamp(value, min = 0, max = 100)'));
  assert(outline.includes('find(predicate = () => true)'));
  assert(outline.includes('init(config = getDefaultConfig())'));
  assert(outline.includes('transform({ x = 0, y = 0 } = {})'));
});

test('T108: generateJsOutline handles export default function and export default object', () => {
  const code = `
export default function setupEngine(options = { fps: 60 }) {
  return true;
}
export default {
  version: '2.0',
  reset() {}
};
`;
  const outline = generateJsOutline(code);
  assert(outline.includes('export default function setupEngine(options = { fps: 60 })'));
  assert(outline.includes('export default {'));
  assert(outline.includes('reset()'));
});

// ── T109 & T110: Scaffold Prompt Phased Scoping & Context Completeness ─────────

test('T109: scaffoldNewProject returns scaffoldedFiles with relative paths and contents', async () => {
  const testDir = join(tmpdir(), 'cf-scaffold-test-' + Date.now());
  try {
    const result = await scaffoldNewProject({ targetFolder: testDir, engine: 'js', projectName: 'My Space Game' });
    assert(result.scaffoldedFiles && Array.isArray(result.scaffoldedFiles), 'Missing scaffoldedFiles array');
    assert(result.scaffoldedFiles.length > 0, 'scaffoldedFiles should not be empty');

    const tasksFile = result.scaffoldedFiles.find(f => f.path === 'TASKS.md');
    assert(tasksFile, 'TASKS.md must be included in scaffoldedFiles');
    assert(tasksFile.content.includes('Phase 1'), 'TASKS.md must contain Phase 1');
    assert(tasksFile.content.includes('[ ]'), 'TASKS.md must contain task checkboxes');

    const pkgFile = result.scaffoldedFiles.find(f => f.path === 'package.json');
    assert(pkgFile, 'package.json must be included in scaffoldedFiles');
    assert(pkgFile.content.includes('"name": "my-space-game"'));
  } finally {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  }
});

test('T109 & T110: wizard generateScaffoldPrompt includes TASKS.md phased scoping and scaffolded files', async () => {
  // Dynamically load generateScaffoldPrompt from wizard.js
  const wizardModule = await import('../public/js/project/wizard.js');
  const generateScaffoldPrompt = wizardModule.generateScaffoldPrompt;

  const sampleState = {
    projectName: 'Cosmic Racer',
    engine: 'js',
    targetFolder: '/home/user/games/cosmic-racer',
    gameIdea: 'A futuristic anti-gravity racing game with tight drift controls.',
    scaffoldedFiles: [
      { path: 'package.json', content: '{\n  "name": "cosmic-racer"\n}' },
      { path: 'TASKS.md', content: '# Tasks\n## Phase 1 — Foundation\n- [ ] T001: Setup canvas' }
    ]
  };

  const prompt = generateScaffoldPrompt(sampleState);

  // T109 checks:
  assert(prompt.includes('PHASED INCREMENTAL WORK'), 'Prompt must instruct phased incremental work');
  assert(prompt.includes('Implement ONLY Phase 1 (or Phase 0) Foundation tasks'), 'Prompt must scope to Phase 1/0 Foundation only');
  assert(prompt.includes('Do NOT generate subsequent phases'), 'Prompt must prohibit generating subsequent phases');

  // T110 checks:
  assert(prompt.includes('### FILE: package.json'), 'Prompt must include scaffolded package.json file block');
  assert(prompt.includes('"name": "cosmic-racer"'), 'Prompt must include package.json content');
  assert(prompt.includes('### FILE: TASKS.md'), 'Prompt must include scaffolded TASKS.md file block');
  assert(prompt.includes('T001: Setup canvas'), 'Prompt must include TASKS.md content');
  assert(prompt.includes('CONTEXT INSUFFICIENT PROTOCOL'), 'Prompt must include CONTEXT INSUFFICIENT protocol');
  assert(prompt.includes('CONTEXT INSUFFICIENT: Need to know'), 'Prompt must specify CONTEXT INSUFFICIENT syntax');
});
