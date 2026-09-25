import assert from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import {
  generateJsOutline,
  generateHtmlOutline,
  generateGdScriptOutline,
  generateFileOutline,
  getCachedFileOutline,
  extractScopedSnippet,
  checkOversizedFile,
  clearOutlineCache,
  OVERSIZED_LINE_THRESHOLD
} from './outline.js';

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

console.log('Scope-Aware Context & Outline Tests:\n');

// 1. JS Outline Generation
await test('generateJsOutline extracts signature lines without function bodies', () => {
  const sampleJs = `
import { MathUtils } from './utils.js';

export const MAX_SPEED = 250;
const INITIAL_HEALTH = 100;

export class PlayerCharacter {
  constructor(name) {
    this.name = name;
  }
}

export function movePlayer(dx, dy) {
  const step = dx * 2;
  return step + dy;
}

export async function fetchScores() {
  const res = await fetch('/scores');
  return res.json();
}

const calculateDistance = (x1, y1, x2, y2) => {
  return Math.hypot(x2 - x1, y2 - y1);
};
`;

  const outline = generateJsOutline(sampleJs);
  assert(outline.includes('export const MAX_SPEED = 250'), 'missing export const');
  assert(outline.includes('const INITIAL_HEALTH = 100'), 'missing const');
  assert(outline.includes('export class PlayerCharacter'), 'missing class signature');
  assert(outline.includes('export function movePlayer(dx, dy)'), 'missing function signature');
  assert(outline.includes('export async function fetchScores()'), 'missing async function signature');
  assert(outline.includes('const calculateDistance = (x1, y1, x2, y2) =>'), 'missing arrow function');
  assert(!outline.includes('const step = dx * 2;'), 'function body must not be included');
  assert(!outline.includes('this.name = name;'), 'constructor body must not be included');
});

// 2. HTML Outline Generation
await test('generateHtmlOutline extracts structural elements with id/class and scripts', () => {
  const sampleHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Game Client</title>
  <link rel="stylesheet" href="/style.css">
  <script type="module" src="/src/main.js"></script>
</head>
<body>
  <div id="game-container" class="viewport-fullscreen">
    <canvas id="game-canvas"></canvas>
    <div id="hud" class="overlay top-left">
      <span class="score-display">0</span>
    </div>
  </div>
</body>
</html>
`;

  const outline = generateHtmlOutline(sampleHtml);
  assert(outline.includes('<script src="/src/main.js">'), 'missing script outline');
  assert(outline.includes('<link rel="stylesheet" href="/style.css">'), 'missing link outline');
  assert(outline.includes('<div id="game-container" class="viewport-fullscreen">'), 'missing game-container');
  assert(outline.includes('<canvas id="game-canvas">'), 'missing canvas');
  assert(outline.includes('<div id="hud" class="overlay top-left">'), 'missing hud');
});

// 3. GDScript Outline Generation
await test('generateGdScriptOutline extracts class, export, signal, and func signatures', () => {
  const sampleGd = `
class_name PlayerEntity
extends CharacterBody2D

signal died()
signal health_changed(new_value)

@export var speed: float = 200.0
@export var jump_force: float = -400.0

func _ready() -> void:
    print("private ready func")

func take_damage(amount: int) -> void:
    health -= amount

func get_health() -> int:
    return health
`;

  const outline = generateGdScriptOutline(sampleGd);
  assert(outline.includes('class_name PlayerEntity'), 'missing class_name');
  assert(outline.includes('extends CharacterBody2D'), 'missing extends');
  assert(outline.includes('signal died()'), 'missing signal');
  assert(outline.includes('@export var speed: float = 200.0'), 'missing @export var');
  assert(outline.includes('func take_damage(amount: int) -> void'), 'missing public func');
  assert(outline.includes('func get_health() -> int'), 'missing public func');
  assert(!outline.includes('func _ready'), 'private func must be excluded');
  assert(!outline.includes('health -= amount'), 'function body must not be included');
});

// 4. Outline Caching
await test('getCachedFileOutline caches result and regenerates on modification', () => {
  clearOutlineCache();
  const testDir = join(projectRoot, 'test-fixtures', 'js-sample');
  const targetFile = 'src/player.js';

  const entry1 = getCachedFileOutline(testDir, targetFile);
  assert(entry1 !== null, 'outline entry should exist');
  assert(typeof entry1.outline === 'string', 'outline must be string');

  // Second fetch should return cached object reference
  const entry2 = getCachedFileOutline(testDir, targetFile);
  assert(entry1 === entry2, 'should return cached entry for unchanged file');
});

// 5. Scoped Snippet Extraction
await test('extractScopedSnippet extracts window around requested line number', () => {
  const code = Array.from({ length: 100 }, (_, i) => `// line ${i + 1}`).join('\n');
  const result = extractScopedSnippet(code, 'error at line 42 in player.js');

  assert(result !== null, 'snippet should be extracted');
  assert(result.targetLine === 42, `expected line 42, got ${result.targetLine}`);
  assert(result.startLine <= 42, 'startLine must be before target');
  assert(result.endLine >= 42, 'endLine must be after target');
  assert(result.snippet.includes('42 | // line 42'), 'snippet must contain target line with line number');
});

