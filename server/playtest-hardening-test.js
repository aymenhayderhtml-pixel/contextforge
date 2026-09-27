/**
 * server/playtest-hardening-test.js
 *
 * Automated regression and verification suite for Phase 27:
 * Live Playtest Findings & Hardening (T112–T123).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import contextRouter from './routes/context.js';
import extractRouter from './routes/extract.js';
import clipboardRouter from './routes/clipboard.js';
import { HeadlessClient } from '../scripts/headless-runner.js';
import { extract as extractJs } from './extractors/js-extractor.js';
import { scaffoldNewProject, applyAiEditBlocks, parseAiFileBlocks, parseAiEditBlocks } from './project-init.js';
import { rankRelevantFiles } from './context-compiler.js';
import { extractScopedSnippet } from './outline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

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

// ── T112, T113, T114: Godot Scaffolding, 2D/3D & Title Casing ──────────────────

test('T112 & T113: Godot 2D (default) scaffolds Node2D scene & script, 3D scaffolds Node3D', () => {
  const tempBase = join(tmpdir(), `godot-scaffold-test-${Date.now()}`);
  const target2d = join(tempBase, 'game-2d');
  const target3d = join(tempBase, 'game-3d');

  try {
    // 2D scaffold
    const res2d = scaffoldNewProject({
      targetFolder: target2d,
      engine: 'godot',
      projectName: 'Pixel Jumper',
      dimension: '2d'
    });
    assert.strictEqual(res2d.dimension, '2d');
    const tscn2d = readFileSync(join(target2d, 'scenes', 'main.tscn'), 'utf-8');
    assert.match(tscn2d, /type="Node2D"/, '2D scene must use Node2D root');
    const gd2d = readFileSync(join(target2d, 'scripts', 'main.gd'), 'utf-8');
    assert.match(gd2d, /extends Node2D/, '2D script must extend Node2D');

    // 3D scaffold
    const res3d = scaffoldNewProject({
      targetFolder: target3d,
      engine: 'godot',
      projectName: 'Sky Duel',
      dimension: '3d'
    });
    assert.strictEqual(res3d.dimension, '3d');
    const tscn3d = readFileSync(join(target3d, 'scenes', 'main.tscn'), 'utf-8');
    assert.match(tscn3d, /type="Node3D"/, '3D scene must use Node3D root');
    const gd3d = readFileSync(join(target3d, 'scripts', 'main.gd'), 'utf-8');
    assert.match(gd3d, /extends Node3D/, '3D script must extend Node3D');

    // T114: Title casing in project.godot
    const conf3d = readFileSync(join(target3d, 'project.godot'), 'utf-8');
    assert.match(conf3d, /config\/name="Sky Duel"/, 'project.godot must use properly-cased title');
    assert.doesNotMatch(conf3d, /config\/name="sky-duel"/, 'project.godot must not use slug');
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }
});

// ── T115: HTML/Three.js Scaffold game-container Mount ─────────────────────────

test('T115: Three.js scaffold mounts renderer to #game-container with sized CSS', () => {
  const tempBase = join(tmpdir(), `three-scaffold-test-${Date.now()}`);
  try {
    scaffoldNewProject({
      targetFolder: tempBase,
      engine: 'js',
      projectName: 'Star Wing'
    });

    const mainJs = readFileSync(join(tempBase, 'src', 'main.js'), 'utf-8');
    assert.match(mainJs, /document\.getElementById\('game-container'\)/, 'main.js must reference game-container');
    assert.match(mainJs, /container\.appendChild\(renderer\.domElement\)/, 'main.js must mount canvas to container');

    const styleCss = readFileSync(join(tempBase, 'src', 'style.css'), 'utf-8');
    assert.match(styleCss, /#game-container/, 'style.css must define #game-container');
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }
});

// ── T116: Mixed Engine Support in Wizard UI ───────────────────────────────────

test('T116: Wizard UI and backend accept and render Mixed engine choice', () => {
  const wizardJs = readFileSync(join(root, 'public', 'js', 'project', 'wizard.js'), 'utf-8');
  assert.match(wizardJs, /id="card-engine-mixed"/, 'wizard.js must include card-engine-mixed');
  assert.match(wizardJs, /Mixed \(Godot \+ Web\)/, 'wizard.js must describe Mixed engine option');

  const modalsCss = readFileSync(join(root, 'public', 'css', 'modals.css'), 'utf-8');
  assert.match(modalsCss, /\.engine-card-grid/, 'modals.css must style engine-card-grid');
});

// ── T117: JS Extractor Extracts index.html as Graph Node with Dependency Edge ─

test('T117: JS extractor extracts index.html and its <script type="module"> import edge', async () => {
  const tempProject = join(tmpdir(), `js-html-extractor-${Date.now()}`);
  try {
    mkdirSync(join(tempProject, 'src'), { recursive: true });
    writeFileSync(join(tempProject, 'index.html'), `
<!DOCTYPE html>
<html>
<head><title>Test Game</title></head>
<body>
  <div id="game-container"></div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
`, 'utf-8');

    writeFileSync(join(tempProject, 'src', 'main.js'), `
import { run } from './engine.js';
export const VERSION = '1.0.0';
run();
`, 'utf-8');

    writeFileSync(join(tempProject, 'src', 'engine.js'), `
export function run() { return true; }
`, 'utf-8');

    const result = await extractJs(tempProject);
    const htmlNode = result.nodes.find(n => n.id === 'index.html');
    assert.ok(htmlNode, 'index.html node must be present in graph');
    assert.strictEqual(htmlNode.type, 'scene', 'index.html should have type scene');
    assert.ok(htmlNode.depends_on.includes('src/main.js'), 'index.html must depend on src/main.js');

    const edge = result.edges.find(e => e.from === 'index.html' && e.to === 'src/main.js');
    assert.ok(edge, 'Edge from index.html to src/main.js must exist');
    assert.strictEqual(edge.kind, 'import', 'Edge kind should be import');
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

// ── T118: Structural Issue Targeting Fallback ─────────────────────────────────

test('T118: extractScopedSnippet and /scoped-context provide file-level fallback for structural issues without line targeting', async () => {
  const code = `
class LevelManager {
  constructor() {
    this.rooms = [];
    this.activeRoom = 0;
  }

  addRoom(room) {
    this.rooms.push(room);
  }

  switchRoom(index) {
    this.activeRoom = index;
  }
}
`;

  // Without explicit line or declaration name, extractScopedSnippet returns null
  const snippet = extractScopedSnippet(code, 'The layout of rooms is broken and transitions are misaligned');
  assert.strictEqual(snippet, null, 'Structural issue should not match random lines');

  // POST /scoped-context handles structural issue by providing full source context
  const tempProject = join(tmpdir(), `structural-test-${Date.now()}`);
  try {
    mkdirSync(join(tempProject, 'src'), { recursive: true });
    writeFileSync(join(tempProject, 'src', 'level.js'), code, 'utf-8');

    const res = await fetch(`http://localhost:${port}/scoped-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: tempProject,
        targetFile: 'src/level.js',
        issueDescription: 'The layout of rooms is broken and transitions are misaligned',
        attachedFiles: ['src/level.js']
      })
    });

    assert.ok(res.ok, `HTTP ${res.status}`);
    const data = await res.json();
    assert.ok(data.prompt.includes('Structural / File-Level Context'), 'Should provide file-level structural context');
    assert.ok(data.prompt.includes('class LevelManager'), 'Should include full code content');
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

// ── T119: Godot Owning .tscn Auto-Attachment ───────────────────────────────────

test('T119: Godot scene-tree / rendering issue auto-attaches owning .tscn alongside .gd', async () => {
  const tempProject = join(tmpdir(), `godot-scene-attach-${Date.now()}`);
  try {
    mkdirSync(join(tempProject, 'scenes'), { recursive: true });
    mkdirSync(join(tempProject, 'scripts'), { recursive: true });
    writeFileSync(join(tempProject, 'project.godot'), 'config_version=5\n', 'utf-8');

    writeFileSync(join(tempProject, 'scripts', 'jet.gd'), `
extends CharacterBody3D
func _physics_process(delta):
    pass
`, 'utf-8');

    writeFileSync(join(tempProject, 'scenes', 'jet.tscn'), `
[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://scripts/jet.gd" id="1_jet"]
[node name="Jet" type="CharacterBody3D"]
script = ExtResource("1_jet")
`, 'utf-8');

    // 1. rankRelevantFiles boosts owning scene
    const ranked = rankRelevantFiles({
      projectPath: tempProject,
      issueDescription: 'The jet mesh rotation and camera node are misaligned in the scene tree',
      consoleLogs: 'Error in scripts/jet.gd:12'
    });
    const tscnEntry = ranked.find(r => r.file === 'scenes/jet.tscn');
    assert.ok(tscnEntry, 'Owning scene must be ranked for scene-tree issue');
    assert.ok(tscnEntry.score >= 90, `Owning scene score should be >= 90, got ${tscnEntry.score}`);

    // 2. POST /scoped-context auto-attaches scenes/jet.tscn when only scripts/jet.gd was passed
    const res = await fetch(`http://localhost:${port}/scoped-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: tempProject,
        targetFile: 'scripts/jet.gd',
        issueDescription: 'The jet mesh rotation and camera node are misaligned in the scene tree',
        attachedFiles: ['scripts/jet.gd']
      })
    });
    assert.ok(res.ok, `HTTP ${res.status}`);
    const data = await res.json();
    assert.ok(data.prompt.includes('### FILE: scenes/jet.tscn'), 'Owning scene scenes/jet.tscn must be auto-included in context');
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

// ── T120: Surgical EDIT Patches on .gd and .tscn ──────────────────────────────

test('T120: Surgical EDIT patches apply cleanly against .gd and .tscn files', () => {
  const tempProject = join(tmpdir(), `godot-edit-test-${Date.now()}`);
  try {
    mkdirSync(join(tempProject, 'scenes'), { recursive: true });
    mkdirSync(join(tempProject, 'scripts'), { recursive: true });

    const gdFile = join(tempProject, 'scripts', 'hero.gd');
    writeFileSync(gdFile, 'extends Node2D\n\nvar speed: float = 200.0\n\nfunc move():\n\tpass\n', 'utf-8');

    const tscnFile = join(tempProject, 'scenes', 'hero.tscn');
    writeFileSync(tscnFile, '[gd_scene load_steps=2 format=3]\n\n[node name="Hero" type="Node2D"]\n', 'utf-8');

    const patch = `
### EDIT: scripts/hero.gd
<<<<<<< FIND
var speed: float = 200.0
=======
var speed: float = 350.0
>>>>>>> REPLACE

### EDIT: scenes/hero.tscn
<<<<<<< FIND
[node name="Hero" type="Node2D"]
=======
[node name="Hero" type="CharacterBody2D"]
>>>>>>> REPLACE
`;

    const result = applyAiEditBlocks(tempProject, patch);
    assert.strictEqual(result.success, true, 'Patch should apply cleanly');
    assert.strictEqual(result.count, 2, 'Should apply 2 edits');

    const updatedGd = readFileSync(gdFile, 'utf-8');
    assert.ok(updatedGd.includes('var speed: float = 350.0'), 'hero.gd should have updated speed');

    const updatedTscn = readFileSync(tscnFile, 'utf-8');
    assert.ok(updatedTscn.includes('type="CharacterBody2D"'), 'hero.tscn should have updated root type');
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

// ── T121: Screenshot Base64 Evidence in Problem Pane & Context Compilation ────

test('T121: Screenshot base64 data flows into evidence package and prompt', async () => {
  // Test workstation.js includes screenshotBase64 in POST /scoped-context payload
  const workstationJs = readFileSync(join(root, 'public', 'js', 'workstation', 'workstation.js'), 'utf-8');
  assert.match(workstationJs, /screenshotBase64:\s*payload\.screenshotBase64/, 'workstation.js must pass screenshotBase64 to /scoped-context');

  const problemPaneJs = readFileSync(join(root, 'public', 'js', 'workstation', 'problem-pane.js'), 'utf-8');
  assert.match(problemPaneJs, /screenshotBase64:\s*ws\.screenshotBase64/, 'problem-pane.js must include screenshotBase64 in getProblemPayload');

  // Verify /scoped-context embeds screenshotBase64 into compiled prompt
  const tempProject = join(tmpdir(), `screenshot-test-${Date.now()}`);
  try {
    mkdirSync(join(tempProject, 'src'), { recursive: true });
    writeFileSync(join(tempProject, 'src', 'main.js'), 'console.log("test");\n', 'utf-8');

    const sampleBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const res = await fetch(`http://localhost:${port}/scoped-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath: tempProject,
        targetFile: 'src/main.js',
        issueDescription: 'Visual overlap bug',
        attachedFiles: ['src/main.js'],
        screenshotBase64: sampleBase64
      })
    });

    assert.ok(res.ok, `HTTP ${res.status}`);
    const data = await res.json();
    assert.ok(data.prompt.includes('ATTACHED SCREENSHOT EVIDENCE:'), 'Prompt must contain ATTACHED SCREENSHOT EVIDENCE');
    assert.ok(data.prompt.includes(sampleBase64.slice(0, 30)), 'Prompt must embed screenshot base64 slice');
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

// ── T122: Runtime Error Placeholder UX Distinction ────────────────────────────

test('T122: Problem pane clearly distinguishes unverified check vs verified clear', () => {
  const problemPaneJs = readFileSync(join(root, 'public', 'js', 'workstation', 'problem-pane.js'), 'utf-8');
  assert.match(problemPaneJs, /Runtime check not run yet for this state/, 'problem-pane.js must warn that check has not run yet');
  assert.match(problemPaneJs, /Verified: No compiler or runtime errors detected/, 'problem-pane.js must show verified state after check');

  const workspacePaneJs = readFileSync(join(root, 'public', 'js', 'workstation', 'workspace-pane.js'), 'utf-8');
  assert.match(workspacePaneJs, /state\.workstation\.hasRunLiveCheck\s*=\s*false/, 'workspace-pane.js must reset hasRunLiveCheck on patch apply');
});

// ── T123: AI Responses with Long Reasoning/Prose Preambles ─────────────────────

test('T123: Parser cleanly ignores long reasoning/prose preambles without leaking into file content', () => {
  const fixturePath = join(root, 'test-fixtures', 'multi-model-patches', 'visual-polish-prose-preamble.txt');
  assert.ok(existsSync(fixturePath), 'Fixture visual-polish-prose-preamble.txt must exist');

  const text = readFileSync(fixturePath, 'utf-8');
  const files = parseAiFileBlocks(text);

  assert.strictEqual(files.length, 1, 'Should find 1 file block');
  assert.strictEqual(files[0].path, 'scripts/main.gd');
  assert.ok(!files[0].content.includes('Looking at the screenshot'), 'Prose preamble must NOT leak into file content');
  assert.ok(files[0].content.startsWith('extends Node3D'), 'File content must start with source code (extends Node3D)');
});
