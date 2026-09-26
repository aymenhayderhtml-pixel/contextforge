/**
 * js-extractor.js — Extracts dependency graph from a JS/Three.js project.
 *
 * Implements the extractor interface from docs/ARCHITECTURE.md §2:
 *   async function extract(projectPath) → { nodes: [...], edges: [...] }
 *
 * Uses `madge` for import graph resolution (ARCHITECTURE.md §4).
 * Parses export statements via regex for each module's contract.
 * The extractor does NOT compute depended_on_by — the server does that.
 */

import madge from 'madge';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { parseSlotContract, parseInCodeSlotHints } from '../slot-contract.js';

// File extensions treated as JS modules
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.jsx', '.tsx']);

// File extensions treated as assets (not JS modules)
const ASSET_EXTENSIONS = new Set([
  '.glb', '.gltf', '.obj', '.fbx',           // 3D models
  '.png', '.jpg', '.jpeg', '.svg', '.webp',   // images/textures
  '.wav', '.ogg', '.mp3',                     // audio
  '.json',                                     // data files
]);

/**
 * Recursively find all JS source files under a directory.
 * @param {string} dir
 * @returns {string[]} absolute paths, sorted for determinism
 */
function findJsFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...findJsFiles(fullPath));
    } else if (JS_EXTENSIONS.has(extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─────────────────────────── Export Parsing ───────────────────────────

/**
 * Parse a JS file's export statements to build its contract.
 *
 * Handles:
 *   export function name(...)
 *   export async function name(...)
 *   export class Name
 *   export const/let/var name = ...
 *   export default ...
 *   export { name1, name2 }
 *
 * @param {string} filePath
 * @returns {string[]} array of export signature strings
 */
function parseExports(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const exports = [];

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // export default class/function/expression
    if (/^export\s+default\s+/.test(trimmed)) {
      const classMatch = trimmed.match(/^export\s+default\s+class\s+(\w+)/);
      if (classMatch) {
        exports.push(`default class ${classMatch[1]}`);
        continue;
      }
      const funcMatch = trimmed.match(/^export\s+default\s+(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) {
        exports.push(`default function ${funcMatch[1]}`);
        continue;
      }
      // export default <identifier or expression>
      const idMatch = trimmed.match(/^export\s+default\s+(\w+)/);
      if (idMatch) {
        exports.push(`default ${idMatch[1]}`);
        continue;
      }
      exports.push('default');
      continue;
    }

    // export async function name(args)
    const asyncFuncMatch = trimmed.match(/^export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/);
    if (asyncFuncMatch) {
      exports.push(`async function ${asyncFuncMatch[1]}(${asyncFuncMatch[2].trim()})`);
      continue;
    }

    // export function name(args)
    const funcMatch = trimmed.match(/^export\s+function\s+(\w+)\s*\(([^)]*)\)/);
    if (funcMatch) {
      exports.push(`function ${funcMatch[1]}(${funcMatch[2].trim()})`);
      continue;
    }

    // export class Name
    const classMatch = trimmed.match(/^export\s+class\s+(\w+)/);
    if (classMatch) {
      exports.push(`class ${classMatch[1]}`);
      continue;
    }

    // export const/let/var name = ...
    const varMatch = trimmed.match(/^export\s+(?:const|let|var)\s+(\w+)/);
    if (varMatch) {
      exports.push(`const ${varMatch[1]}`);
      continue;
    }

    // export { name1, name2, name3 as alias }
    const namedExportMatch = trimmed.match(/^export\s*\{([^}]+)\}/);
    if (namedExportMatch) {
      const names = namedExportMatch[1].split(',').map(n => n.trim());
      for (const name of names) {
        if (name) exports.push(name);
      }
      continue;
    }
  }

  // Sort for determinism
  exports.sort((a, b) => a.localeCompare(b));
  return exports;
}

// ─────────────────────────── Asset Reference Detection ───────────────

/**
 * Scan a JS file for string literals referencing asset files.
 * Looks for import statements and string literals with known asset extensions.
 *
 * @param {string} filePath
 * @returns {string[]} relative paths to referenced assets
 */
