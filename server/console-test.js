import assert from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  recordConsoleLog,
  getConsoleLogs,
  clearConsoleLogs,
  isErrorLine,
  runGodotCheck,
  runJsCheck,
  ensureDiagnosticsBridge
} from './console-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
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

console.log('Console Capture, Filter & Report Integration tests (Phase 14):\n');

const testProjectPath = '/tmp/cf-console-test-proj';

// 1. isErrorLine detection
await test('isErrorLine correctly detects error lines vs normal info lines', () => {
  assert(isErrorLine('SCRIPT ERROR: Parse Error: Could not resolve external class member "velocity".'));
  assert(isErrorLine('ERROR: Failed to load script "res://scripts/main.gd" with error "Parse error".'));
  assert(isErrorLine('          at: GDScript::reload (res://scripts/main.gd:47)'));
  assert(isErrorLine('Error at (47, 5): The variable type is being inferred from a Variant value'));
  assert(isErrorLine('Uncaught TypeError: Cannot read property of undefined'));
  assert(!isErrorLine('Godot Engine v4.7.stable.official.5b4e0cb0f - https://godotengine.org'));
  assert(!isErrorLine('Vulkan 1.4.335 - Forward+ - Using Device #0'));
  assert(!isErrorLine('VITE v5.4.2 ready in 210 ms'));
});

// 2. recordConsoleLog & getConsoleLogs
await test('recordConsoleLog splits lines and separates all vs red-only logs', () => {
  clearConsoleLogs(testProjectPath);
  const sampleOutput = `Godot Engine v4.7.stable
Vulkan 1.4.335 - Forward+
SCRIPT ERROR: Parse Error: Could not resolve external class member "velocity".
          at: GDScript::reload (res://scripts/main.gd:63)
ERROR: Failed to load script "res://scripts/main.gd" with error "Parse error".
Project loaded successfully`;

  recordConsoleLog(testProjectPath, sampleOutput);
  const data = getConsoleLogs(testProjectPath);

  assert.strictEqual(data.totalCount, 6, `Expected 6 total lines, got ${data.totalCount}`);
  assert.strictEqual(data.errorCount, 3, `Expected 3 error lines, got ${data.errorCount}`);
  assert(data.redLogs.every(l => l.isError), 'All redLogs must have isError = true');
  assert(data.redLogs[0].text.includes('SCRIPT ERROR: Parse Error'), 'First red line must be SCRIPT ERROR');
});

// 3. clearConsoleLogs
await test('clearConsoleLogs resets log buffer for project', () => {
  clearConsoleLogs(testProjectPath);
  const data = getConsoleLogs(testProjectPath);
  assert.strictEqual(data.totalCount, 0);
  assert.strictEqual(data.errorCount, 0);
});

// 4. runGodotCheck on real Godot project
const userGodotProject = existsSync('/home/aymen/Documents/class trash/test oen/v')
  ? '/home/aymen/Documents/class trash/test oen/v'
  : '/home/aymen/Documents/class trash/test oen/my-game-godot';
if (existsSync(userGodotProject)) {
  await test('runGodotCheck inspects real Godot project and captures compiler errors', () => {
    clearConsoleLogs(userGodotProject);
    runGodotCheck(userGodotProject);
    const data = getConsoleLogs(userGodotProject);
    assert(data.errorCount > 0, `Expected errors, got ${data.errorCount}`);
    const hasErr = data.redLogs.some(l => l.text.includes('SCRIPT ERROR') || l.text.includes('ERROR:') || l.text.includes('velocity'));
    assert(hasErr, 'Should detect script or compiler error from Godot project');
  });
}

// 5. GET /console-logs HTTP endpoint
await test('GET /console-logs returns json with logs and redLogs', async () => {
  const res = await fetch(`${BASE_URL}/console-logs?projectPath=${encodeURIComponent(userGodotProject || testProjectPath)}`);
  assert(res.ok, `HTTP status ${res.status}`);
  const data = await res.json();
  assert(data.success, 'Response must have success: true');
  assert(Array.isArray(data.logs), 'logs must be array');
  assert(Array.isArray(data.redLogs), 'redLogs must be array');
  assert(typeof data.totalCount === 'number', 'totalCount must be number');
  assert(typeof data.errorCount === 'number', 'errorCount must be number');
});

