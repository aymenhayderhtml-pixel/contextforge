/**
 * server/asset-graph-test.js — Test suite for Phase 7 (Asset Graph):
 * - T027: Assets as leaf nodes with declared slot contracts (animations, format, dimensions)
 * - T028: Drag-and-drop replacement & slot contract validation
 *
 * Run: node server/asset-graph-test.js
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { extract as extractJs } from './extractors/js-extractor.js';
import { extract as extractGodot } from './extractors/godot-extractor.js';
import { validateManifest } from './schema/validate.js';
import {
  parseSlotContract,
  inspectAssetFile,
  validateAssetAgainstSlot,
  parseInCodeSlotHints
} from './slot-contract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const jsFixture = join(projectRoot, 'test-fixtures', 'js-sample');
const godotFixture = join(projectRoot, 'test-fixtures', 'godot-sample');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('Phase 7 — Asset Graph & Slot Contract tests:\n');

// ── T027: Asset Slot Contract Extraction ──

const jsResult = await extractJs(jsFixture);
const characterAsset = jsResult.nodes.find(n => n.id === 'models/character.glb');

test('T027: character.glb is an asset node', () => {
  assert(characterAsset, 'models/character.glb node not found');
  assert(characterAsset.type === 'asset', `Expected type=asset, got ${characterAsset.type}`);
  assert(characterAsset.engine === 'js', `Expected engine=js, got ${characterAsset.engine}`);
});

test('T027: asset node is a leaf node (depends_on is empty array)', () => {
  assert(characterAsset, 'models/character.glb node not found');
  assert(Array.isArray(characterAsset.depends_on), 'depends_on should be an array');
  assert(characterAsset.depends_on.length === 0, `Asset node must be a leaf node (depends_on: []), got ${characterAsset.depends_on}`);
});

test('T027: asset node has declared slot contract from companion .slot.json', () => {
  assert(characterAsset.slot, 'Missing slot property on asset node');
  assert(characterAsset.slot.slot === 'character', `Expected slot name 'character', got ${characterAsset.slot.slot}`);
  assert(characterAsset.slot.format === 'glb', `Expected format 'glb', got ${characterAsset.slot.format}`);
  assert(characterAsset.slot.rigged === true, `Expected rigged=true, got ${characterAsset.slot.rigged}`);

  const anims = characterAsset.slot.expected_animations;
  assert(Array.isArray(anims), 'expected_animations should be an array');
  assert(anims.includes('idle'), 'missing idle animation in slot contract');
  assert(anims.includes('run'), 'missing run animation in slot contract');
  assert(anims.includes('walk'), 'missing walk animation in slot contract');
});

test('T027: contract.exports reflects slot expectations as sorted signatures', () => {
  const exportsList = characterAsset.contract.exports;
  assert(Array.isArray(exportsList), 'exports should be an array');
  assert(exportsList.includes('animation: idle'), 'missing "animation: idle" in contract.exports');
  assert(exportsList.includes('animation: run'), 'missing "animation: run" in contract.exports');
  assert(exportsList.includes('animation: walk'), 'missing "animation: walk" in contract.exports');
  assert(exportsList.includes('format: glb'), 'missing "format: glb" in contract.exports');
  assert(exportsList.includes('rigged: true'), 'missing "rigged: true" in contract.exports');
});

test('T027: asset node contract has empty signals and requires arrays', () => {
  assert(Array.isArray(characterAsset.contract.signals) && characterAsset.contract.signals.length === 0,
    'signals should be empty array');
  assert(Array.isArray(characterAsset.contract.requires) && characterAsset.contract.requires.length === 0,
    'requires should be empty array');
});

test('T027: parsed in-code comment slot declarations for textures', () => {
  const code = `
    // @slot textures/player.png: format=png, dimensions=64x64
    const texture = loadTexture('textures/player.png');
  `;
  const hints = parseInCodeSlotHints(code);
  assert(hints['textures/player.png'], 'failed to parse in-code hint');
  assert(hints['textures/player.png'].format === 'png', 'hint format mismatch');
  assert(hints['textures/player.png'].dimensions === '64x64', 'hint dimensions mismatch');

  const slot = parseSlotContract('textures/player.png', jsFixture, hints);
  assert(slot.slot.format === 'png', 'slot format mismatch');
  assert(slot.slot.dimensions === '64x64', 'slot dimensions mismatch');
  assert(slot.exports.includes('dimensions: 64x64'), 'missing dimensions export');
  assert(slot.exports.includes('format: png'), 'missing format export');
});

test('T027: Godot extractor handles asset ext_resources as leaf nodes with slot contracts', async () => {
  const tmpGodotDir = join(projectRoot, 'test-fixtures', 'temp-godot-asset-test');
  const scenesDir = join(tmpGodotDir, 'scenes');
  const texturesDir = join(tmpGodotDir, 'textures');
  const { mkdirSync, rmSync } = await import('node:fs');

  mkdirSync(scenesDir, { recursive: true });
  mkdirSync(texturesDir, { recursive: true });

  try {
    writeFileSync(join(tmpGodotDir, 'project.godot'), 'config_version=5\n[application]\nconfig/name="TempTest"\n');
    writeFileSync(
      join(scenesDir, 'SpriteScene.tscn'),
      `[gd_scene load_steps=2 format=3]

[ext_resource type="Texture2D" path="res://textures/icon.png" id="1_tex"]

[node name="SpriteScene" type="Node2D"]
`
    );
    writeFileSync(
      join(texturesDir, 'icon.slot.json'),
      JSON.stringify({ slot: 'icon', format: 'png', dimensions: '64x64' }, null, 2)
    );

    const godotRes = await extractGodot(tmpGodotDir);
    const assetNode = godotRes.nodes.find(n => n.id === 'textures/icon.png');

    assert(assetNode, 'Asset node textures/icon.png was not extracted');
    assert(assetNode.type === 'asset', `Expected type=asset, got ${assetNode.type}`);
    assert(assetNode.engine === 'godot', `Expected engine=godot, got ${assetNode.engine}`);
    assert(Array.isArray(assetNode.depends_on) && assetNode.depends_on.length === 0, 'Asset must be a leaf node');
    assert(assetNode.slot.format === 'png', 'slot format mismatch');
    assert(assetNode.slot.dimensions === '64x64', 'slot dimensions mismatch');
    assert(assetNode.contract.exports.includes('dimensions: 64x64'), 'missing dimensions export');

    const edge = godotRes.edges.find(e => e.to === 'textures/icon.png');
    assert(edge, 'Missing edge to asset node');
    assert(edge.kind === 'asset_ref', `Expected kind=asset_ref, got ${edge.kind}`);
  } finally {
    rmSync(tmpGodotDir, { recursive: true, force: true });
  }
});

test('T027: JS extraction manifest validates against schema with asset slot', () => {
  const manifest = {
    project_root: jsFixture,
    generated_at: new Date().toISOString(),
    nodes: jsResult.nodes.map(n => ({ ...n, depended_on_by: [] })),
    edges: jsResult.edges
  };
  const val = validateManifest(manifest);
  assert(val.valid === true, `Validation failed: ${val.errors.join('; ')}`);
});

// ── T028: Asset File Inspection & Slot Contract Validation ──

// Helper: build minimal binary GLB buffer
function buildMockGlbBuffer(animationNames = ['idle', 'run', 'walk'], hasSkin = true) {
  const gltfJson = {
    asset: { version: '2.0', generator: 'ContextForge Test' },
    animations: animationNames.map(name => ({ name, channels: [], samplers: [] })),
    skins: hasSkin ? [{ joints: [0] }] : []
  };

  const jsonStr = JSON.stringify(gltfJson);
  const jsonBuffer = Buffer.from(jsonStr, 'utf-8');
  // Pad JSON chunk to 4-byte boundary with spaces
  const padLength = (4 - (jsonBuffer.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc(padLength, 0x20)]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'ascii'); // magic
  header.writeUInt32LE(2, 4);           // version
  header.writeUInt32LE(12 + 8 + paddedJson.length, 8); // total length

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(paddedJson.length, 0); // chunk length
  chunkHeader.writeUInt32LE(0x4E4F534A, 4);       // chunk type 'JSON'

  return Buffer.concat([header, chunkHeader, paddedJson]);
}

// Helper: build minimal binary PNG buffer (with IHDR)
function buildMockPngBuffer(width = 64, height = 64) {
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);            // IHDR chunk length
  ihdr.write('IHDR', 4, 4, 'ascii');    // IHDR chunk type
  ihdr.writeUInt32BE(width, 8);         // width
  ihdr.writeUInt32BE(height, 12);       // height
  ihdr.writeUInt8(8, 16);               // bit depth
  ihdr.writeUInt8(6, 17);               // color type (RGBA)
  // rest zero
  return Buffer.concat([header, ihdr]);
}

test('T028: inspects binary GLB asset file (extracts animations and rigging)', () => {
  const glb = buildMockGlbBuffer(['idle', 'run', 'walk'], true);
  const info = inspectAssetFile(glb, 'hero.glb');

  assert(info.format === 'glb', `Expected format glb, got ${info.format}`);
  assert(info.rigged === true, 'Expected rigged=true');
  assert(info.animations.length === 3, `Expected 3 animations, got ${info.animations.length}`);
  assert(info.animations.includes('idle'), 'missing idle');
  assert(info.animations.includes('run'), 'missing run');
  assert(info.animations.includes('walk'), 'missing walk');
});

test('T028: inspects binary PNG texture file (extracts dimensions)', () => {
  const png = buildMockPngBuffer(512, 256);
  const info = inspectAssetFile(png, 'texture.png');

  assert(info.format === 'png', `Expected format png, got ${info.format}`);
  assert(info.dimensions === '512x256', `Expected 512x256, got ${info.dimensions}`);
});

test('T028: validates asset matching full slot contract (valid=true)', () => {
  const slotContract = characterAsset.slot;
  const validGlb = buildMockGlbBuffer(['idle', 'run', 'walk', 'attack'], true);
  const info = inspectAssetFile(validGlb, 'character_v2.glb');

  const validation = validateAssetAgainstSlot(slotContract, info);
  assert(validation.valid === true, `Expected valid=true, got errors: ${validation.errors.join('; ')}`);
  assert(validation.errors.length === 0, 'errors array should be empty');
});

test('T028: detects missing expected animation in replacement asset (valid=false)', () => {
  const slotContract = characterAsset.slot; // expects: idle, run, walk
  const incompleteGlb = buildMockGlbBuffer(['idle', 'walk'], true); // missing 'run'!
  const info = inspectAssetFile(incompleteGlb, 'incomplete_hero.glb');

  const validation = validateAssetAgainstSlot(slotContract, info);
  assert(validation.valid === false, 'Expected valid=false due to missing animation');
  assert(validation.errors.length > 0, 'Expected errors');
  assert(
    validation.errors.some(e => e.includes('run') && e.includes('Missing required animation')),
    `Error message did not mention missing 'run' animation: ${JSON.stringify(validation.errors)}`
  );
});

test('T028: detects format mismatch in replacement asset (valid=false)', () => {
  const slotContract = characterAsset.slot; // expects: glb
  const wrongFormatAsset = buildMockPngBuffer(64, 64);
  const info = inspectAssetFile(wrongFormatAsset, 'hero_texture.png');

  const validation = validateAssetAgainstSlot(slotContract, info);
  assert(validation.valid === false, 'Expected valid=false due to format mismatch');
  assert(
    validation.errors.some(e => e.includes('Format mismatch') && e.includes('glb') && e.includes('png')),
    `Error message did not mention format mismatch: ${JSON.stringify(validation.errors)}`
  );
});

test('T028: detects texture dimension mismatch (valid=false)', () => {
  const textureSlot = {
    slot: 'ui_icon',
    format: 'png',
    dimensions: '64x64'
  };
  const badPng = buildMockPngBuffer(128, 128); // wrong dimensions!
  const info = inspectAssetFile(badPng, 'icon.png');

  const validation = validateAssetAgainstSlot(textureSlot, info);
  assert(validation.valid === false, 'Expected valid=false due to dimension mismatch');
  assert(
    validation.errors.some(e => e.includes('Dimension mismatch') && e.includes('64x64') && e.includes('128x128')),
    `Error did not mention dimension mismatch: ${JSON.stringify(validation.errors)}`
  );
});

test('T027: determinism confirmed on repeated extraction with asset nodes', async () => {
  const run1 = await extractJs(jsFixture);
  const run2 = await extractJs(jsFixture);
  assert(JSON.stringify(run1) === JSON.stringify(run2), 'Repeated runs must produce identical output');
});

// ── HTTP API Tests (Phase 7 Endpoints) ──

const BASE_URL = 'http://localhost:3000';
let serverRunning = false;
try {
  const ping = await fetch(`${BASE_URL}/manifest`).catch(() => null);
  serverRunning = !!ping;
} catch (_) {}

if (serverRunning) {
  console.log('\n--- HTTP API tests (server running on :3000) ---');

  // Extract JS project
  await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: jsFixture })
  });

  const charGlbPath = join(jsFixture, 'models/character.glb');

  try {
    await (async () => {
      // 1. Swap in valid GLB
      const validGlbBuf = buildMockGlbBuffer(['idle', 'run', 'walk'], true);
      const res1 = await fetch(`${BASE_URL}/swap-asset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: 'models/character.glb',
          fileName: 'hero_v1.glb',
          fileContent: validGlbBuf.toString('base64'),
          holder: 'user'
        })
      });

      test('T028: POST /swap-asset writes valid asset and returns validation.valid=true', () => {
        assert(res1.ok, `Status ${res1.status}`);
      });
      const data1 = await res1.json();
      test('T028: swap-asset response includes validation matching slot contract', () => {
        assert(data1.validation && data1.validation.valid === true, `Expected valid=true, got: ${JSON.stringify(data1.validation)}`);
        assert(data1.bytesWritten === validGlbBuf.length, 'bytesWritten mismatch');
        assert(existsSync(charGlbPath), 'file should exist on disk');
      });

      // 2. Validate asset on disk
      const resVal = await fetch(`${BASE_URL}/validate-asset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: 'models/character.glb' })
      });
      const dataVal = await resVal.json();
      test('T028: POST /validate-asset verifies asset on disk without swapping', () => {
        assert(resVal.ok, `Status ${resVal.status}`);
        assert(dataVal.validation.valid === true, 'Validation on disk should succeed');
      });

      // 3. Swap in incomplete GLB (missing 'run')
      const incompleteGlbBuf = buildMockGlbBuffer(['idle', 'walk'], true);
      const res2 = await fetch(`${BASE_URL}/swap-asset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: 'models/character.glb',
          fileName: 'hero_incomplete.glb',
          fileContent: incompleteGlbBuf.toString('base64'),
          holder: 'user'
        })
      });
      const data2 = await res2.json();
      test('T028: POST /swap-asset detects missing expected animation on write', () => {
        assert(res2.ok, `Status ${res2.status}`);
        assert(data2.validation.valid === false, 'Expected validation to fail');
        assert(data2.validation.errors.some(e => e.includes('run')), 'Error should mention missing animation');
      });

      // 4. Swap in wrong format (PNG for GLB slot)
      const wrongFormatBuf = buildMockPngBuffer(64, 64);
      const resFormat = await fetch(`${BASE_URL}/swap-asset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: 'models/character.glb',
          fileName: 'not_a_model.png',
          fileContent: wrongFormatBuf.toString('base64'),
          holder: 'user'
        })
      });
      const dataFormat = await resFormat.json();
      test('T028: POST /swap-asset detects format mismatch on write', () => {
        assert(resFormat.ok, `Status ${resFormat.status}`);
        assert(dataFormat.validation.valid === false, 'Expected validation to fail due to format mismatch');
        assert(dataFormat.validation.errors.some(e => e.includes('Format mismatch')), 'Error should mention format mismatch');
      });

      // 5. Lock safety check: lock node for agent-1, try swapping as agent-2
      await fetch(`${BASE_URL}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: 'models/character.glb', holder: 'agent-1' })
      });

      const resLockFail = await fetch(`${BASE_URL}/swap-asset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: 'models/character.glb',
          fileName: 'hero_agent2.glb',
          fileContent: validGlbBuf.toString('base64'),
          holder: 'agent-2'
        })
      });

      test('T028: POST /swap-asset rejects swap when node is locked by another holder', () => {
        assert(resLockFail.status === 403, `Expected 403, got ${resLockFail.status}`);
      });

      // Cleanup lock
      await fetch(`${BASE_URL}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: 'models/character.glb', force: true })
      });
    })();
  } finally {
    if (existsSync(charGlbPath)) {
      unlinkSync(charGlbPath);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
