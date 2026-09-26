/**
 * server/project-init.js — New Project Wizard & Progress Parser (Phase 13, T050-T053)
 *
 * Implements:
 * - Scaffolding new game projects (Godot, JS/Three.js, mixed)
 * - Auto-generating AI agent doc set (GEMINI.md, LOOP.md, TASKS.md, docs/ARCHITECTURE.md)
 * - Parsing project TASKS.md checkbox states for live progress tracking
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Validate and scaffold a new game project folder.
 * @param {Object} options
 * @param {string} options.targetFolder - Absolute path to new project directory
 * @param {'godot'|'js'|'mixed'} options.engine - Selected engine
 * @param {string} options.projectName - Display name of project
 * @returns {Object} result with files created
 */
export function scaffoldNewProject({ targetFolder, engine, projectName }) {
  if (!targetFolder || typeof targetFolder !== 'string') {
    throw new Error('Missing targetFolder');
  }
  const absTarget = resolve(targetFolder.trim());

  if (!engine || !['godot', 'js', 'mixed'].includes(engine.toLowerCase())) {
    throw new Error('Engine must be one of: godot, js, mixed');
  }
  const normEngine = engine.toLowerCase();

  const name = (projectName || 'New Game Project').trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');

  // Verify target folder does not already contain an initialized project
  if (existsSync(absTarget)) {
    const existingManifest = existsSync(join(absTarget, 'manifest.json'));
    const existingGodot = existsSync(join(absTarget, 'project.godot'));
    const existingPackage = existsSync(join(absTarget, 'package.json'));
    if (existingManifest || existingGodot || existingPackage) {
      throw new Error(`Target folder "${absTarget}" already contains an initialized project.`);
    }
  } else {
    mkdirSync(absTarget, { recursive: true });
  }

  const createdFiles = [];

  function safeWrite(relPath, content) {
    const fullPath = join(absTarget, relPath);
    const parentDir = resolve(fullPath, '..');
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(fullPath, content.trim() + '\n', 'utf-8');
    createdFiles.push(relPath);
  }

  // 1. Engine-specific code scaffolding
  if (normEngine === 'godot' || normEngine === 'mixed') {
    safeWrite('project.godot', `
; Engine configuration file.
config_version=5

[application]
config/name="${slug}"
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("4.2")

[rendering]
renderer/rendering_method="gl_compatibility"
`);

    safeWrite('icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="16" fill="#478cbf"/><path d="m39 42 7 13c3-1 6-2 10-2h16c4 0 7 1 10 2l7-13 7 4-5 13c6 3 11 8 13 14l11-2v9l-11 2c0 3-1 7-2 10l9 7-5 7-8-6c-4 5-9 8-16 10l2 11h-9l-2-11c-3 0-7 0-10-1l-2 11h-9l2-11c-7-2-12-5-16-10l-8 6-5-7 9-7c-1-3-2-7-2-10l-11-2v-9l11 2c2-6 7-11 13-14l-5-13zm15 32c-4 0-8 4-8 8s4 8 8 8 8-4 8-8-4-8-8-8zm36 0c-4 0-8 4-8 8s4 8 8 8 8-4 8-8-4-8-8-8z" fill="#fff"/></svg>`);

    safeWrite('scripts/main.gd', `
extends Node

# Main game entry point for ${name}
signal game_started

func _ready():
\tprint("${name} initialized.")
\temit_signal("game_started")
`);

    safeWrite('scenes/main.tscn', `
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1_main"]

[node name="Main" type="Node"]
script = ExtResource("1_main")
`);
  }

  if (normEngine === 'js' || normEngine === 'mixed') {
    safeWrite('package.json', JSON.stringify({
      name: slug,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite'
      },
      devDependencies: {
        vite: '^5.0.0'
      },
      dependencies: {
        three: '^0.160.0'
      }
    }, null, 2));

    safeWrite('src/style.css', `
body {
  margin: 0;
  overflow: hidden;
  background: #000;
}
canvas {
  display: block;
  width: 100vw;
  height: 100vh;
}
`);

    safeWrite('index.html', `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <link rel="stylesheet" href="/src/style.css">
</head>
<body>
  <div id="game-container"></div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
`);

    safeWrite('src/main.js', `
import * as THREE from 'three';
import { createScene } from './scene-manager.js';

export const GAME_TITLE = "${name}";

// Setup Three.js scene, camera, renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });

renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// One rotating cube
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshNormalMaterial();
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

camera.position.z = 3;

function animate() {
  requestAnimationFrame(animate);
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.01;
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();
createScene();
`);

    safeWrite('src/scene-manager.js', `
export function createScene() {
  return { status: "ready" };
}
`);
  }

  // 2. AI-Agent-Loop Doc Set Generation (T051)
  safeWrite('GEMINI.md', `
# ${name} — AI Development Agreement

## Engine & Target
- Engine: **${normEngine.toUpperCase()}**
- Architecture Pattern: Contract-first modular nodes with explicit dependency declarations.

## Working Agreement
1. Always check \`TASKS.md\` before beginning work.
2. Maintain strict file contracts and run extraction to verify dependency integrity.
3. Every completed task must be verified with automated or manual tests.
4. Follow \`LOOP.md\` autonomously.
`);

  safeWrite('LOOP.md', `
# ${name} — Development Loop

Follow this loop strictly for every task:
1. **Read & Select Task**: Pick the next uncompleted task in \`TASKS.md\`.
2. **Locking**: Acquire lock on target file(s) before making modifications.
3. **Implementation**: Implement code according to node contract.
4. **Verification**: Run tests or game launch to verify feature.
5. **Checkpoint**: Update \`TASKS.md\` checkbox to \`[x]\` and release lock.
`);

  safeWrite('TASKS.md', `
# Tasks: ${name}

## Phase 1 — Project Foundation
- [x] T001: Project structure initialized for ${normEngine}
- [ ] T002: Core game scene setup and viewport configuration
- [ ] T003: Player entity and input bindings

## Phase 2 — Core Gameplay Mechanics
- [ ] T004: Game loop and state manager
- [ ] T005: Collision handling and physics interactions
- [ ] T006: Score and inventory tracking

## Phase 3 — Polish & UI
- [ ] T007: HUD overlay and game over screen
- [ ] T008: Audio manager and sound effects
- [ ] T009: Final playtesting and release build
`);

  safeWrite('docs/ARCHITECTURE.md', `
# ${name} — Technical Architecture

## 1. Overview
${name} is built on ${normEngine.toUpperCase()}.

## 2. Directory Structure
${normEngine === 'godot' ? `
- \`scenes/\`: Godot packed scenes (.tscn)
- \`scripts/\`: GDScript game logic (.gd)
- \`assets/\`: Art, 3D models, textures, audio
` : normEngine === 'js' ? `
- \`src/\`: JavaScript modules
- \`public/\` or \`assets/\`: Static models and textures
` : `
- \`scenes/\` & \`scripts/\`: Godot engine files
- \`src/\`: Web/JS engine files
`}

## 3. Contracts & Dependencies
All scenes and modules expose explicit contracts (exports, signals, dependencies).
`);

  return {
    success: true,
    projectPath: absTarget,
    engine: normEngine,
    projectName: name,
    filesCreated: createdFiles
  };
}

/**
 * Parse project TASKS.md to extract phase progress and checkbox states (T052, T053).
 * @param {string} projectPath
 * @returns {Object} progress stats and phase breakdown
 */
export function parseProjectProgress(projectPath) {
  if (!projectPath) {
    return { hasTasks: false, error: 'No project path specified' };
  }

  const tasksFile = join(resolve(projectPath), 'TASKS.md');
  if (!existsSync(tasksFile)) {
    return {
      hasTasks: false,
      totalTasks: 0,
      completedTasks: 0,
      percent: 0,
      phases: []
    };
  }

  const stat = statSync(tasksFile);
  const content = readFileSync(tasksFile, 'utf-8');
  const lines = content.split('\n');

  const phases = [];
  let currentPhase = null;
  let totalTasks = 0;
  let completedTasks = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for Phase header (e.g. "## Phase 1 — Project Foundation" or "### Phase 2")
    const headerMatch = trimmed.match(/^#{2,3}\s+(.+)$/);
    if (headerMatch) {
      const title = headerMatch[1].trim();
      // Skip top-level title or non-phase headers like "Blocked / Needs Input"
      if (!title.toLowerCase().startsWith('blocked') && !title.toLowerCase().startsWith('notes')) {
        currentPhase = {
          title,
          tasks: [],
          total: 0,
          completed: 0,
          percent: 0
        };
        phases.push(currentPhase);
      }
      continue;
    }

    // Check for task checkbox: - [ ] or - [x]
    const taskMatch = trimmed.match(/^-\s*\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
      const isCompleted = taskMatch[1].toLowerCase() === 'x';
      const rawText = taskMatch[2].trim();

      // Extract optional task ID like "T001: Description"
      let taskId = '';
      let text = rawText;
      const idMatch = rawText.match(/^(T\d+):\s*(.*)$/);
      if (idMatch) {
        taskId = idMatch[1];
        text = idMatch[2];
      }

      const taskObj = {
        id: taskId,
        text,
        completed: isCompleted
      };

      totalTasks++;
      if (isCompleted) completedTasks++;

      if (!currentPhase) {
        currentPhase = {
          title: 'General Tasks',
          tasks: [],
          total: 0,
          completed: 0,
          percent: 0
        };
        phases.push(currentPhase);
      }

      currentPhase.tasks.push(taskObj);
      currentPhase.total++;
      if (isCompleted) currentPhase.completed++;
    }
  }

  // Calculate per-phase percentages
  for (const phase of phases) {
    phase.percent = phase.total > 0 ? Math.round((phase.completed / phase.total) * 100) : 0;
  }

  const overallPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return {
    hasTasks: true,
    totalTasks,
    completedTasks,
    percent: overallPercent,
    phases,
    lastModified: stat.mtimeMs
  };
}

/**
 * Parse AI response text containing ### FILE: <path> markers and fenced code blocks.
 * @param {string} text - Raw AI response
 * @returns {Array<{ path: string, content: string }>}
 */
export function parseAiFileBlocks(text) {
  if (!text || typeof text !== 'string') return [];
  const files = [];
  // Support flexible markdown: ### FILE: path, ## FILE: path, **FILE: path**, **### FILE: path**
  const regex = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:#{1,6}\s*)?FILE:\s*([^\r\n*`]+)(?:\*\*)?\s*\r?\n\s*```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const rawPath = match[1].trim().replace(/^[`*"]+|[`*"]+$/g, '').trim();
    const content = match[2];
    if (rawPath) {
      files.push({ path: rawPath, content });
    }
  }

  // Fallback if closing backticks missing at end of text
  if (files.length === 0) {
    const fallbackRegex = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:#{1,6}\s*)?FILE:\s*([^\r\n*`]+)(?:\*\*)?\s*\r?\n\s*```[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n```|$)/gi;
    while ((match = fallbackRegex.exec(text)) !== null) {
      const rawPath = match[1].trim().replace(/^[`*"]+|[`*"]+$/g, '').trim();
      const content = match[2];
      if (rawPath && !files.some(f => f.path === rawPath)) {
        files.push({ path: rawPath, content });
      }
    }
  }

  return files;
}

/**
 * Write parsed AI files into the project directory.
 * @param {string} projectPath - Absolute path to project root
 * @param {string} content - Raw AI response containing ### FILE: blocks
 * @returns {{ success: boolean, count: number, files: string[] }}
 */
export function writeAiFilesToProject(projectPath, content) {
  if (!projectPath || !existsSync(projectPath)) {
    throw new Error(`Project folder not found: "${projectPath}"`);
  }
  const files = parseAiFileBlocks(content);
  if (!files || files.length === 0) {
    throw new Error(
      "Zero files found matching the '### FILE: <path>' format.\n\n" +
      "Expected format:\n" +
      "### FILE: relative/path/to/file.ext\n" +
      "```\n" +
      "<full file contents>\n" +
      "```\n\n" +
      "Ask your browser AI to reformat its response with ### FILE: blocks."
    );
  }

  const written = [];
  for (const f of files) {
    // Prevent directory traversal escape
    const norm = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (norm.includes('..')) {
      throw new Error(`Invalid file path with directory traversal: "${f.path}"`);
    }
    const absPath = join(projectPath, norm);
    const parent = resolve(absPath, '..');
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(absPath, f.content, 'utf-8');
    written.push(norm);
  }

  return {
    success: true,
    count: written.length,
    files: written
  };
}

/**
 * Scan project folder recursively and return all files on disk.
 * @param {string} projectPath - Absolute path to project root
 * @returns {Array<{ path: string, name: string, dir: string }>}
 */
export function getProjectFileTree(projectPath) {
  if (!projectPath || !existsSync(projectPath)) {
    throw new Error(`Project directory not found: "${projectPath}"`);
  }

  const results = [];
  const ignoredDirs = new Set(['.git', 'node_modules', '.godot', '.import']);

  function scanDir(relDir) {
    const absDir = relDir ? join(projectPath, relDir) : projectPath;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ignoredDirs.has(ent.name)) continue;
        const subRel = relDir ? `${relDir}/${ent.name}` : ent.name;
        scanDir(subRel);
      } else if (ent.isFile()) {
        const fileRel = relDir ? `${relDir}/${ent.name}` : ent.name;
        results.push({
          path: fileRel,
          name: ent.name,
          dir: relDir || '.'
        });
      }
    }
  }

  scanDir('');
  return results;
}