function findAssetReferences(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const assets = [];

  // Match string literals containing asset paths
  // e.g. 'models/character.glb', "textures/wood.png"
  const stringLitRegex = /['"`]([^'"`\n]+\.\w+)['"`]/g;
  let match;

  while ((match = stringLitRegex.exec(content)) !== null) {
    const rawPath = match[1];
    const ext = extname(rawPath);
    if (!ASSET_EXTENSIONS.has(ext)) continue;
    // Normalize to a project-relative id. Raw string literals are usually
    // written relative to the importing file ("../assets/x.png") or as a bare
    // URL path ("./assets/x.png"); neither is a valid manifest node id.
    const path = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const cleaned = path
      .split('/')
      .filter(seg => seg !== '' && seg !== '.' && seg !== '..')
      .join('/');
    if (cleaned) assets.push(cleaned);
  }

  // Deduplicate and sort
  return [...new Set(assets)].sort();
}

// ─────────────────────────── Main Extractor ───────────────────────────

/**
 * Extract the dependency graph from a JS/Three.js project.
 *
 * @param {string} projectPath - absolute path to the project root
 * @returns {Promise<{ nodes: object[], edges: object[] }>}
 */
export async function extract(projectPath) {
  const nodes = [];
  const edges = [];

  // Find the source directory — look for src/, lib/, or use root
  let srcDir = projectPath;
  for (const candidate of ['src', 'lib', 'app']) {
    const candidatePath = join(projectPath, candidate);
    if (existsSync(candidatePath) && statSync(candidatePath).isDirectory()) {
      srcDir = candidatePath;
      break;
    }
  }

  // Use madge to get the import dependency graph
  const madgeResult = await madge(srcDir, {
    fileExtensions: ['js', 'mjs', 'ts', 'jsx', 'tsx'],
    baseDir: projectPath,
    detectiveOptions: {
      es6: { mixedImports: true }
    }
  });

  const depGraph = madgeResult.obj();

  // Build nodes and edges from madge's dependency graph
  // madge returns: { "src/main.js": ["src/scene-manager.js", "src/player.js", ...], ... }
  const knownModules = new Set(Object.keys(depGraph));

  // Track all asset nodes to avoid duplicates
  const assetNodes = new Map();

  for (const moduleId of [...knownModules].sort()) {
    const absPath = join(projectPath, moduleId);
    const dependsOn = [];

    // Normalize the module id to use forward slashes
    const normalizedId = moduleId.replace(/\\/g, '/');

    // Parse the module's exports for its contract
    let exportsList = [];
    if (existsSync(absPath)) {
      exportsList = parseExports(absPath);
    }

    // Process dependencies from madge
    const deps = depGraph[moduleId] || [];
    for (const dep of [...deps].sort()) {
      const normalizedDep = dep.replace(/\\/g, '/');
      dependsOn.push(normalizedDep);

      edges.push({
        from: normalizedId,
        to: normalizedDep,
        kind: 'import'
      });
    }

    // Scan for asset references
    if (existsSync(absPath)) {
      const fileContent = readFileSync(absPath, 'utf-8');
      const inCodeHints = parseInCodeSlotHints(fileContent);
      const assets = findAssetReferences(absPath);
      for (const assetPath of assets) {
        const normalizedAsset = assetPath.replace(/\\/g, '/');
        dependsOn.push(normalizedAsset);

        edges.push({
          from: normalizedId,
          to: normalizedAsset,
          kind: 'asset_ref'
        });

        // Register asset node if not already known
        if (!assetNodes.has(normalizedAsset)) {
          const slotResult = parseSlotContract(normalizedAsset, projectPath, inCodeHints);
          assetNodes.set(normalizedAsset, {
            id: normalizedAsset,
            engine: 'js',
            type: 'asset',
            contract: {
              exports: slotResult.exports,
              signals: [],
              requires: [],
              slot: slotResult.slot
            },
            slot: slotResult.slot,
            depends_on: []
          });
        }
      }
    }

    nodes.push({
      id: normalizedId,
      engine: 'js',
      type: 'module',
      contract: {
        exports: exportsList,
        signals: [],   // JS modules don't have signals
        requires: []   // Could be extended for global deps later
      },
      depends_on: dependsOn.sort()
    });
  }

  // Add asset nodes
  for (const assetNode of [...assetNodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    nodes.push(assetNode);
  }

  // Sort nodes by id for determinism
  nodes.sort((a, b) => a.id.localeCompare(b.id));

  // Sort edges for determinism
  edges.sort((a, b) =>
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.kind.localeCompare(b.kind)
  );

  return { nodes, edges };
}

/**
 * Extract a single JS module without running a full dependency graph analysis.
 *
 * @param {string} filePath - absolute or relative path to the file
 * @param {string} projectPath - absolute path to the project root
 * @returns {{ id: string, engine: 'js', type: 'module', contract: { exports: string[], signals: string[], requires: string[] }, depends_on: string[] }}
 */
export function extractSingleJsFile(filePath, projectPath) {
  const absPath = filePath.startsWith('/') ? filePath : join(projectPath, filePath);
  const normalizedId = relative(projectPath, absPath).replace(/\\/g, '/');
  const exportsList = parseExports(absPath);
  const assets = findAssetReferences(absPath);

  return {
    id: normalizedId,
    engine: 'js',
    type: 'module',
    contract: {
      exports: exportsList,
      signals: [],
      requires: []
    },
    depends_on: assets
  };
}