// 6. POST /scoped-context attaches console output when provided
await test('POST /scoped-context embeds CONSOLE OUTPUT block in prompt', async () => {
  const godotFixture = join(projectRoot, 'test-fixtures', 'godot-sample');
  const res = await fetch(`${BASE_URL}/scoped-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: godotFixture,
      issueDescription: 'Player fails to move in scene',
      consoleLogs: 'SCRIPT ERROR: Parse Error: Could not resolve external class member "velocity".\n  at: GDScript::reload (res://scripts/main.gd:63)',
      consoleMode: 'red_only'
    })
  });

  assert(res.ok, `HTTP status ${res.status}`);
  const data = await res.json();
  assert(data.success, 'Response must have success: true');
  assert(data.prompt.includes('CONSOLE OUTPUT / ERROR LOG:'), 'Prompt must contain CONSOLE OUTPUT header');
  assert(data.prompt.includes('SCRIPT ERROR: Parse Error: Could not resolve external class member "velocity"'), 'Prompt must contain the error text');
});

// 7. Frontend HTML contains Console button, badge, dropdown item, and modal elements
await test('Frontend HTML contains Console controls and Report Issue console section with All / Red-only buttons', () => {
  const htmlPath = join(projectRoot, 'public', 'index.html');
  const html = readFileSync(htmlPath, 'utf-8');

  assert(html.includes('id="btn-console"'), 'Missing btn-console button');
  assert(html.includes('id="console-badge"'), 'Missing console-badge badge');
  assert(html.includes('id="menu-console"'), 'Missing menu-console dropdown item');
  assert(html.includes('id="issue-console-box"'), 'Missing issue-console-box element');
  assert(html.includes('id="btn-console-filter-all"'), 'Missing btn-console-filter-all button');
  assert(html.includes('id="btn-console-filter-red"'), 'Missing btn-console-filter-red button');
  assert(html.includes('id="issue-include-console"'), 'Missing issue-include-console checkbox');
  assert(html.includes('function openConsoleModal('), 'Missing openConsoleModal function');
  assert(html.includes('function updateConsoleBadge('), 'Missing updateConsoleBadge function');
  assert(html.includes('function fetchConsoleLogs('), 'Missing fetchConsoleLogs function');
});

// 8. JS & Browser Error line detection
await test('isErrorLine correctly detects browser JS errors and stack lines', () => {
  assert(isErrorLine('Uncaught TypeError: Cannot read properties of undefined (reading \'update\')'));
  assert(isErrorLine('ReferenceError: carMesh is not defined'));
  assert(isErrorLine('SyntaxError: Unexpected token \'}\''));
  assert(isErrorLine('          at: (src/player-car.js:42:15)'));
  assert(isErrorLine('    at PlayerCar.update (src/player-car.js:42:15)'));
  assert(isErrorLine('    at http://localhost:5173/src/main.js:12:5'));
  assert(isErrorLine('BROWSER ERROR: Uncaught Error in game loop'));
  assert(!isErrorLine('[Vite] connecting...'));
  assert(!isErrorLine('[Vite] connected.'));
});

// 9. POST /client-log endpoint records browser runtime error and surfaces in GET /console-logs
await test('POST /client-log records browser error and GET /console-logs includes it in redLogs', async () => {
  const browserTestProj = '/tmp/cf-browser-test-proj';
  if (!existsSync(browserTestProj)) mkdirSync(browserTestProj, { recursive: true });
  await fetch(`${BASE_URL}/console-logs?projectPath=${encodeURIComponent(browserTestProj)}&clear=true`);

  const payload = {
    projectPath: browserTestProj,
    level: 'error',
    message: 'SCRIPT ERROR: TypeError: Cannot read properties of undefined (reading \'speed\')\n          at: (src/player-car.js:42:15)\n          at PlayerCar.update (src/player-car.js:42:15)',
    source: 'src/player-car.js',
    lineno: 42
  };

  const postRes = await fetch(`${BASE_URL}/client-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert(postRes.ok, `POST /client-log status ${postRes.status}`);

  const getRes = await fetch(`${BASE_URL}/console-logs?projectPath=${encodeURIComponent(browserTestProj)}`);
  assert(getRes.ok, `GET /console-logs status ${getRes.status}`);
  const data = await getRes.json();

  assert.strictEqual(data.errorCount, 3, `Expected 3 error lines recorded, got ${data.errorCount}`);
  assert(data.redLogs.some(l => l.text.includes('TypeError')), 'redLogs should contain TypeError');
  assert(data.redLogs.some(l => l.text.includes('PlayerCar.update')), 'redLogs should contain stack line');
});

// 10. ensureDiagnosticsBridge injects bridge script tag into HTML
await test('ensureDiagnosticsBridge injects bridge script tag into HTML', () => {
  const bridgeTestDir = '/tmp/cf-bridge-test-dir';
  if (!existsSync(bridgeTestDir)) mkdirSync(bridgeTestDir, { recursive: true });
  const htmlPath = join(bridgeTestDir, 'index.html');
  writeFileSync(htmlPath, '<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>');
  ensureDiagnosticsBridge(bridgeTestDir);
  const content = readFileSync(htmlPath, 'utf-8');
  assert(content.includes('contextforge-bridge.js'), 'Bridge script should be injected');
});

// 11. CORS preflight (OPTIONS) returns 204 with Access-Control headers
await test('OPTIONS /client-log returns 204 with CORS headers for cross-origin game clients', async () => {
  const optRes = await fetch(`${BASE_URL}/client-log`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type'
    }
  });
  assert.strictEqual(optRes.status, 204, `Expected status 204 for OPTIONS preflight, got ${optRes.status}`);
  assert.strictEqual(optRes.headers.get('access-control-allow-origin'), '*', 'Expected Access-Control-Allow-Origin: *');
  assert(optRes.headers.get('access-control-allow-methods').includes('POST'), 'Expected Access-Control-Allow-Methods to include POST');
});

// 12. Cross-origin POST /client-log with browser error pattern
await test('Cross-origin POST /client-log receives game loop error and returns CORS headers', async () => {
  const browserTestProj = '/tmp/cf-browser-test-proj';
  const postRes = await fetch(`${BASE_URL}/client-log`, {
    method: 'POST',
    headers: {
      'Origin': 'http://localhost:5173',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      projectPath: browserTestProj,
      level: 'error',
      message: 'SCRIPT ERROR: can\'t access property "length", this.projectiles is undefined\n          at: (scene-manager.js:1212:15)',
      source: 'http://localhost:5173/src/scene-manager.js',
      lineno: 1212
    })
  });

  assert(postRes.ok, `POST /client-log status ${postRes.status}`);
  assert.strictEqual(postRes.headers.get('access-control-allow-origin'), '*', 'Expected Access-Control-Allow-Origin: * on POST');

  const getRes = await fetch(`${BASE_URL}/console-logs?projectPath=${encodeURIComponent(browserTestProj)}`);
  const data = await getRes.json();
  assert(data.redLogs.some(l => l.text.includes('this.projectiles is undefined')), 'redLogs must contain game runtime error');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);