/**
 * Parse AI response text containing ### EDIT: <path> surgical patch blocks.
 * Format:
 * ### EDIT: relative/path.ext
 * <<<<<<< FIND
 * <exact original code snippet>
 * =======
 * <replacement code>
 * >>>>>>> REPLACE
 *
 * @param {string} text - Raw AI response
 * @returns {Array<{ path: string, find: string, replace: string }>}
 */
export function parseAiEditBlocks(text) {
  if (!text || typeof text !== 'string') return [];
  const edits = [];
  // Supports:
  // - ### EDIT: path or **EDIT: path** or EDIT: path or PATCH: path or UPDATE: path
  // - Optional opening code block: ```js
  // - <<<<<<< FIND or <<<<<<< SEARCH (with 3-7 angle brackets)
  // - ======= (with 3-7 equals)
  // - >>>>>>> REPLACE or >>>>>>> (with 3-7 angle brackets)
  // - Optional closing code block: ```
  const regex = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:#{1,6}\s*)?(?:EDIT|FILE|UPDATE|PATCH):\s*([^\r\n*`]+)(?:\*\*)?\s*\r?\n(?:\s*```[^\r\n]*\r?\n)?\s*<{3,7}\s*(?:FIND|SEARCH)[^\r\n]*\r?\n([\s\S]*?)\r?\n\s*={3,7}[^\r\n]*\r?\n([\s\S]*?)\r?\n\s*>{3,7}(?:\s*REPLACE)?[^\r\n]*(?:\r?\n\s*```)?/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const rawPath = match[1].trim().replace(/^[`*"]+|[`*"]+$/g, '').trim();
    const findText = match[2];
    const replaceText = match[3];
    if (rawPath) {
      edits.push({ path: rawPath, find: findText, replace: replaceText });
    }
  }
  return edits;
}

