/**
 * server/slot-contract.js — Slot contract parsing, inspection, and validation for asset nodes.
 *
 * Implements Phase 7 (Asset Graph):
 * - T027: Assets as leaf nodes with declared slot contracts (animations, format, dimensions)
 * - T028: Asset inspection and validation against slot contracts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// Known asset file extensions
export const ASSET_EXTENSIONS = new Set([
  '.glb', '.gltf', '.obj', '.fbx',           // 3D models
  '.png', '.jpg', '.jpeg', '.svg', '.webp',   // textures/images
  '.wav', '.ogg', '.mp3',                     // audio
  '.tres', '.res'                             // Godot resource files
]);

/**
 * Check if a file path or extension belongs to an asset.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isAssetFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  return ASSET_EXTENSIONS.has(ext);
}

/**
 * Find declared slot contract for an asset.
 *
 * Checks (in order of priority):
 * 1. Companion file: `<assetPath>.slot.json` or `<assetBase>.slot.json`
 * 2. Project-level registry: `slots.json` or `asset-slots.json`
 * 3. In-code comment hints: e.g. `// @slot ...` or `# @slot ...`
 * 4. Defaults based on file extension
 *
 * @param {string} assetId - relative path to asset, e.g. "models/character.glb"
 * @param {string} projectPath - absolute path to project root
 * @param {object} [hints={}] - in-code hints parsed from source
 * @returns {object} normalized slot contract
 */
export function findDeclaredSlot(assetId, projectPath, hints = {}) {
  const normId = assetId.replace(/\\/g, '/');
  const ext = extname(normId).toLowerCase();
  const formatDefault = ext.replace(/^\./, '');
  const baseNameNoExt = basename(normId, ext);

  let rawSlot = null;

  // 1. Companion file check:
  // e.g. models/character.slot.json or models/character.glb.slot.json
  const companionCandidates = [
    join(projectPath, normId + '.slot.json'),
    join(projectPath, normId.replace(/\.[^/.]+$/, '.slot.json'))
  ];

  for (const candidate of companionCandidates) {
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        rawSlot = JSON.parse(content);
        break;
      } catch (err) {
        console.warn(`Failed to parse companion slot file ${candidate}:`, err.message);
      }
    }
  }

  // 2. Project-level slot registry check:
  if (!rawSlot) {
    for (const regName of ['slots.json', 'asset-slots.json']) {
      const regPath = join(projectPath, regName);
      if (existsSync(regPath)) {
        try {
          const content = readFileSync(regPath, 'utf-8');
          const registry = JSON.parse(content);
          if (registry[normId] || registry[baseNameNoExt] || registry[basename(normId)]) {
            rawSlot = registry[normId] || registry[baseNameNoExt] || registry[basename(normId)];
            break;
          }
        } catch (err) {
          console.warn(`Failed to parse slot registry ${regPath}:`, err.message);
        }
      }
    }
  }

  // 3. Hints from source comments (if provided)
  if (!rawSlot && hints[normId]) {
    rawSlot = hints[normId];
  }

  // 4. Default contract
  if (!rawSlot) {
    rawSlot = {
      slot: baseNameNoExt,
      format: formatDefault
    };
  }

  // Normalize slot object
  const slotName = rawSlot.slot || rawSlot.name || baseNameNoExt;
  const format = (rawSlot.format || formatDefault).toLowerCase();

  // Normalize expected_animations
  let expectedAnimations = [];
  if (Array.isArray(rawSlot.expected_animations)) {
    expectedAnimations = [...rawSlot.expected_animations];
  } else if (Array.isArray(rawSlot.animations)) {
    expectedAnimations = [...rawSlot.animations];
  } else if (typeof rawSlot.expected_animations === 'string') {
    expectedAnimations = rawSlot.expected_animations.split(',').map(s => s.trim()).filter(Boolean);
  } else if (typeof rawSlot.animations === 'string') {
    expectedAnimations = rawSlot.animations.split(',').map(s => s.trim()).filter(Boolean);
  }
  expectedAnimations = [...new Set(expectedAnimations)].sort();

  const slotObj = {
    slot: slotName,
    format
  };

  if (expectedAnimations.length > 0) {
    slotObj.expected_animations = expectedAnimations;
  }
  if (rawSlot.dimensions) {
    slotObj.dimensions = String(rawSlot.dimensions);
  }
  if (rawSlot.rigged !== undefined) {
    slotObj.rigged = Boolean(rawSlot.rigged);
  }
  if (rawSlot.max_size_kb !== undefined) {
    slotObj.max_size_kb = Number(rawSlot.max_size_kb);
  }

  return slotObj;
}

