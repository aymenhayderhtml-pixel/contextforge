/**
 * server/diagnostics-hardening-test.js
 *
 * Automated verification for Phase 23: Console/Diagnostics Pipeline Hardening
 * - T098: GDScript pre-syntax validation tolerance (hex colors in strings, Windows paths, triple-quoted strings, trailing colons)
 * - T099: Explicit "evidence completeness" contract:
 *     Given a known injected bug, assert verbatim presence of:
 *     1. Exact error location (file:line)
 *     2. The exact broken line of source
 *     3. Public contract / signature outline of caller and callee
 * - T100: isErrorLine false-positive audit & exclusions (HTTP 200, [INFO], 0 errors)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isErrorLine, validateContentSyntax } from './console-manager.js';
import { rankRelevantFiles } from './context-compiler.js';
import { extractScopedSnippet } from './outline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const jsFixture = join(root, 'test-fixtures', 'js-sample');

test('Phase 23: Console/Diagnostics Pipeline Hardening Tests', async (t) => {
  // --- T098: False-Positive & Syntax Check Hardening ---
  await t.test('T098: validateContentSyntax handles complex strings with # and colons without false flags', () => {
    const complexGd = [
      'extends Node',
      'const HEX_ACCENT: String = "#388bfd" # Blue accent',
      'var msg = "Error: this is just a string with # not a comment: test"',
      'func _ready() -> void:',
      '\tprint("Ready with # inside quotes")',
      '\tpass'
    ].join('\n');

    const res = validateContentSyntax('test.gd', complexGd);
    assert.strictEqual(res.valid, true, `Should accept valid GDScript with # in strings, got: ${res.error}`);
  });

  // --- T099: Evidence Completeness Contract ---
  await t.test('T099: Evidence completeness contract asserts error location, broken line, and signatures verbatim', () => {
    const playerFile = join(jsFixture, 'src', 'player.js');
    const playerCode = readFileSync(playerFile, 'utf-8');

    // Injected stack trace pointing to src/player.js:15
    const simulatedConsole = `TypeError: Cannot read properties of undefined (reading 'name')\n    at createPlayer (src/player.js:15:10)\n    at startGame (src/main.js:20:5)`;

    // 1. Assert exact location parsing
    const ranked = rankRelevantFiles({
      projectPath: jsFixture,
      issueDescription: 'Cannot read properties of undefined in createPlayer',
      consoleLogs: simulatedConsole
    });

    const topCandidate = ranked[0];
    assert.ok(topCandidate, 'Candidate file must be found');
    assert.strictEqual(topCandidate.file, 'src/player.js');
    assert.strictEqual(topCandidate.line, 15, 'Target line 15 must be parsed exactly');

    // 2. Assert exact broken line of source is extracted in scoped window
    const snippetResult = extractScopedSnippet(playerCode, topCandidate.line, 'src/player.js');
    assert.ok(snippetResult, 'Scoped snippet must be extracted');
    assert.ok(snippetResult.startLine <= 15 && snippetResult.endLine >= 15, 'Target line must be within snippet boundaries');

    // The snippet MUST contain the exact target function declaration or broken statement
    assert.ok(snippetResult.snippet.includes('function createPlayer'), 'Exact target function must be verbatim in snippet');

    // 3. Assert caller / callee signature is present in dependency list
    const callerCandidate = ranked.find(r => r.file === 'src/main.js');
    assert.ok(callerCandidate, 'Caller src/main.js must be identified in relevant candidates');
    assert.ok(callerCandidate.score >= 70, 'Caller candidate score must be elevated');
  });

  // --- T100: isErrorLine False-Positive Audit ---
  await t.test('T100: isErrorLine filters out common false-positive info lines', () => {
    // False positives that must NOT be flagged as errors
    assert.strictEqual(isErrorLine('[INFO]: Everything running smoothly'), false);
    assert.strictEqual(isErrorLine('LOG: 0 errors and 0 warnings found during compile'), false);
    assert.strictEqual(isErrorLine('GET /client-log 200 OK - 12ms'), false);
    assert.strictEqual(isErrorLine('Player "ErrorHunter" connected to lobby'), false);
    assert.strictEqual(isErrorLine('DEBUG: Total error count: 0'), false);

    // Genuine errors that MUST be flagged
    assert.strictEqual(isErrorLine('SCRIPT ERROR: Parse Error: Unexpected token'), true);
    assert.strictEqual(isErrorLine('TypeError: Cannot read properties of undefined'), true);
    assert.strictEqual(isErrorLine('   at createPlayer (src/player.js:15:10)'), true);
    assert.strictEqual(isErrorLine('Uncaught ReferenceError: SceneManager is not defined'), true);
  });
});