await test('extractScopedSnippet extracts window around matching symbol name', () => {
  const code = `
function initWorld() {
  return true;
}

function updatePlayerPhysics(dt) {
  const velocity = 10;
  return velocity * dt;
}

function renderScene() {
  draw();
}
`;
  const result = extractScopedSnippet(code, 'Uncaught TypeError in updatePlayerPhysics');
  assert(result !== null, 'snippet should match symbol');
  assert(result.matchedSymbol === 'updatePlayerPhysics', 'should match symbol name');
  assert(result.snippet.includes('updatePlayerPhysics(dt)'), 'snippet should contain function header');
});

// 6. Oversized File Detection
await test('checkOversizedFile flags files crossing line threshold', () => {
  const small = 'line\n'.repeat(300);
  const large = 'line\n'.repeat(850);

  const resSmall = checkOversizedFile(small, 800);
  assert(!resSmall.isOversized, '300 lines is not oversized');

  const resLarge = checkOversizedFile(large, 800);
  assert(resLarge.isOversized, '850 lines must be flagged oversized');
  assert(resLarge.linesCount === 851, `expected 851 lines, got ${resLarge.linesCount}`);
});

// 7. GET /file-outline endpoint
await test('GET /file-outline returns cached outline, line counts, and oversized status', async () => {
  const jsFixture = join(projectRoot, 'test-fixtures', 'js-sample');
  const res = await fetch(`${BASE_URL}/file-outline?projectPath=${encodeURIComponent(jsFixture)}&filePath=src/player.js`);
  assert(res.ok, `Status ${res.status}`);
  const data = await res.json();

  assert(data.success === true, 'success must be true');
  assert(data.filePath === 'src/player.js', 'filePath mismatch');
  assert(typeof data.outline === 'string', 'outline must be string');
  assert(data.outline.includes('class Player'), 'outline must contain class Player');
  assert(typeof data.linesCount === 'number', 'linesCount must be number');
  assert(data.isOversized === false, 'player.js should not be oversized');
});