/**
 * Build sorted array of human-readable strings for contract.exports
 * from a slot contract object.
 *
 * @param {object} slot
 * @returns {string[]}
 */
export function buildSlotContractExports(slot) {
  const exportsList = [];

  if (Array.isArray(slot.expected_animations)) {
    for (const anim of [...slot.expected_animations].sort()) {
      exportsList.push(`animation: ${anim}`);
    }
  }
  if (slot.dimensions) {
    exportsList.push(`dimensions: ${slot.dimensions}`);
  }
  if (slot.format) {
    exportsList.push(`format: ${slot.format}`);
  }
  if (slot.max_size_kb !== undefined && slot.max_size_kb !== null) {
    exportsList.push(`max_size_kb: ${slot.max_size_kb}`);
  }
  if (slot.rigged !== undefined && slot.rigged !== null) {
    exportsList.push(`rigged: ${slot.rigged}`);
  }

  return exportsList.sort();
}

/**
 * Parse an asset's full slot contract and format it for the manifest node.
 *
 * @param {string} assetId - relative path to asset, e.g. "models/character.glb"
 * @param {string} projectPath - absolute path to project root
 * @param {object} [hints={}] - in-code hints
 * @returns {{ slot: object, exports: string[] }}
 */
export function parseSlotContract(assetId, projectPath, hints = {}) {
  const slot = findDeclaredSlot(assetId, projectPath, hints);
  const exportsList = buildSlotContractExports(slot);
  return { slot, exports: exportsList };
}

/**
 * Parse inline comment annotations for slot contracts in source code.
 *
 * Supports patterns:
 *   // @slot <assetPath>: format=glb, animations=[idle, walk, run], dimensions=512x512
 *   # @slot <assetPath>: format=png, dimensions=64x64
 *   /* @slot <assetPath> { "format": "glb", "expected_animations": ["idle"] } *\/
 *
 * @param {string} content - source file content
 * @returns {Record<string, object>} map of asset path to parsed slot hint
 */
