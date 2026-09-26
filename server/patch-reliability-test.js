/**
 * server/patch-reliability-test.js
 * Comprehensive tests for Phase 17: Patch Safety & Reliability
 * - T077: Pre-save in-memory syntax check (JS + GDScript), Reject vs Apply Anyway
 * - T078: Whitespace/formatting drift tolerance in findTargetMatch
 * - T079: Overlapping edit block handling & sequential re-anchor
 * - T080: Interactive diff preview generator & POST /preview-diff
 * - T081: Smart target-file auto-attach from stack-trace file:line references
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  findTargetMatch,
  applyAiEditBlocks,
  writeAiFilesToProject
} from './project-init.js';

import { validateContentSyntax } from './console-manager.js';
import { generateUnifiedDiff } from './diff-generator.js';
import { rankRelevantFiles } from './context-compiler.js';
import { extractScopedSnippet } from './outline.js';

test('Phase 17: Patch Safety & Reliability Tests', async (t) => {
  // --- T077: Pre-save in-memory syntax check ---
  await t.test('T077: validateContentSyntax verifies valid JS and catches invalid syntax in memory', () => {
    const validJs = 'export const greeting = "hello world";\nexport function add(a, b) { return a + b; }';
    const invalidJs = 'export const greeting = "hello world";\nexport function add(a, b) { return a + ; }';

    const validRes = validateContentSyntax('test.js', validJs);
    assert.strictEqual(validRes.valid, true, 'Valid JS must pass');

    const invalidRes = validateContentSyntax('test.js', invalidJs);
    assert.strictEqual(invalidRes.valid, false, 'Invalid JS must fail syntax check');
    assert.ok(invalidRes.error.includes('Unexpected token') || invalidRes.error.includes('Syntax error'));
  });

  await t.test('T077: validateContentSyntax verifies GDScript delimiters and statement colons', () => {
    const validGd = [
      'extends Node',
      'var health: int = 100',
      'func take_damage(amount: int) -> void:',
      '\tif health > 0:',
      '\t\thealth -= amount'
    ].join('\n');

    const invalidGdColon = [
      'extends Node',
      'func take_damage(amount: int)' // missing trailing colon
    ].join('\n');

    const invalidGdDelimiter = [
      'extends Node',
      'func _ready():',
      '\tvar arr = [1, 2, 3' // missing closing bracket
    ].join('\n');

    assert.strictEqual(validateContentSyntax('player.gd', validGd).valid, true, 'Valid GDScript should pass');

    const colonRes = validateContentSyntax('player.gd', invalidGdColon);
    assert.strictEqual(colonRes.valid, false, 'Missing colon must fail');
    assert.ok(colonRes.error.includes('trailing colon'));

    const delimRes = validateContentSyntax('player.gd', invalidGdDelimiter);
    assert.strictEqual(delimRes.valid, false, 'Unclosed delimiter must fail');
    assert.ok(delimRes.error.includes('Unclosed'));
  });

  await t.test('T077: validateContentSyntax accepts hex colors, Windows paths, and triple-quoted docstrings in GDScript', () => {
    // 1. Hex color assignment with hash character inside quotes and trailing comment
    const hexGd = [
      'extends Node',
      'const THEME_COLOR: String = "#ff00ff" # Neon magenta accent',
      'const BG_COLOR = "#0a0a1a"',
      'func _ready() -> void:',
      '\tpass'
    ].join('\n');
    const hexRes = validateContentSyntax('colors.gd', hexGd);
    assert.strictEqual(hexRes.valid, true, `Hex color GDScript must pass, got error: ${hexRes.error}`);

    // 2. Windows-style path string with backslashes and trailing backslash before closing quote
    const winPathGd = [
      'extends Node',
      'var save_path: String = "C:\\\\Users\\\\player\\\\games\\\\save.dat"',
      'var folder_path: String = "C:\\\\GodotProjects\\\\Game\\\\"',
      'func load_data() -> void:',
      '\tpass'
    ].join('\n');
    const winRes = validateContentSyntax('paths.gd', winPathGd);
    assert.strictEqual(winRes.valid, true, `Windows path GDScript must pass, got error: ${winRes.error}`);

    // 3. Multi-line triple-quoted string block with comments, delimiters, and function headers inside
    const tripleGd = [
      'extends Node',
      'var doc: String = """',
      'Multi-line docstring block.',
      '# This hash is inside a string, not a real comment.',
      'func fake_signature():',
      'Balanced or unbalanced (delimiters [inside strings',
      '"""',
      'func _ready() -> void:',
      '\tpass'
    ].join('\n');
    const tripleRes = validateContentSyntax('docs.gd', tripleGd);
    assert.strictEqual(tripleRes.valid, true, `Triple-quoted GDScript must pass, got error: ${tripleRes.error}`);
  });

  await t.test('T077: applyAiEditBlocks blocks disk write on syntax error unless applyAnyway is passed', () => {
    const testDir = join(tmpdir(), `cf-test-syntax-${Date.now()}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    const filePath = join(testDir, 'src/player.js');
    const originalCode = 'export function move() {\n  return "moving";\n}\n';
    writeFileSync(filePath, originalCode, 'utf-8');

    // Broken patch with syntax error (missing operand in return)
    const brokenPatch = [
      '### EDIT: src/player.js',
      '<<<<<<< FIND',
      '  return "moving";',
      '=======',
      '  return + ;',
      '>>>>>>> REPLACE'
    ].join('\n');

    // 1. Without applyAnyway: must reject pre-check and NOT modify disk
    const resPreCheck = applyAiEditBlocks(testDir, brokenPatch, { applyAnyway: false });
    assert.strictEqual(resPreCheck.success, false, 'Pre-check must fail');
    assert.strictEqual(resPreCheck.preCheckFailed, true);
    assert.strictEqual(resPreCheck.canApplyAnyway, true);
    // Confirm disk file was NOT modified
    const diskContentAfterPreCheck = readFileSync(filePath, 'utf-8');
    assert.strictEqual(diskContentAfterPreCheck, originalCode, 'Disk file must remain untouched after pre-check failure');

    // 2. With applyAnyway: true -> allows forced save
    const resForced = applyAiEditBlocks(testDir, brokenPatch, { applyAnyway: true });
    assert.strictEqual(resForced.success, true, 'Forced save must succeed');
    const diskContentAfterForced = readFileSync(filePath, 'utf-8');
    assert.ok(diskContentAfterForced.includes('return + ;'), 'File should now be updated on disk');

    rmSync(testDir, { recursive: true, force: true });
  });

  // --- T078: Whitespace and formatting drift tolerance ---
  await t.test('T078: findTargetMatch matches across internal whitespace variances and blank-line drift', () => {
    const fileContent = [
      'export class Player {',
      '  constructor(name, speed) {',
      '    this.name = name;',
      '    this.speed = speed;',
      '  }',
      '',
      '  update(delta) {',
      '    this.move(delta);',
      '  }',
      '}'
    ].join('\n');

    // Internal whitespace drift (e.g. "constructor( name,   speed )")
    const driftedWhitespaceFind = [
      '  constructor( name,   speed ) {',
      '    this.name = name;',
      '    this.speed = speed;',
      '  }'
    ].join('\n');

    const wsMatch = findTargetMatch(fileContent, driftedWhitespaceFind);
    assert.strictEqual(wsMatch.success, true, 'Must match across internal spacing variance');

    // Blank-line drift (omitted empty line between constructor and update)
    const blankDriftFind = [
      '    this.speed = speed;',
      '  }',
      '  update(delta) {'
    ].join('\n');

    const blankMatch = findTargetMatch(fileContent, blankDriftFind);
    assert.strictEqual(blankMatch.success, true, 'Must match across blank-line drift');
  });

  // --- T079: Overlapping edit block handling ---
  await t.test('T079: applyAiEditBlocks diagnoses and re-anchors sequential/overlapping edit blocks', () => {
    const testDir = join(tmpdir(), `cf-test-overlap-${Date.now()}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    const filePath = join(testDir, 'src/combat.js');
    const initialCode = [
      'export function handleAttack(player, target) {',
      '  const damage = player.attack;',
      '  target.health -= damage;',
      '  return target.health > 0;',
      '}'
    ].join('\n');
    writeFileSync(filePath, initialCode, 'utf-8');

    // Block 1 replaces damage calculation; Block 2 replaces the return statement using lines around it
    const sequentialPatch = [
      '### EDIT: src/combat.js',
      '<<<<<<< FIND',
      '  const damage = player.attack;',
      '=======',
      '  const damage = Math.max(1, player.attack - target.defense);',
      '>>>>>>> REPLACE',
      '',
      '### EDIT: src/combat.js',
      '<<<<<<< FIND',
      '  target.health -= damage;',
      '  return target.health > 0;',
      '=======',
      '  target.health -= damage;',
      '  return { alive: target.health > 0, damage };',
      '>>>>>>> REPLACE'
    ].join('\n');

    const result = applyAiEditBlocks(testDir, sequentialPatch);
    assert.strictEqual(result.success, true, 'Sequential non-conflicting blocks should apply cleanly');
    const updated = readFileSync(filePath, 'utf-8');
    assert.ok(updated.includes('Math.max(1, player.attack - target.defense)'));
    assert.ok(updated.includes('alive: target.health > 0'));

    rmSync(testDir, { recursive: true, force: true });
  });

  // --- T080: Diff Preview Generator ---
  await t.test('T080: generateUnifiedDiff produces structured additions and deletions', () => {
    const before = 'line 1\nline 2\nline 3\nline 4';
    const after = 'line 1\nline 2 modified\nline 3\nline 4';

    const diff = generateUnifiedDiff(before, after);
    assert.ok(Array.isArray(diff), 'Diff should be an array of chunks');

    const deletes = diff.filter(c => c.type === 'delete');
    const adds = diff.filter(c => c.type === 'add');
    const contexts = diff.filter(c => c.type === 'context');

    assert.strictEqual(deletes.length, 1);
    assert.strictEqual(deletes[0].line, 'line 2');
    assert.strictEqual(adds.length, 1);
    assert.strictEqual(adds[0].line, 'line 2 modified');
    assert.ok(contexts.length >= 2, 'Should have surrounding context lines');
  });

  // --- T081: Smart target-file auto-attach with file:line reference ---
  await t.test('T081: rankRelevantFiles parses stack trace file:line and extracts focused window in extractScopedSnippet', () => {
    const testDir = join(tmpdir(), `cf-test-rank-${Date.now()}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    const targetJs = join(testDir, 'src/main.js');

    const lines = [];
    for (let i = 1; i <= 250; i++) {
      if (i === 232) {
        lines.push('    this.comboDisplay.classList.add("active"); // line 232 error');
      } else {
        lines.push(`    const dummy_${i} = ${i};`);
      }
    }
    const fullMainJs = lines.join('\n');
    writeFileSync(targetJs, fullMainJs, 'utf-8');

    const stackLog = [
      "SCRIPT ERROR: TypeError: can't access property \"classList\", this.comboDisplay is null",
      '          at: (src/main.js:232:7)',
      '          start@http://localhost:5173/src/main.js:171:10'
    ].join('\n');

    const ranked = rankRelevantFiles({
      projectPath: testDir,
      issueDescription: 'Next refinement step',
      consoleLogs: stackLog
    });

    assert.ok(ranked.length > 0, 'Must rank files from stack trace');
    const top = ranked[0];
    assert.strictEqual(top.file, 'src/main.js');
    assert.strictEqual(top.line, 232, 'Must extract line 232 from stack trace');

    // Verify extractScopedSnippet zooms into the line 232 window
    const snippet = extractScopedSnippet(fullMainJs, top.line, 'src/main.js');
    assert.ok(snippet, 'Scoped snippet should be extracted');
    assert.strictEqual(snippet.targetLine, 232);
    assert.ok(snippet.startLine <= 232 && snippet.endLine >= 232);
    assert.ok(snippet.snippet.includes('this.comboDisplay.classList.add("active")'));

    rmSync(testDir, { recursive: true, force: true });
  });
});
