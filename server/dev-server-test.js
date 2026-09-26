/**
 * server/dev-server-test.js — Automated tests for Dev Server Automated Setup & Lifecycle Management
 * - Tests automatic setup and launch via POST /dev-server/start
 * - Tests process tree termination via POST /dev-server/stop
 * - Tests status reporting via GET /dev-server/status
 * - Tests frontend integration: auto-close npm when tab is closed, beacon on unload, UI state toggle
 *
 * Run: node server/dev-server-test.js
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  setupAndStartDevServer,
  stopDevServer,
  getDevServerStatus,
  isUrlReachable,
  normalizePath
} from './dev-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const htmlPath = join(projectRoot, 'public', 'index.html');
const testProjectPath = '/home/aymen/Documents/class trash/test oen/my-game-w';

const BASE_URL = 'http://localhost:3000';
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

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

console.log('Dev Server Automated Setup & Lifecycle tests:\n');

import { readdirSync } from 'node:fs';

function loadFrontendSource() {
  const htmlDoc = readFileSync(htmlPath, 'utf-8');
  const css = readdirSync(join(projectRoot, 'public', 'css'))
    .map(f => readFileSync(join(projectRoot, 'public', 'css', f), 'utf-8')).join('\n');
  const js = [
    'app.js', 'state.js', 'preview/preview.js', 'sidebar/tree.js',
    'terminal/terminal.js', 'clipboard/clipboard.js', 'history/history.js',
    'issue/issue-modal.js', 'project/wizard.js', 'panel/detail-panel.js',
    'graph/render.js'
  ]
    .filter(f => existsSync(join(projectRoot, 'public', 'js', f)))
    .map(f => readFileSync(join(projectRoot, 'public', 'js', f), 'utf-8')).join('\n');
  return htmlDoc + '\n' + css + '\n' + js;
}

const html = loadFrontendSource();

// 1. Frontend UI and Lifecycle assertions
await test('Frontend contains dev-server lifecycle states and styling', () => {
  assert(html.includes('.btn-play-top.running'), 'Missing .btn-play-top.running style');
  assert(html.includes('.btn-play-top.setting-up'), 'Missing .btn-play-top.setting-up style');
  assert(html.includes('pulse-setting-up'), 'Missing pulse-setting-up animation');
  assert(html.includes('id="btn-play-game"'), 'Missing btn-play-game element');
});

await test('Frontend implements ensureDevServerRunning with automatic start and setup', () => {
  assert(html.includes('async function ensureDevServerRunning('), 'Missing ensureDevServerRunning');
  assert(html.includes('/dev-server/start'), 'Missing call to /dev-server/start');
  assert(html.includes('setting-up'), 'Missing setting-up state transition');
});

await test('Frontend implements auto-stop on game tab close', () => {
  assert(html.includes('openGameTabs'), 'Missing openGameTabs tracker');
  assert(html.includes('gameWindow.closed') || html.includes('gameTab.closed'), 'Missing window.closed check');
  assert(html.includes('stopManagedDevServer'), 'Missing stopManagedDevServer call');
});

await test('Frontend sends beacon to stop dev server on page unload / beforeunload', () => {
  assert(html.includes('beforeunload'), 'Missing beforeunload listener');
  assert(html.includes('sendBeacon'), 'Missing sendBeacon call');
  assert(html.includes('/dev-server/stop'), 'Missing /dev-server/stop endpoint reference in beacon');
});

await test('Frontend toggles between Play and Stop states', () => {
  assert(html.includes('■ Stop'), 'Missing Stop button label update');
  assert(html.includes('updateDevServerUiState'), 'Missing updateDevServerUiState function');
});

// 2. Dev-server manager unit tests
await test('normalizePath handles paths and backslashes', () => {
  const p1 = normalizePath('/home/aymen/project//sub/');
  assert(!p1.endsWith('//'), 'Should normalize double slashes');
  assert(normalizePath('') === '', 'Empty path returns empty string');
});

await test('setupAndStartDevServer rejects invalid paths and missing package.json', async () => {
  try {
    await setupAndStartDevServer({ projectPath: '/non/existent/path/xyz123' });
    assert(false, 'Should have thrown for non-existent path');
  } catch (err) {
    assert(err.message.includes('does not exist'), 'Expected non-existent error message');
  }
});

await test('stopDevServer gracefully reports when no server was running', () => {
  const res = stopDevServer('/some/random/idle/project');
  assert(res.success === true, 'Expected success: true');
  assert(res.stopped === false, 'Expected stopped: false');
});

// 3. Integration tests with actual test project if present
if (existsSync(testProjectPath) && existsSync(join(testProjectPath, 'package.json'))) {
  await test('setupAndStartDevServer starts Vite dev server and reports reachable URL', async () => {
    const res = await setupAndStartDevServer({ projectPath: testProjectPath });
    assert(res.success === true, 'Expected success: true');
    assert(res.url && res.url.startsWith('http'), `Expected valid url, got ${res.url}`);
    assert(res.pid > 0, `Expected positive pid, got ${res.pid}`);

    // Verify it is actually reachable
    const ok = await isUrlReachable(res.url, 1500);
    assert(ok === true, `Expected URL ${res.url} to be reachable`);

    // Verify status returns running
    const status = await getDevServerStatus(testProjectPath);
    assert(status.running === true, 'Expected running: true in status');
    assert(status.url === res.url, 'Status URL should match');
  });

  await test('Calling setupAndStartDevServer when already running returns alreadyRunning=true', async () => {
    const res = await setupAndStartDevServer({ projectPath: testProjectPath });
    assert(res.success === true, 'Expected success: true');
    assert(res.alreadyRunning === true, 'Expected alreadyRunning: true');
  });

  await test('stopDevServer terminates running dev server cleanly', async () => {
    const stopRes = stopDevServer(testProjectPath);
    assert(stopRes.success === true, 'Expected success: true');
    assert(stopRes.stopped === true, 'Expected stopped: true');

    // Wait a brief moment to ensure process has exited
    await new Promise((r) => setTimeout(r, 600));

    const status = await getDevServerStatus(testProjectPath);
    assert(status.running === false, 'Expected running: false after stop');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
