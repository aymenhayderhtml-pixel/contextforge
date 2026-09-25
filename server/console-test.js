import assert from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  recordConsoleLog,
  getConsoleLogs,
  clearConsoleLogs,
  isErrorLine,
  runGodotCheck
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