/**
/**
 * Multi-pass finder to locate target code in file content with maximum tolerance
 * for formatting variances, whitespace, indentation, line prefixes, and semantic variable anchors.
 * @param {string} fileContent
 * @param {string} findText
 * @returns {{ success: boolean, target?: string, occurrences: number, reason?: string }}
 */
export function findTargetMatch(fileContent, findText) {
  const normalizedFile = fileContent.replace(/\r\n/g, '\n');
  const normalizedFind = findText.replace(/\r\n/g, '\n');

  // Pass 1: Exact substring match
  const exactCount = normalizedFile.split(normalizedFind).length - 1;
  if (exactCount === 1) {
    return { success: true, target: normalizedFind, occurrences: 1 };
  }
  if (exactCount > 1) {
    return { success: false, occurrences: exactCount, reason: `matched ${exactCount} times` };
  }

  // Pass 2: Line number prefixes (e.g. "> 42 | code" or " 42 | code")
  if (/^(?:\s*>\s*)?\s*\d+\s*\|\s?/m.test(normalizedFind)) {
    const stripped = normalizedFind.replace(/^(?:\s*>\s*)?\s*\d+\s*\|\s?/gm, '');
    const strippedCount = normalizedFile.split(stripped).length - 1;
    if (strippedCount === 1) {
      return { success: true, target: stripped, occurrences: 1 };
    }
  }

  const fileLines = normalizedFile.split('\n');
  const findLines = normalizedFind.split('\n');

  // Pass 3: Line-by-line whitespace-tolerant match (trimEnd)
  let trimEndMatches = [];
  for (let j = 0; j <= fileLines.length - findLines.length; j++) {
    let lineMatch = true;
    for (let k = 0; k < findLines.length; k++) {
      if (fileLines[j + k].trimEnd() !== findLines[k].trimEnd()) {
        lineMatch = false;
        break;
      }
    }
    if (lineMatch) {
      trimEndMatches.push(j);
    }
  }
  if (trimEndMatches.length === 1) {
    const matched = fileLines.slice(trimEndMatches[0], trimEndMatches[0] + findLines.length).join('\n');
    return { success: true, target: matched, occurrences: 1 };
  }
  if (trimEndMatches.length > 1) {
    return { success: false, occurrences: trimEndMatches.length, reason: `matched ${trimEndMatches.length} times` };
  }

  // Pass 4: Indentation-tolerant line match (trim on both sides)
  let trimMatches = [];
  for (let j = 0; j <= fileLines.length - findLines.length; j++) {
    let lineMatch = true;
    for (let k = 0; k < findLines.length; k++) {
      if (fileLines[j + k].trim() !== findLines[k].trim()) {
        lineMatch = false;
        break;
      }
    }
    if (lineMatch) {
      trimMatches.push(j);
    }
  }
  if (trimMatches.length === 1) {
    const matched = fileLines.slice(trimMatches[0], trimMatches[0] + findLines.length).join('\n');
    return { success: true, target: matched, occurrences: 1 };
  }
  if (trimMatches.length > 1) {
    return { success: false, occurrences: trimMatches.length, reason: `matched ${trimMatches.length} times` };
  }

  // Pass 5: Boundary Anchor Matching for multi-line blocks (>= 3 lines)
  if (findLines.length >= 3) {
    const firstLineTrim = findLines[0].trim();
    const lastLineTrim = findLines[findLines.length - 1].trim();

    if (firstLineTrim.length >= 4 && lastLineTrim.length >= 2) {
      let anchorMatches = [];
      for (let j = 0; j < fileLines.length; j++) {
        if (fileLines[j].trim() === firstLineTrim) {
          const minEnd = Math.max(j + 2, j + findLines.length - 4);
          const maxEnd = Math.min(fileLines.length - 1, j + findLines.length + 4);
          for (let k = minEnd; k <= maxEnd; k++) {
            if (fileLines[k].trim() === lastLineTrim) {
              const candSlice = fileLines.slice(j, k + 1);
              let nonBlankMatches = 0;
              let nonBlankFindCount = 0;
              for (const fl of findLines) {
                const ft = fl.trim();
                if (ft) {
                  nonBlankFindCount++;
                  if (candSlice.some(cl => cl.trim() === ft)) {
                    nonBlankMatches++;
                  }
                }
              }
              if (nonBlankFindCount > 0 && (nonBlankMatches / nonBlankFindCount) >= 0.55) {
                anchorMatches.push({ start: j, end: k });
              }
            }
          }
        }
      }
      if (anchorMatches.length === 1) {
        const matched = fileLines.slice(anchorMatches[0].start, anchorMatches[0].end + 1).join('\n');
        return { success: true, target: matched, occurrences: 1 };
      }
    }
  }

  // Pass 6: Consecutive Variable Declaration Anchor Matching
  const varMatches = [...normalizedFind.matchAll(/(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/g)].map(m => m[1]);
  if (varMatches.length >= 2) {
    const firstVar = varMatches[0];
    const lastVar = varMatches[varMatches.length - 1];
    let varCandStarts = [];
    for (let j = 0; j < fileLines.length; j++) {
      if (new RegExp(`(?:const|let|var)\\s+${firstVar}\\s*=`).test(fileLines[j])) {
        varCandStarts.push(j);
      }
    }
    if (varCandStarts.length === 1) {
      const startLine = varCandStarts[0];
      let endLine = -1;
      for (let j = startLine; j < Math.min(fileLines.length, startLine + findLines.length + 15); j++) {
        if (new RegExp(`(?:const|let|var)\\s+${lastVar}\\s*=`).test(fileLines[j])) {
          for (let k = j; k < Math.min(fileLines.length, j + 8); k++) {
            if (/[;}]\s*$/.test(fileLines[k].trim())) {
              endLine = k;
              break;
            }
          }
          break;
        }
      }
      if (endLine >= startLine) {
        const matched = fileLines.slice(startLine, endLine + 1).join('\n');
        return { success: true, target: matched, occurrences: 1 };
      }
    }
  }

  return { success: false, occurrences: 0, reason: 'could not find exact FIND text' };
}