export function parseInCodeSlotHints(content) {
  const hints = {};
  if (!content) return hints;

  // JSON block format: @slot <path> { ... }
  const jsonRegex = /(?:\/\/|#|\/\*)\s*@slot\s+([^\s{]+)\s*(\{[^}]+\})/g;
  let match;
  while ((match = jsonRegex.exec(content)) !== null) {
    const assetPath = match[1].replace(/^res:\/\//, '').trim();
    try {
      hints[assetPath] = JSON.parse(match[2]);
    } catch (_) {}
  }

  // Key-value format: @slot <path>: key=val, key=[val1, val2]
  const kvRegex = /(?:\/\/|#)\s*@slot\s+([^:\n]+):\s*([^\n]+)/g;
  while ((match = kvRegex.exec(content)) !== null) {
    const assetPath = match[1].replace(/^res:\/\//, '').trim();
    const pairs = match[2];
    const parsed = {};

    const formatMatch = pairs.match(/format\s*=\s*([a-zA-Z0-9]+)/);
    if (formatMatch) parsed.format = formatMatch[1];

    const dimMatch = pairs.match(/dimensions?\s*=\s*([0-9]+x[0-9]+)/);
    if (dimMatch) parsed.dimensions = dimMatch[1];

    const riggedMatch = pairs.match(/rigged\s*=\s*(true|false)/);
    if (riggedMatch) parsed.rigged = riggedMatch[1] === 'true';

    const animMatch = pairs.match(/animations?\s*=\s*\[([^\]]*)\]/) ||
                      pairs.match(/animations?\s*=\s*([a-zA-Z0-9_,\s]+)/);
    if (animMatch) {
      parsed.expected_animations = animMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }

    hints[assetPath] = { ...(hints[assetPath] || {}), ...parsed };
  }

  return hints;
}

/**
 * Inspect an uploaded or on-disk asset file buffer/string.
 * Extracts format, animations (for 3D models), dimensions (for images), and rigging.
 *
 * @param {Buffer|string} bufferOrData
 * @param {string} fileName - original file name, e.g. "hero.glb"
 * @returns {object} { format, animations, dimensions, rigged, sizeBytes }
 */
export function inspectAssetFile(bufferOrData, fileName) {
  let buffer;
  if (Buffer.isBuffer(bufferOrData)) {
    buffer = bufferOrData;
  } else if (typeof bufferOrData === 'string') {
    // Check if base64 encoded
    const base64Prefix = /^data:[^;]+;base64,/;
    if (base64Prefix.test(bufferOrData)) {
      buffer = Buffer.from(bufferOrData.replace(base64Prefix, ''), 'base64');
    } else {
      buffer = Buffer.from(bufferOrData, 'utf-8');
    }
  } else {
    buffer = Buffer.alloc(0);
  }

  const ext = extname(fileName || '').toLowerCase().replace(/^\./, '');
  const sizeBytes = buffer.length;

  let format = ext || 'unknown';
  let animations = [];
  let dimensions = null;
  let rigged = false;

  // 1. Check if GLB binary format
  // GLB header: magic 0x46546C67 ("glTF"), version (uint32), length (uint32)
  if (buffer.length >= 20 && buffer.toString('utf8', 0, 4) === 'glTF') {
    format = 'glb';
    try {
      const chunk0Length = buffer.readUInt32LE(12);
      const chunk0Type = buffer.readUInt32LE(16);
      // 0x4E4F534A is "JSON" in ASCII
      if (chunk0Type === 0x4E4F534A && buffer.length >= 20 + chunk0Length) {
        const jsonStr = buffer.toString('utf8', 20, 20 + chunk0Length);
        const gltf = JSON.parse(jsonStr);
        if (Array.isArray(gltf.animations)) {
          animations = gltf.animations.map(a => a.name).filter(Boolean);
        }
        if (Array.isArray(gltf.skins) && gltf.skins.length > 0) {
          rigged = true;
        }
      }
    } catch (err) {
      console.warn('Failed parsing GLB header chunk:', err.message);
    }
  }

  // 2. Check if PNG image format
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  else if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47
  ) {
    format = 'png';
    try {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      dimensions = `${width}x${height}`;
    } catch (_) {}
  }

  // 3. Check if JSON format (e.g. glTF or mock asset file)
  else {
    try {
      const text = buffer.toString('utf-8');
      if (text.trim().startsWith('{')) {
        const parsed = JSON.parse(text);
        if (parsed.format) format = parsed.format;
        if (Array.isArray(parsed.animations)) {
          animations = parsed.animations.map(a => typeof a === 'string' ? a : a.name).filter(Boolean);
        } else if (Array.isArray(parsed.expected_animations)) {
          animations = [...parsed.expected_animations];
        }
        if (parsed.dimensions) dimensions = String(parsed.dimensions);
        if (parsed.rigged !== undefined) rigged = Boolean(parsed.rigged);
        if (Array.isArray(parsed.skins) && parsed.skins.length > 0) rigged = true;
      }
    } catch (_) {
      // Not JSON, keep default ext
    }
  }

  // 4. SVG image dimensions
  if (format === 'svg') {
    try {
      const text = buffer.toString('utf-8');
      const wMatch = text.match(/width="([0-9]+)(?:px)?"/);
      const hMatch = text.match(/height="([0-9]+)(?:px)?"/);
      if (wMatch && hMatch) {
        dimensions = `${wMatch[1]}x${hMatch[1]}`;
      } else {
        const vbMatch = text.match(/viewBox="[0-9\s]+([0-9]+)\s+([0-9]+)"/);
        if (vbMatch) dimensions = `${vbMatch[1]}x${vbMatch[2]}`;
      }
    } catch (_) {}
  }

  return {
    format: format.toLowerCase(),
    animations: [...new Set(animations)].sort(),
    dimensions,
    rigged,
    sizeBytes
  };
}

/**
 * Validate an inspected asset against a slot contract.
 *
 * @param {object} slotContract - Declared slot contract
 * @param {object} assetInfo - Inspected asset information
 * @returns {{ valid: boolean, errors: string[], warnings: string[], slot: object, asset: object }}
 */
export function validateAssetAgainstSlot(slotContract, assetInfo) {
  const errors = [];
  const warnings = [];

  const expectedFormat = (slotContract.format || '').toLowerCase();
  const actualFormat = (assetInfo.format || '').toLowerCase();

  // 1. Format check
  if (expectedFormat && actualFormat && expectedFormat !== actualFormat) {
    // Tolerant check for glb/gltf or jpg/jpeg
    const isGlbPair = (expectedFormat === 'glb' && actualFormat === 'gltf') || (expectedFormat === 'gltf' && actualFormat === 'glb');
    const isJpgPair = (expectedFormat === 'jpg' && actualFormat === 'jpeg') || (expectedFormat === 'jpeg' && actualFormat === 'jpg');

    if (!isGlbPair && !isJpgPair) {
      errors.push(`Format mismatch: slot requires "${expectedFormat}", but replacement file is "${actualFormat}"`);
    }
  }

  // 2. Expected animations check
  if (Array.isArray(slotContract.expected_animations) && slotContract.expected_animations.length > 0) {
    const assetAnimations = new Set(assetInfo.animations || []);
    const missingAnims = [];

    for (const anim of slotContract.expected_animations) {
      if (!assetAnimations.has(anim)) {
        missingAnims.push(anim);
      }
    }

    if (missingAnims.length > 0) {
      const presentList = (assetInfo.animations && assetInfo.animations.length > 0)
        ? `[${assetInfo.animations.join(', ')}]`
        : 'none';
      errors.push(
        `Missing required animation(s): ${missingAnims.map(a => `\`${a}\``).join(', ')} (asset declares: ${presentList})`
      );
    }
  }

  // 3. Dimensions check (for images/textures)
  if (slotContract.dimensions) {
    if (!assetInfo.dimensions) {
      warnings.push(`Slot expects dimensions "${slotContract.dimensions}", but image dimensions could not be verified`);
    } else if (slotContract.dimensions !== assetInfo.dimensions) {
      errors.push(
        `Dimension mismatch: slot requires "${slotContract.dimensions}", but replacement image is "${assetInfo.dimensions}"`
      );
    }
  }

  // 4. Rigged requirement
  if (slotContract.rigged === true && assetInfo.rigged === false) {
    errors.push('Rigging mismatch: slot requires a rigged character model with bones/skin, but replacement has no skin');
  }

  // 5. Max file size check
  if (slotContract.max_size_kb && assetInfo.sizeBytes) {
    const sizeKb = assetInfo.sizeBytes / 1024;
    if (sizeKb > slotContract.max_size_kb) {
      errors.push(
        `File size limit exceeded: asset is ${sizeKb.toFixed(1)} KB, limit is ${slotContract.max_size_kb} KB`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    slot: slotContract,
    asset: assetInfo
  };
}
