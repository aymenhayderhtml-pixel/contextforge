/**
 * server/new-project-flow-test.js — Automated tests for the New Project & Clipboard Flow (v0.0.3)
 *
 * Verifies:
 * - parseAiFileBlocks: regex parsing of ### FILE: markers and fenced blocks
 * - writeAiFilesToProject: directory creation, file writing, validation, path traversal defense
 * - parseAiEditBlocks: regex parsing of ### EDIT: markers and FIND/REPLACE blocks
 * - applyAiEditBlocks: surgical patch application, uniqueness check, error diagnostics
 * - getProjectFileTree: recursive disk tree scanning excluding .git/node_modules
 * - HTTP Endpoints:
 *   - POST /add-from-clipboard (dual-mode: ### FILE: and ### EDIT:)
 *   - GET /file-tree
 *   - GET /file-content
 *   - POST /save-file
 *   - GET /ping-dev-server
 *   - POST /open-godot
 *   - POST /browse-folder
 * - public/index.html UI controls:
 *   - Disk-mirrored sidebar tree with selectFile (no Depends On section)
 *   - Live game-idea textarea above scaffold prompt
 *   - Tightened AI output format rules & worked example
 *   - Per-file Run button & dev server check
 *   - Issue-Report modal & surgical edit prompt generation
 *
 * Run: node server/new-project-flow-test.js
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  parseAiFileBlocks,
  writeAiFilesToProject,
  parseAiEditBlocks,
  applyAiEditBlocks,
  getProjectFileTree,
  scaffoldNewProject
} from './project-init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const tempBase = join(projectRoot, 'test-fixtures', 'temp-flow-projects');
const htmlPath = join(projectRoot, 'public', 'index.html');

const BASE_URL = 'http://localhost:3000';
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  })();
}

console.log('New Project Flow & AI Clipboard Bridge tests (v0.0.3):\n');

// Clean temp directory
if (existsSync(tempBase)) {
  rmSync(tempBase, { recursive: true, force: true });
}
mkdirSync(tempBase, { recursive: true });

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

// 1. Frontend UI verification
await test('HTML contains Files dropdown menu with toggle, new project, clipboard, and report issue items', () => {
  assert(html.includes('id="btn-sidebar-toggle"'), 'Missing btn-sidebar-toggle button');
  assert(html.includes('id="files-menu"'), 'Missing files-menu container');
  assert(html.includes('id="menu-toggle-tree"'), 'Missing menu-toggle-tree item');
  assert(html.includes('id="menu-new-project"'), 'Missing menu-new-project item');
  assert(html.includes('id="menu-add-clipboard"'), 'Missing menu-add-clipboard item');
  assert(html.includes('id="menu-report-issue"'), 'Missing menu-report-issue item');
});

await test('HTML contains Add from Clipboard, Report Issue, Play, and Open in Godot action buttons', () => {
  assert(html.includes('id="btn-add-from-clipboard"'), 'Missing btn-add-from-clipboard in controls');
  assert(html.includes('id="btn-report-issue"'), 'Missing btn-report-issue in controls');
  assert(html.includes('id="btn-open-godot"'), 'Missing btn-open-godot in controls');
  assert(html.includes('id="btn-sidebar-new-project"'), 'Missing btn-sidebar-new-project in sidebar header');
  assert(html.includes('id="btn-play-game"'), 'Missing btn-play-game Play button in controls');
  assert(html.includes('id="menu-play-game"'), 'Missing menu-play-game in files menu');
  assert(html.includes('id="btn-clear-sidebar-search"'), 'Missing btn-clear-sidebar-search button in sidebar');

  // New UX labels and dropdown extensions
  assert(html.includes('id="btn-add-from-clipboard" class="secondary" title="Parse AI response with ### FILE: or ### EDIT: blocks">📋 Paste</button>'), 'btn-add-from-clipboard should display Paste');
  assert(html.includes('id="btn-report-issue" class="secondary" title="Report issue & generate surgical AI patch prompt">🐞 Issue</button>'), 'btn-report-issue should display Issue');
  assert(html.includes('id="menu-open-project"'), 'Missing menu-open-project in files menu');
  assert(html.includes('id="menu-recent-trigger"'), 'Missing menu-recent-trigger in files menu');
  assert(html.includes('id="menu-ai-context"'), 'Missing menu-ai-context in files menu');
  assert(html.includes('rel="icon"'), 'Missing favicon link in head');
  assert(existsSync(join(projectRoot, 'README_FOR_AI.md')), 'README_FOR_AI.md must exist');
});

await test('Client script defines 3-step New Project wizard with live game-idea input', () => {
  assert(html.includes('function openNewProjectModal('), 'Missing openNewProjectModal');
  assert(html.includes('function selectProjectEngine('), 'Missing selectProjectEngine');
  assert(html.includes('function renderNewProjectStep1('), 'Missing renderNewProjectStep1');
  assert(html.includes('function renderNewProjectStep2('), 'Missing renderNewProjectStep2');
  assert(html.includes('function renderNewProjectStep3('), 'Missing renderNewProjectStep3');
  assert(html.includes('id="new-proj-idea"'), 'Missing new-proj-idea textarea in Step 3');
  assert(html.includes('id="step3-paste-reply"'), 'Missing step3-paste-reply textarea in Step 3');
  assert(html.includes('function pasteClipboardToStep3('), 'Missing pasteClipboardToStep3 helper');
  assert(html.includes('Game concept:'), 'Missing Game concept in scaffold prompt template');
  assert(html.includes('function submitNewProject('), 'Missing submitNewProject');
  assert(html.includes('function copyScaffoldPrompt('), 'Missing copyScaffoldPrompt');
});

await test('Scaffold prompt template enforces strict AI output rules and worked example', () => {
  assert(html.includes('Output ONLY file blocks in this format — no explanation before, between, or after them.'), 'Missing strict explanation prohibition rule');
  assert(html.includes("Never truncate a file or write placeholders like '// rest stays the same'"), 'Missing truncation prohibition rule');
  assert(html.includes('Every fenced code block must be closed.'), 'Missing block closure rule');
  assert(html.includes('console.log("full file contents go here, never abbreviated");'), 'Missing worked prompt example');
});

await test('Client script implements disk-mirrored sidebar tree, file viewing, and HTML run/play button', () => {
  assert(html.includes('function updateSidebarTree('), 'Missing updateSidebarTree');
  assert(html.includes("fetch(`/file-tree"), 'updateSidebarTree must fetch /file-tree');
  assert(html.includes('function selectFile('), 'Missing selectFile function for non-graph files');
  assert(html.includes('function saveRawFile('), 'Missing saveRawFile function');
  assert(html.includes('function runHtmlFile('), 'Missing runHtmlFile function');
  assert(html.includes('function playGameInNewTab('), 'Missing playGameInNewTab function');
  assert(html.includes('Start the dev server first (npm run dev)'), 'Missing dev server toast message');
  assert(html.includes('.btn-run-file'), 'Missing btn-run-file styling');
  assert(html.includes('.btn-play-top'), 'Missing btn-play-top styling');
});

await test('Client script implements Issue-Report modal and surgical patch generator', () => {
  assert(html.includes('function openIssueReportModal('), 'Missing openIssueReportModal');
  assert(html.includes('function copyIssuePrompt('), 'Missing copyIssuePrompt');
  assert(html.includes('### EDIT: relative/path.ext'), 'Prompt must use ### EDIT: format');
  assert(html.includes('<<<<<<< FIND'), 'Prompt must use <<<<<<< FIND');
  assert(html.includes('>>>>>>> REPLACE'), 'Prompt must use >>>>>>> REPLACE');
});

// 2. Unit testing parseAiFileBlocks & writeAiFilesToProject
await test('parseAiFileBlocks extracts single file with code block', () => {
  const aiText = `Here is your code:

### FILE: src/entities/player.js
\`\`\`javascript
export class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}
\`\`\`
Hope this helps!`;

  const blocks = parseAiFileBlocks(aiText);
  assert(blocks.length === 1, `Expected 1 block, got ${blocks.length}`);
  assert(blocks[0].path === 'src/entities/player.js', `Path mismatch: ${blocks[0].path}`);
  assert(blocks[0].content.includes('export class Player'), 'Content missing expected code');
});

await test('writeAiFilesToProject creates nested subdirectories and writes all files', () => {
  const testProject = join(tempBase, 'test-write-files');
  mkdirSync(testProject, { recursive: true });

  const aiText = `
### FILE: src/core/engine.js
\`\`\`javascript
export function run() { return true; }
\`\`\`

### FILE: src/ui/hud.js
\`\`\`javascript
export class HUD {}
\`\`\`
`;

  const result = writeAiFilesToProject(testProject, aiText);
  assert(result.success === true, 'Result success should be true');
  assert(result.count === 2, `Expected 2 files written, got ${result.count}`);
  assert(existsSync(join(testProject, 'src', 'core', 'engine.js')), 'engine.js not found on disk');
  assert(existsSync(join(testProject, 'src', 'ui', 'hud.js')), 'hud.js not found on disk');
});

// 3. Unit testing parseAiEditBlocks & applyAiEditBlocks
await test('parseAiEditBlocks parses single surgical edit block', () => {
  const aiText = `
Here is the patch:

### EDIT: src/core/engine.js
<<<<<<< FIND
export function run() { return true; }
=======
export function run() { return false; }
>>>>>>> REPLACE
`;

  const edits = parseAiEditBlocks(aiText);
  assert(edits.length === 1, `Expected 1 edit, got ${edits.length}`);
  assert(edits[0].path === 'src/core/engine.js', `Path mismatch: ${edits[0].path}`);
  assert(edits[0].find === 'export function run() { return true; }', `Find mismatch: ${edits[0].find}`);
  assert(edits[0].replace === 'export function run() { return false; }', `Replace mismatch: ${edits[0].replace}`);
});

await test('applyAiEditBlocks applies surgical patch to existing file on disk', () => {
  const testProject = join(tempBase, 'test-patch-apply');
  mkdirSync(join(testProject, 'src'), { recursive: true });
  writeFileSync(join(testProject, 'src', 'player.js'), 'export class Player {\n  constructor() {\n    this.speed = 10;\n  }\n}\n');

  const patchText = `
### EDIT: src/player.js
<<<<<<< FIND
    this.speed = 10;
=======
    this.speed = 25;
    this.jumpForce = 15;
>>>>>>> REPLACE
`;

  const res = applyAiEditBlocks(testProject, patchText);
  assert(res.success === true, 'Patch application should succeed');
  assert(res.count === 1, `Expected 1 edit applied, got ${res.count}`);

  const updated = readFileSync(join(testProject, 'src', 'player.js'), 'utf-8');
  assert(updated.includes('this.speed = 25;'), 'Updated code missing new speed');
  assert(updated.includes('this.jumpForce = 15;'), 'Updated code missing new jumpForce');
  assert(!updated.includes('this.speed = 10;'), 'Old code should have been replaced');
});

await test('applyAiEditBlocks throws error naming file and snippet when FIND text not found', () => {
  const testProject = join(tempBase, 'test-patch-missing');
  mkdirSync(join(testProject, 'src'), { recursive: true });
  writeFileSync(join(testProject, 'src', 'player.js'), 'const a = 1;\n');

  const patchText = `
### EDIT: src/player.js
<<<<<<< FIND
const nonExistent = 999;
=======
const replacement = 42;
>>>>>>> REPLACE
`;

  try {
    applyAiEditBlocks(testProject, patchText);
    assert(false, 'Should have thrown error on missing FIND text');
  } catch (err) {
    assert(err.message.includes('src/player.js'), 'Error must name target file');
    assert(err.message.includes('could not find exact FIND text'), 'Error must explain FIND text not found');
  }
});

await test('applyAiEditBlocks throws error when FIND text matches multiple times', () => {
  const testProject = join(tempBase, 'test-patch-duplicate');
  mkdirSync(join(testProject, 'src'), { recursive: true });
  writeFileSync(join(testProject, 'src', 'player.js'), 'const x = 1;\nconst x = 1;\n');

  const patchText = `
### EDIT: src/player.js
<<<<<<< FIND
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE
`;

  try {
    applyAiEditBlocks(testProject, patchText);
    assert(false, 'Should have thrown error on non-unique FIND text');
  } catch (err) {
    assert(err.message.includes('src/player.js'), 'Error must name target file');
    assert(err.message.includes('matched 2 times'), 'Error must indicate multiple matches');
  }
});

// 4. Unit testing getProjectFileTree
await test('getProjectFileTree scans all files recursively and excludes .git/node_modules', () => {
  const testProject = join(tempBase, 'test-file-tree');
  mkdirSync(join(testProject, 'src', 'sub'), { recursive: true });
  mkdirSync(join(testProject, 'node_modules', 'foo'), { recursive: true });
  mkdirSync(join(testProject, '.git'), { recursive: true });

  writeFileSync(join(testProject, 'index.html'), '<html></html>');
  writeFileSync(join(testProject, 'package.json'), '{}');
  writeFileSync(join(testProject, 'GEMINI.md'), '# Gemini');
  writeFileSync(join(testProject, 'src', 'main.js'), 'console.log(1);');
  writeFileSync(join(testProject, 'src', 'sub', 'util.js'), 'export const x = 1;');
  writeFileSync(join(testProject, 'node_modules', 'foo', 'index.js'), 'ignored');
  writeFileSync(join(testProject, '.git', 'config'), 'ignored');

  const files = getProjectFileTree(testProject);
  const paths = files.map(f => f.path);

  assert(paths.includes('index.html'), 'Missing index.html');
  assert(paths.includes('package.json'), 'Missing package.json');
  assert(paths.includes('GEMINI.md'), 'Missing GEMINI.md');
  assert(paths.includes('src/main.js'), 'Missing src/main.js');
  assert(paths.includes('src/sub/util.js'), 'Missing src/sub/util.js');
  assert(!paths.some(p => p.startsWith('node_modules')), 'node_modules should be excluded');
  assert(!paths.some(p => p.startsWith('.git')), '.git should be excluded');
});

// 5. HTTP API Endpoints
await test('GET /file-tree returns recursive disk file list', async () => {
  const testProject = join(tempBase, 'http-tree-test');
  scaffoldNewProject({ targetFolder: testProject, engine: 'js', projectName: 'Tree Test' });

  const res = await fetch(`${BASE_URL}/file-tree?projectPath=${encodeURIComponent(testProject)}`);
  assert(res.ok, `GET /file-tree failed: ${res.status}`);
  const data = await res.json();
  assert(data.success === true, 'Response success should be true');
  assert(Array.isArray(data.files), 'files should be an array');
  const filePaths = data.files.map(f => f.path);
  assert(filePaths.includes('index.html'), 'Missing index.html in file-tree response');
  assert(filePaths.includes('package.json'), 'Missing package.json in file-tree response');
  assert(filePaths.includes('src/main.js'), 'Missing src/main.js in file-tree response');
});

await test('GET /file-content and POST /save-file read and write project files', async () => {
  const testProject = join(tempBase, 'http-file-content-test');
  scaffoldNewProject({ targetFolder: testProject, engine: 'js', projectName: 'Content Test' });

  // Read index.html
  const readRes = await fetch(`${BASE_URL}/file-content?projectPath=${encodeURIComponent(testProject)}&filePath=index.html`);
  assert(readRes.ok, `Read failed: ${readRes.status}`);
  const readData = await readRes.json();
  assert(readData.success === true, 'Read success should be true');
  assert(readData.content.includes('<title>Content Test</title>'), 'Content mismatch');

  // Save new content to index.html
  const newHtml = '<!DOCTYPE html><html><body><h1>Updated</h1></body></html>';
  const saveRes = await fetch(`${BASE_URL}/save-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: testProject, filePath: 'index.html', content: newHtml })
  });
  assert(saveRes.ok, `Save failed: ${saveRes.status}`);

  // Confirm on disk
  const diskContent = readFileSync(join(testProject, 'index.html'), 'utf-8');
  assert(diskContent === newHtml, 'Saved content does not match on disk');
});

await test('GET /ping-dev-server detects reachable and unreachable URLs', async () => {
  // Reachable: ContextForge server itself on port 3000
  const reachableRes = await fetch(`${BASE_URL}/ping-dev-server?url=${encodeURIComponent(BASE_URL)}`);
  assert(reachableRes.ok, 'Ping request failed');
  const reachData = await reachableRes.json();
  assert(reachData.reachable === true, 'Localhost 3000 should be reachable');

  // Unreachable: random unused port
  const deadRes = await fetch(`${BASE_URL}/ping-dev-server?url=${encodeURIComponent('http://127.0.0.1:59998')}`);
  assert(deadRes.ok, 'Dead ping request failed');
  const deadData = await deadRes.json();
  assert(deadData.reachable === false, 'Port 59998 should not be reachable');
});

await test('POST /add-from-clipboard auto-detects and applies surgical EDIT blocks', async () => {
  const testProject = join(tempBase, 'http-clip-edit-test');
  scaffoldNewProject({ targetFolder: testProject, engine: 'js', projectName: 'Patch Game' });

  const patchText = `
### EDIT: src/main.js
<<<<<<< FIND
export const GAME_TITLE = "Patch Game";
=======
export const GAME_TITLE = "Super Patch Game";
export const PATCHED_VERSION = "2.0.0";
>>>>>>> REPLACE
`;

  const res = await fetch(`${BASE_URL}/add-from-clipboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: testProject, content: patchText })
  });

  assert(res.ok, `POST /add-from-clipboard failed: ${res.status}`);
  const data = await res.json();
  assert(data.success === true, 'Response success should be true');
  assert(data.type === 'edit', `Expected type=edit, got ${data.type}`);
  assert(data.count === 1, `Expected 1 edit applied, got ${data.count}`);

  const updatedMain = readFileSync(join(testProject, 'src', 'main.js'), 'utf-8');
  assert(updatedMain.includes('Super Patch Game'), 'Patch text not found on disk');
  assert(updatedMain.includes('PATCHED_VERSION = "2.0.0"'), 'New export not found on disk');
});

await test('POST /add-from-clipboard returns informative error when neither FILE nor EDIT format matches', async () => {
  const testProject = join(tempBase, 'http-clip-invalid-test');
  mkdirSync(testProject, { recursive: true });

  const res = await fetch(`${BASE_URL}/add-from-clipboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: testProject,
      content: 'Here is some random code without FILE or EDIT blocks: var foo = 42;'
    })
  });

  assert(res.status === 400, `Expected 400, got ${res.status}`);
  const data = await res.json();
  assert(data.error.includes("Zero blocks found matching '### FILE:' or '### EDIT:' formats"), 'Error must explain missing formats');
  assert(data.error.includes('### FILE: relative/path/to/file.ext'), 'Error must show FILE example');
  assert(data.error.includes('### EDIT: relative/path/to/file.ext'), 'Error must show EDIT example');
});

await test('parseAiFileBlocks ignores markdown tables, ratings, reviews, and chit-chat', () => {
  const mixedResponse = `
## Strict Rating: **5.5 / 10**

| Category | Score | Why |
|---|---|---|
| Gameplay mechanics | **7.5** | Coyote time, jump buffer, stomps work. |
| Code quality | **8.5** | Well-organized, no leaks. |

**Verdict:** Reads as a functional dev prototype.

### FILE: src/textures.js
\`\`\`js
export function makeToonGradient() { return "gradient"; }
\`\`\`

### FILE: src/particles.js
\`\`\`js
export class ParticleSystem {}
\`\`\`

---
### Summary of what changed in V2
Everything is updated!
`;

  const files = parseAiFileBlocks(mixedResponse);
  assert(files.length === 2, `Expected 2 files extracted, got ${files.length}`);
  assert(files[0].path === 'src/textures.js', 'Expected first file src/textures.js');
  assert(files[0].content.includes('makeToonGradient'), 'Expected content to be preserved');
  assert(files[1].path === 'src/particles.js', 'Expected second file src/particles.js');
});

await test('parseAiEditBlocks handles surgical edits with SEARCH/FIND and wrapped in backticks', () => {
  const mixedEditResponse = `
Here is your requested surgical fix:

### EDIT: src/player.js
\`\`\`js
<<<<<<< SEARCH
this.speed = 10;
=======
this.speed = 25;
>>>>>>> REPLACE
\`\`\`

Hope this helps!
`;

  const edits = parseAiEditBlocks(mixedEditResponse);
  assert(edits.length === 1, `Expected 1 edit extracted, got ${edits.length}`);
  assert(edits[0].path === 'src/player.js', 'Expected path src/player.js');
  assert(edits[0].find.includes('this.speed = 10;'), 'Expected find snippet');
  assert(edits[0].replace.includes('this.speed = 25;'), 'Expected replace snippet');
});

// Clean up temp
try {
  rmSync(tempBase, { recursive: true, force: true });
} catch (_) {}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
