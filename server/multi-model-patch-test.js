/**
 * server/multi-model-patch-test.js
 *
 * Automated test suite for Phase 22: Multi-Model Patch-Format Robustness (T096, T097).
 * Tests literal AI responses from Claude, ChatGPT, Gemini, and DeepSeek against
 * real target project files and verifies:
 * 1. Robust parsing of diverse markdown fencing, bold wrappers, and header styles.
 * 2. Successful surgical application without syntax degradation.
 * 3. Indentation drift tolerance (spaces vs tabs in GDScript).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  parseAiEditBlocks,
  applyAiEditBlocks
} from './project-init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, '..', 'test-fixtures', 'multi-model-patches');

test('Phase 22: Multi-Model Patch-Format Robustness Tests', async (t) => {
  const claudeText = readFileSync(join(fixturesDir, 'claude-response.txt'), 'utf-8');
  const chatgptText = readFileSync(join(fixturesDir, 'chatgpt-response.txt'), 'utf-8');
  const geminiText = readFileSync(join(fixturesDir, 'gemini-response.txt'), 'utf-8');
  const deepseekText = readFileSync(join(fixturesDir, 'deepseek-response.txt'), 'utf-8');

  await t.test('T096: parseAiEditBlocks extracts edit blocks from Claude format', () => {
    const edits = parseAiEditBlocks(claudeText);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].path, 'scripts/Player.gd');
    assert.ok(edits[0].find.includes('health -= amount'));
    assert.ok(edits[0].replace.includes('health_changed.emit'));
  });

  await t.test('T096: parseAiEditBlocks extracts edit blocks from ChatGPT format (wrapped in markdown code block)', () => {
    const edits = parseAiEditBlocks(chatgptText);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].path, 'scripts/Player.gd');
    assert.ok(edits[0].find.includes('health -= amount'));
    assert.ok(edits[0].replace.includes('health_changed.emit'));
  });

  await t.test('T096: parseAiEditBlocks extracts edit blocks from Gemini format (bold header, backtick path, gdscript fence)', () => {
    const edits = parseAiEditBlocks(geminiText);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].path, 'scripts/Player.gd');
    assert.ok(edits[0].find.includes('health -= amount'));
    assert.ok(edits[0].replace.includes('health_changed.emit'));
  });

  await t.test('T096: parseAiEditBlocks extracts edit blocks from DeepSeek format (bold EDIT header, 4-space indentation)', () => {
    const edits = parseAiEditBlocks(deepseekText);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].path, 'scripts/Player.gd');
    assert.ok(edits[0].find.includes('health -= amount'));
    assert.ok(edits[0].replace.includes('health_changed.emit'));
  });

  await t.test('T097: applyAiEditBlocks applies each model fixture cleanly to a real GDScript target file', () => {
    const originalGdScript = [
      'extends CharacterBody2D',
      '',
      'signal died()',
      'signal health_changed(new_value: int)',
      '',
      'var health: int = 100',
      '',
      'func take_damage(amount: int) -> void:',
      '\thealth -= amount',
      '',
      'func get_health() -> int:',
      '\treturn health'
    ].join('\n');

    const models = [
      { name: 'Claude', text: claudeText },
      { name: 'ChatGPT', text: chatgptText },
      { name: 'Gemini', text: geminiText },
      { name: 'DeepSeek', text: deepseekText }
    ];

    for (const model of models) {
      const sandbox = join(tmpdir(), `cf-model-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
      mkdirSync(join(sandbox, 'scripts'), { recursive: true });
      const targetFile = join(sandbox, 'scripts', 'Player.gd');
      writeFileSync(targetFile, originalGdScript, 'utf-8');

      try {
        const result = applyAiEditBlocks(sandbox, model.text, { preCheckSyntax: true });
        assert.ok(result.success, `${model.name} patch must succeed`);
        assert.ok(!result.preCheckFailed, `${model.name} should not fail pre-check`);

        const updated = readFileSync(targetFile, 'utf-8');
        assert.ok(updated.includes('health = max(0, health - amount)'), `${model.name} patch must apply replacement`);
        assert.ok(updated.includes('health_changed.emit(health)'));
        assert.ok(!updated.includes('health -= amount'));
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });
});
