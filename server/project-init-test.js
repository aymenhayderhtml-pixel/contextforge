/**
 * server/project-init-test.js — Automated tests for Phase 13:
 * - T050: New Project wizard validation (target folder, engine, reject existing projects)
 * - T051: Scaffolding engine boilerplate + AI-agent doc set (GEMINI.md, LOOP.md, TASKS.md, ARCHITECTURE.md) + extract
 * - T052: Progress view TASKS.md checkbox parser
 * - T053: Live progress refresh on disk modification & UI polling
 *
 * Run: node server/project-init-test.js
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { scaffoldNewProject, parseProjectProgress } from './project-init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const tempBase = join(projectRoot, 'test-fixtures', 'temp-projects');
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

console.log('Phase 13 — New Project Wizard & Progress Dashboard tests:\n');

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

// 1. UI Elements (T050, T052, T053)
await test('HTML contains New Project button, wizard modal, and Progress dashboard (T050-T053)', () => {
  assert(html.includes('id="btn-new-project"'), 'Missing btn-new-project button in controls');
  assert(html.includes('id="btn-toggle-progress"'), 'Missing btn-toggle-progress button in controls');
  assert(html.includes('function openNewProjectModal('), 'Missing openNewProjectModal function');
  assert(html.includes('function openProgressModal('), 'Missing openProgressModal function');
  assert(html.includes('progress-bar-container'), 'Missing progress-bar styling');
  assert(html.includes('setInterval('), 'Progress dashboard must use live polling');
});

// 2. Wizard Validation & Scaffolding (T050, T051)
const godotTarget = join(tempBase, 'my-godot-game');
const jsTarget = join(tempBase, 'my-web-game');

await test('scaffoldNewProject rejects existing projects with manifest or config (T050)', () => {
  // Existing folder with package.json
  const existingDir = join(tempBase, 'existing-project');
  mkdirSync(existingDir, { recursive: true });
  writeFileSync(join(existingDir, 'package.json'), '{}', 'utf-8');

  let threw = false;
  try {
    scaffoldNewProject({
      targetFolder: existingDir,
      engine: 'js',
      projectName: 'Already Exists'
    });
  } catch (err) {
    threw = true;
    assert(err.message.includes('already contains an initialized project'), err.message);
  }
  assert(threw, 'Should have rejected existing project directory');
});

await test('scaffoldNewProject rejects invalid engine or missing folder (T050)', () => {
  let threwEngine = false;
  try {
    scaffoldNewProject({ targetFolder: godotTarget, engine: 'unreal', projectName: 'Test' });
  } catch (err) {
    threwEngine = true;
  }
  assert(threwEngine, 'Should reject invalid engine choice');

  let threwFolder = false;
  try {
    scaffoldNewProject({ targetFolder: '', engine: 'godot', projectName: 'Test' });
  } catch (err) {
    threwFolder = true;
  }
  assert(threwFolder, 'Should reject empty target folder');
});

await test('scaffoldNewProject creates Godot base files and AI doc set (T051)', () => {
  const result = scaffoldNewProject({
    targetFolder: godotTarget,
    engine: 'godot',
    projectName: 'Crystal Quest'
  });

  assert(result.success === true, 'Scaffold result should be success');
  assert(existsSync(join(godotTarget, 'project.godot')), 'Missing project.godot');
  assert(existsSync(join(godotTarget, 'scenes', 'main.tscn')), 'Missing scenes/main.tscn');
  assert(existsSync(join(godotTarget, 'scripts', 'main.gd')), 'Missing scripts/main.gd');

  // Verify full AI agent loop doc set (T051)
  assert(existsSync(join(godotTarget, 'GEMINI.md')), 'Missing GEMINI.md');
  assert(existsSync(join(godotTarget, 'LOOP.md')), 'Missing LOOP.md');
  assert(existsSync(join(godotTarget, 'TASKS.md')), 'Missing TASKS.md');
  assert(existsSync(join(godotTarget, 'docs', 'ARCHITECTURE.md')), 'Missing docs/ARCHITECTURE.md');

  // Verify GEMINI.md content
  const geminiMd = readFileSync(join(godotTarget, 'GEMINI.md'), 'utf-8');
  assert(geminiMd.includes('Crystal Quest'), 'GEMINI.md should include project name');
  assert(geminiMd.includes('GODOT'), 'GEMINI.md should specify engine');

  // Verify LOOP.md content
  const loopMd = readFileSync(join(godotTarget, 'LOOP.md'), 'utf-8');
  assert(loopMd.includes('TASKS.md'), 'LOOP.md should reference task tracker');

  // Verify ARCHITECTURE.md content
  const archMd = readFileSync(join(godotTarget, 'docs', 'ARCHITECTURE.md'), 'utf-8');
  assert(archMd.includes('Crystal Quest'), 'ARCHITECTURE.md should include project name');
});

await test('scaffoldNewProject creates JS/Three.js base files and AI doc set (T051)', () => {
  const result = scaffoldNewProject({
    targetFolder: jsTarget,
    engine: 'js',
    projectName: 'Cyber Arcade'
  });

  assert(result.success === true, 'Scaffold result should be success');
  assert(existsSync(join(jsTarget, 'package.json')), 'Missing package.json');
  assert(existsSync(join(jsTarget, 'index.html')), 'Missing index.html');
  assert(existsSync(join(jsTarget, 'src', 'main.js')), 'Missing src/main.js');
  assert(existsSync(join(jsTarget, 'src', 'scene-manager.js')), 'Missing src/scene-manager.js');

  // Verify AI agent doc set
  assert(existsSync(join(jsTarget, 'GEMINI.md')), 'Missing GEMINI.md');
  assert(existsSync(join(jsTarget, 'LOOP.md')), 'Missing LOOP.md');
  assert(existsSync(join(jsTarget, 'TASKS.md')), 'Missing TASKS.md');
  assert(existsSync(join(jsTarget, 'docs', 'ARCHITECTURE.md')), 'Missing docs/ARCHITECTURE.md');
});

// 3. Extraction on newly scaffolded project (T051)
await test('POST /extract extracts newly scaffolded Godot project immediately (T051)', async () => {
  const res = await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: godotTarget })
  });
  assert(res.ok, `Status ${res.status}`);
  const manifest = await res.json();
  assert(manifest.nodes.length >= 2, `Expected at least 2 nodes, got ${manifest.nodes.length}`);
  assert(manifest.edges.length >= 1, `Expected at least 1 edge, got ${manifest.edges.length}`);
});

await test('POST /extract extracts newly scaffolded JS project immediately (T051)', async () => {
  const res = await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: jsTarget })
  });
  assert(res.ok, `Status ${res.status}`);
  const manifest = await res.json();
  assert(manifest.nodes.length >= 2, `Expected at least 2 nodes, got ${manifest.nodes.length}`);
  assert(manifest.edges.length >= 1, `Expected at least 1 edge, got ${manifest.edges.length}`);
});

// 4. Progress Dashboard Parser & Live Updates (T052, T053)
await test('parseProjectProgress accurately parses TASKS.md phases and checkboxes (T052)', () => {
  const progress = parseProjectProgress(godotTarget);
  assert(progress.hasTasks === true, 'Should detect tasks');
  assert(progress.totalTasks >= 6, `Expected at least 6 tasks, got ${progress.totalTasks}`);
  assert(progress.completedTasks === 1, `Expected 1 completed task initially (T001), got ${progress.completedTasks}`);
  assert(progress.phases.length >= 3, `Expected at least 3 phases, got ${progress.phases.length}`);

  // Check Phase 1 stats
  const phase1 = progress.phases[0];
  assert(phase1.completed === 1, 'Phase 1 should have 1 completed task');
  assert(phase1.tasks[0].id === 'T001', `Expected T001, got ${phase1.tasks[0].id}`);
  assert(phase1.tasks[0].completed === true, 'T001 should be completed');
  assert(phase1.tasks[1].completed === false, 'T002 should not be completed');
});

await test('GET /project-progress reflects live disk changes to TASKS.md (T053)', async () => {
  const tasksPath = join(godotTarget, 'TASKS.md');
  let content = readFileSync(tasksPath, 'utf-8');

  // Mark T002 as completed: - [ ] T002 -> - [x] T002
  content = content.replace('- [ ] T002:', '- [x] T002:');
  writeFileSync(tasksPath, content, 'utf-8');

  const res = await fetch(`${BASE_URL}/project-progress?projectPath=${encodeURIComponent(godotTarget)}`);
  assert(res.ok, `GET failed with status ${res.status}`);
  const data = await res.json();

  assert(data.hasTasks === true, 'Should have tasks');
  assert(data.completedTasks === 2, `Expected 2 completed tasks after update, got ${data.completedTasks}`);
  assert(data.phases[0].tasks[1].completed === true, 'T002 should now be completed in phase 1');
  assert(data.percent > 0, 'Progress percentage should be > 0');
});

await test('POST /init-project HTTP endpoint scaffolds and returns created files (T050, T051)', async () => {
  const mixedTarget = join(tempBase, 'my-mixed-game');
  const res = await fetch(`${BASE_URL}/init-project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetFolder: mixedTarget,
      engine: 'mixed',
      projectName: 'Fusion Odyssey'
    })
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await res.json();
  assert(data.success === true, 'Response success should be true');
  assert(data.filesCreated.length >= 6, `Expected at least 6 files, got ${data.filesCreated.length}`);
  assert(existsSync(join(mixedTarget, 'project.godot')), 'Missing project.godot');
  assert(existsSync(join(mixedTarget, 'package.json')), 'Missing package.json');
  assert(existsSync(join(mixedTarget, 'GEMINI.md')), 'Missing GEMINI.md');
});

// Clean temp directory
rmSync(tempBase, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