/**
 * Apply surgical edits (patches) to files in the project.
 * @param {string} projectPath - Absolute path to project root
 * @param {string} content - Raw AI response containing ### EDIT: blocks
 * @returns {{ success: boolean, count: number, total: number, files: string[], type: 'edit' }}
 */
export function applyAiEditBlocks(projectPath, content) {
  if (!projectPath || !existsSync(projectPath)) {
    throw new Error(`Project folder not found: "${projectPath}"`);
  }

  const edits = parseAiEditBlocks(content);
  if (!edits || edits.length === 0) {
    throw new Error(
      "Zero blocks found matching the '### EDIT: <path>' format.\n\n" +
      "Expected format:\n" +
      "### EDIT: relative/path/to/file.ext\n" +
      "<<<<<<< FIND\n" +
      "<exact original code snippet>\n" +
      "=======\n" +
      "<replacement code>\n" +
      ">>>>>>> REPLACE"
    );
  }

  // Group edits by file to apply sequentially
  const editsByFile = new Map();
  for (const edit of edits) {
    const norm = edit.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (norm.includes('..')) {
      throw new Error(`Invalid file path with directory traversal: "${edit.path}"`);
    }
    if (!editsByFile.has(norm)) editsByFile.set(norm, []);
    editsByFile.get(norm).push(edit);
  }

  const appliedEdits = [];
  const failedEdits = [];
  const modifiedFiles = [];

  for (const [normPath, fileEdits] of editsByFile.entries()) {
    const absPath = join(projectPath, normPath);
    if (!existsSync(absPath)) {
      fileEdits.forEach((edit, idx) => {
        failedEdits.push({
          path: normPath,
          index: idx + 1,
          find: edit.find,
          reason: `Target file "${normPath}" does not exist in project for EDIT block.`
        });
      });
      continue;
    }

    let fileContent = readFileSync(absPath, 'utf-8');
    let normalizedFile = fileContent.replace(/\r\n/g, '\n');
    let fileModified = false;

    for (let i = 0; i < fileEdits.length; i++) {
      const edit = fileEdits[i];
      const matchResult = findTargetMatch(normalizedFile, edit.find);

      if (matchResult.success && matchResult.target) {
        normalizedFile = normalizedFile.replace(matchResult.target, edit.replace.replace(/\r\n/g, '\n'));
        fileModified = true;
        appliedEdits.push({ path: normPath, index: i + 1 });
      } else {
        failedEdits.push({
          path: normPath,
          index: i + 1,
          find: edit.find,
          reason: matchResult.reason || 'could not find exact FIND text'
        });
      }
    }

    if (fileModified) {
      writeFileSync(absPath, normalizedFile, 'utf-8');
      modifiedFiles.push(normPath);
    }
  }

  // If zero edits succeeded across all files, throw descriptive error
  if (appliedEdits.length === 0) {
    const firstFail = failedEdits[0];
    const isMultiple = firstFail && firstFail.reason && firstFail.reason.includes('matched');
    if (isMultiple) {
      throw new Error(
        `In file "${firstFail.path}" (edit block ${firstFail.index}): FIND text ${firstFail.reason}. ` +
        `The snippet must be uniquely identifiable. Please ask the AI to include more surrounding lines.`
      );
    }
    throw new Error(
      `In file "${firstFail.path}" (edit block ${firstFail.index}): could not find exact FIND text:\n` +
      `--------------------\n` +
      `${firstFail.find}\n` +
      `--------------------\n` +
      `Please ask the AI to regenerate the patch with more surrounding context.`
    );
  }

  return {
    success: true,
    partial: failedEdits.length > 0,
    count: appliedEdits.length,
    total: edits.length,
    files: modifiedFiles,
    appliedEdits,
    failedBlocks: failedEdits,
    type: 'edit',
    message: failedEdits.length > 0
      ? `Applied ${appliedEdits.length} of ${edits.length} edit blocks to ${modifiedFiles.join(', ')}. ${failedEdits.length} block(s) did not match.`
      : `Successfully applied all ${appliedEdits.length} edit blocks.`
  };
}