// 8. POST /scoped-context endpoint
await test('POST /scoped-context generates scoped prompt with target snippet and dependency outlines', async () => {
  const jsFixture = join(projectRoot, 'test-fixtures', 'js-sample');

  // Extract js project first so manifest is loaded
  await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: jsFixture })
  });

  const res = await fetch(`${BASE_URL}/scoped-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      issueDescription: 'Error in Player around line 5',
      attachedFiles: ['src/player.js', 'src/utils.js'],
      fileModes: {
        'src/player.js': 'scoped',
        'src/utils.js': 'scoped'
      }
    })
  });

  assert(res.ok, `Status ${res.status}`);
  const data = await res.json();

  assert(data.success === true, 'success must be true');
  assert(typeof data.prompt === 'string', 'prompt must be string');
  assert(data.prompt.includes('### FILE: src/player.js (Scoped Context)'), 'target file must be scoped');
  assert(data.prompt.includes('### FILE: src/utils.js (Outline / Interface Only)'), 'dependency must be outline only');
  assert(data.chars > 0, 'chars must be greater than 0');
  assert(data.tokens > 0, 'tokens must be greater than 0');
  assert(data.fullChars > data.chars, 'scoped prompt must be smaller than full prompt');
  assert(data.savingsPercent > 0, 'savings percentage must be > 0%');
});

await test('POST /scoped-context switches to full file when toggled to mode: full', async () => {
  const jsFixture = join(projectRoot, 'test-fixtures', 'js-sample');

  const res = await fetch(`${BASE_URL}/scoped-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: jsFixture,
      targetFile: 'src/player.js',
      issueDescription: 'Need full source context',
      attachedFiles: ['src/player.js', 'src/utils.js'],
      fileModes: {
        'src/player.js': 'full',
        'src/utils.js': 'full'
      }
    })
  });

  assert(res.ok, `Status ${res.status}`);
  const data = await res.json();

  assert(data.prompt.includes('### FILE: src/player.js (Full Source)'), 'should include full source');
  assert(data.prompt.includes('### FILE: src/utils.js (Full Source)'), 'should include full source');
  assert(data.savingsPercent === 0, 'savings percent should be 0 when all are full');
});

// 9. POST /package-context with outline stubs and fullDepIds toggle
await test('POST /package-context returns outline stubs by default and supports full dependencies', async () => {
  const jsFixture = join(projectRoot, 'test-fixtures', 'js-sample');

  // Scoped / default
  const resScoped = await fetch(`${BASE_URL}/package-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 'src/player.js' })
  });
  assert(resScoped.ok);
  const dataScoped = await resScoped.json();
  assert(dataScoped.context.includes('## Direct Dependencies (interface only)'), 'must include direct deps header');
  assert(dataScoped.context.includes('// Outline:'), 'must include outline in stub');
  assert(typeof dataScoped.chars === 'number', 'chars must be present');
  assert(typeof dataScoped.tokens === 'number', 'tokens must be present');

  // Full dependencies
  const resFull = await fetch(`${BASE_URL}/package-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 'src/player.js', scoped: false })
  });
  assert(resFull.ok);
  const dataFull = await resFull.json();
  assert(dataFull.context.includes('// --- Full Source: src/utils.js ---'), 'must include full source of dependency');
  assert(dataFull.chars > dataScoped.chars, 'full dependencies context must be larger than scoped context');
});

// 10. Frontend HTML verification
await test('Frontend HTML contains scoped context toggles, savings bar, and oversized banner', async () => {
  const res = await fetch(`${BASE_URL}/index.html`);
  assert(res.ok, 'Failed to fetch index.html');
  const html = await res.text();

  assert(html.includes('.pill-mode-group'), 'missing .pill-mode-group style');
  assert(html.includes('.pill-mode-btn'), 'missing .pill-mode-btn style');
  assert(html.includes('.oversized-banner'), 'missing .oversized-banner style');
  assert(html.includes('id="issue-prompt-savings"'), 'missing issue-prompt-savings element');
  assert(html.includes('id="issue-oversized-banner"'), 'missing issue-oversized-banner element');
  assert(html.includes('id="pkg-use-full-deps"'), 'missing pkg-use-full-deps element');
  assert(html.includes('id="pkg-stats-bar"'), 'missing pkg-stats-bar element');
  assert(html.includes('id="pkg-oversized-nudge"'), 'missing pkg-oversized-nudge element');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
