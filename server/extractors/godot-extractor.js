/**
 * godot-extractor.js — Extracts dependency graph from a Godot 4.x project.
 *
 * Implements the extractor interface from docs/ARCHITECTURE.md §2:
 *   async function extract(projectPath) → { nodes: [...], edges: [...] }
 *
 * The extractor does NOT compute depended_on_by — the server does that.
 *
 * Parses:
 *   .tscn files: ext_resource/sub_resource headers, node blocks, connection blocks
 *   .gd files:   @export vars, signal declarations, public func signatures
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { parseSlotContract, parseInCodeSlotHints, isAssetFile } from '../slot-contract.js';

/**
 * Recursively find all files with given extensions under a directory.
 * @param {string} dir
 * @param {string[]} extensions - e.g. ['.tscn', '.gd']
 * @returns {string[]} absolute paths
 */
function findFiles(dir, extensions) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  // Sort entries for deterministic ordering
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs and .godot internal cache
      if (entry.name.startsWith('.') || entry.name === '.godot') continue;
      results.push(...findFiles(fullPath, extensions));
    } else if (extensions.includes(extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Convert a Godot res:// path to a project-relative path.
 * @param {string} resPath - e.g. "res://scripts/Player.gd"
 * @returns {string} - e.g. "scripts/Player.gd"
 */
function resToRelative(resPath) {
  return resPath.replace(/^res:\/\//, '');
}

// ─────────────────────────── .tscn Parsing ───────────────────────────

/**
 * Parse a .tscn file and extract:
 *   - ext_resource dependencies (scripts, sub-scenes, assets)
 *   - connection blocks (signal wiring)
 *   - the root node's script reference
 *
 * @param {string} filePath - absolute path to the .tscn file
 * @param {string} projectPath - absolute path to the project root
 * @returns {{ id: string, extResources: { id: string, path: string, type: string }[], connections: { signal: string, from: string, to: string }[], rootScript: string|null }}
 */
function parseTscn(filePath, projectPath) {
  const content = readFileSync(filePath, 'utf-8');
  const id = relative(projectPath, filePath).replace(/\\/g, '/');

  const extResources = [];
  const connections = [];
  let rootScript = null;

  // Parse [ext_resource ...] headers
  // Format: [ext_resource type="Script" path="res://scripts/Player.gd" id="1_abc"]
  const extResRegex = /^\[ext_resource\s+(.+)\]\s*$/gm;
  let match;

  while ((match = extResRegex.exec(content)) !== null) {
    const attrs = match[1];
    const typeMatch = attrs.match(/type="([^"]+)"/);
    const pathMatch = attrs.match(/path="([^"]+)"/);
    const idMatch = attrs.match(/id="([^"]+)"/);

    if (pathMatch && idMatch) {
      extResources.push({
        id: idMatch[1],
        path: resToRelative(pathMatch[1]),
        type: typeMatch ? typeMatch[1] : 'Unknown'
      });
    }
  }

  // Parse [connection ...] blocks
  // Format: [connection signal="died" from="Player" to="." method="_on_player_died"]
  const connRegex = /^\[connection\s+(.+)\]\s*$/gm;
  while ((match = connRegex.exec(content)) !== null) {
    const attrs = match[1];
    const signalMatch = attrs.match(/signal="([^"]+)"/);
    const fromMatch = attrs.match(/from="([^"]+)"/);
    const toMatch = attrs.match(/to="([^"]+)"/);

    if (signalMatch && fromMatch && toMatch) {
      connections.push({
        signal: signalMatch[1],
        from: fromMatch[1],
        to: toMatch[1]
      });
    }
  }

  // Find root node's script assignment
  // Look for: script = ExtResource("1_abc")
  const scriptAssignRegex = /^script\s*=\s*ExtResource\("([^"]+)"\)/m;
  const scriptMatch = content.match(scriptAssignRegex);
  if (scriptMatch) {
    const resId = scriptMatch[1];
    const res = extResources.find(r => r.id === resId);
    if (res) {
      rootScript = res.path;
    }
  }

  return { id, extResources, connections, rootScript };
}

// ─────────────────────────── .gd Parsing ───────────────────────────

/**
 * Parse a .gd file and extract its public contract:
 *   - signal declarations
 *   - @export var declarations
 *   - public func signatures (not _-prefixed)
 *
 * @param {string} filePath - absolute path to the .gd file
 * @param {string} projectPath - absolute path to the project root
 * @returns {{ id: string, signals: string[], exports: string[], publicFuncs: string[] }}
 */
function parseGdScript(filePath, projectPath) {
  const content = readFileSync(filePath, 'utf-8');
  const id = relative(projectPath, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');

  const signals = [];
  const exports = [];
  const publicFuncs = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Signal declarations: signal name(args)  or  signal name
    const signalMatch = trimmed.match(/^signal\s+(\w+(?:\(.*?\))?)/);
    if (signalMatch) {
      signals.push(signalMatch[1]);
      continue;
    }

    // @export var declarations: @export var name: Type = value
    // Also handle @export_range, @export_enum etc. — extract the var name and type
    const exportMatch = trimmed.match(/^@export(?:_\w+(?:\([^)]*\))?)?\s+var\s+(\w+)\s*(?::\s*(\w+))?/);
    if (exportMatch) {
      const varName = exportMatch[1];
      const varType = exportMatch[2] || 'Variant';
      exports.push(`${varName}: ${varType}`);
      continue;
    }

    // Godot 3.x style: export(Type) var name
    const exportLegacyMatch = trimmed.match(/^export\s*(?:\([^)]*\))?\s+var\s+(\w+)\s*(?::\s*(\w+))?/);
    if (exportLegacyMatch) {
      const varName = exportLegacyMatch[1];
      const varType = exportLegacyMatch[2] || 'Variant';
      exports.push(`${varName}: ${varType}`);
      continue;
    }

    // Public func declarations: func name(args) -> ReturnType:
    // Skip _-prefixed (private by convention)
    const funcMatch = trimmed.match(/^func\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(\w+))?/);
    if (funcMatch) {
      const funcName = funcMatch[1];
      if (!funcName.startsWith('_')) {
        const args = funcMatch[2].trim();
        const returnType = funcMatch[3] || 'void';
        publicFuncs.push(`${funcName}(${args}) -> ${returnType}`);
      }
      continue;
    }
  }

  return { id, signals, exports, publicFuncs };
}

// ─────────────────────────── Autoload Detection ───────────────────────────

/**
 * Parse project.godot for [autoload] entries.
 * @param {string} projectPath
 * @returns {Map<string, string>} name → relative path
 */
function parseAutoloads(projectPath) {
  const projectFile = join(projectPath, 'project.godot');
  const autoloads = new Map();

  if (!existsSync(projectFile)) return autoloads;

  const content = readFileSync(projectFile, 'utf-8');

  // Find the [autoload] section
  const autoloadMatch = content.match(/\[autoload\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/);
  if (!autoloadMatch) return autoloads;

  const lines = autoloadMatch[1].split('\n');
  for (const line of lines) {
    // Format: GameManager="*res://scripts/GameManager.gd"
    const match = line.trim().match(/^(\w+)="?\*?res:\/\/([^"]+)"?$/);
    if (match) {
      autoloads.set(match[1], match[2]);
    }
  }

  return autoloads;
}

// ─────────────────────────── Main Extractor ───────────────────────────

/**
 * Extract the dependency graph from a Godot 4.x project.
 *
 * @param {string} projectPath - absolute path to the project root
 * @returns {Promise<{ nodes: object[], edges: object[] }>}
 */
export async function extract(projectPath) {
  const nodes = [];
  const edges = [];

  // Discover all relevant files
  const tscnFiles = findFiles(projectPath, ['.tscn']);
  const gdFiles = findFiles(projectPath, ['.gd']);

  // Parse autoloads from project.godot
  const autoloads = parseAutoloads(projectPath);
  const autoloadNames = [...autoloads.keys()];

  // Build a map of all known node ids for reference
  const knownIds = new Set();
  for (const f of tscnFiles) {
    knownIds.add(relative(projectPath, f).replace(/\\/g, '/'));
  }
  for (const f of gdFiles) {
    knownIds.add(relative(projectPath, f).replace(/\\/g, '/'));
  }

  // ── Parse .gd files first so we can look up script contracts for scenes ──
  /** @type {Map<string, { signals: string[], exports: string[], publicFuncs: string[] }>} */
  const scriptContracts = new Map();

  for (const gdFile of gdFiles) {
    const parsed = parseGdScript(gdFile, projectPath);
    scriptContracts.set(parsed.id, {
      signals: parsed.signals,
      exports: parsed.exports,
      publicFuncs: parsed.publicFuncs
    });

    // Determine what autoloads this script references (simple heuristic:
    // check if any autoload name appears in the file content)
    const content = readFileSync(gdFile, 'utf-8');
    const requires = autoloadNames.filter(name => {
      // Match the autoload name used as an identifier (word boundary)
      const regex = new RegExp(`\\b${name}\\b`);
      return regex.test(content);
    });

    // Add requires edges to target autoload nodes (T029)
    const scriptDependsOn = [];
    for (const name of requires) {
      if (autoloads.has(name)) {
        const targetPath = autoloads.get(name);
        scriptDependsOn.push(targetPath);
        edges.push({
          from: parsed.id,
          to: targetPath,
          kind: 'requires'
        });
      }
    }

    nodes.push({
      id: parsed.id,
      engine: 'godot',
      type: 'script',
      contract: {
        exports: [...parsed.exports, ...parsed.publicFuncs],
        signals: parsed.signals,
        requires: requires.sort()
      },
      depends_on: [...new Set(scriptDependsOn)].sort()
    });
  }

  // ── Parse .tscn files ──
  const assetNodes = new Map();

  for (const tscnFile of tscnFiles) {
    const parsed = parseTscn(tscnFile, projectPath);
    const dependsOn = [];

    // Add ext_resource dependencies as edges
    for (const res of parsed.extResources) {
      const ext = (res.path.split('.').pop() || '').toLowerCase();
      const isAsset = isAssetFile(res.path) || ['png', 'jpg', 'jpeg', 'svg', 'tres', 'glb', 'gltf', 'wav', 'ogg', 'mp3'].includes(ext);

      // Only create edges to files that exist or are assets
      if (knownIds.has(res.path) || isAsset) {
        dependsOn.push(res.path);

        // Determine edge kind
        const kind = isAsset ? 'asset_ref' : 'ext_resource';

        edges.push({
          from: parsed.id,
          to: res.path,
          kind
        });

        // Register asset node if not already known
        if (isAsset && !assetNodes.has(res.path)) {
          const tscnContent = readFileSync(tscnFile, 'utf-8');
          const hints = parseInCodeSlotHints(tscnContent);
          const slotResult = parseSlotContract(res.path, projectPath, hints);
          assetNodes.set(res.path, {
            id: res.path,
            engine: 'godot',
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

    // Add signal connection edges
    for (const conn of parsed.connections) {
      // Signal connections in .tscn reference node names within the scene tree.
      // We need to find the source scene (the instanced sub-scene) that emits the signal.
      // The "from" field is a node name like "Player" — we look for an ext_resource
      // that instances a scene named similarly.
      const sourceScene = parsed.extResources.find(r =>
        r.type === 'PackedScene' &&
        r.path.toLowerCase().includes(conn.from.toLowerCase())
      );

      if (sourceScene && knownIds.has(sourceScene.path)) {
        // Avoid duplicate edges (ext_resource edge may already exist)
        const alreadyHasSignalEdge = edges.some(e =>
          e.from === parsed.id &&
          e.to === sourceScene.path &&
          e.kind === 'signal_connection'
        );
        if (!alreadyHasSignalEdge) {
          edges.push({
            from: parsed.id,
            to: sourceScene.path,
            kind: 'signal_connection'
          });
        }
      }
    }

    // Build the scene's contract:
    // Union of root script's contract + any signals re-exposed by the scene
    let contract = { exports: [], signals: [], requires: [] };

    if (parsed.rootScript && scriptContracts.has(parsed.rootScript)) {
      const sc = scriptContracts.get(parsed.rootScript);
      contract = {
        exports: [...sc.exports, ...sc.publicFuncs],
        signals: [...sc.signals],
        requires: []
      };
    }

    // Deduplicate exports (script node already includes publicFuncs in exports)
    contract.exports = [...new Set(contract.exports)];

    nodes.push({
      id: parsed.id,
      engine: 'godot',
      type: 'scene',
      contract,
      depends_on: [...new Set(dependsOn)].sort()
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
 * Extract a single Godot file (.gd or .tscn) without scanning the entire project.
 *
 * @param {string} filePath - absolute or relative path to the file
 * @param {string} projectPath - absolute path to the project root
 * @returns {{ id: string, engine: 'godot', type: 'script'|'scene', contract: { exports: string[], signals: string[], requires: string[] }, depends_on: string[] }}
 */
export function extractSingleGodotFile(filePath, projectPath) {
  const absPath = filePath.startsWith('/') ? filePath : join(projectPath, filePath);
  const ext = extname(absPath);
  const id = relative(projectPath, absPath).replace(/\\/g, '/');

  if (ext === '.gd') {
    const parsed = parseGdScript(absPath, projectPath);
    const autoloads = parseAutoloads(projectPath);
    const autoloadNames = [...autoloads.keys()];
    const content = readFileSync(absPath, 'utf-8');
    const requires = autoloadNames.filter(name => new RegExp(`\\b${name}\\b`).test(content));

    const scriptDependsOn = [];
    for (const name of requires) {
      if (autoloads.has(name)) {
        scriptDependsOn.push(autoloads.get(name));
      }
    }

    return {
      id,
      engine: 'godot',
      type: 'script',
      contract: {
        exports: [...parsed.exports, ...parsed.publicFuncs],
        signals: parsed.signals,
        requires: requires.sort()
      },
      depends_on: [...new Set(scriptDependsOn)].sort()
    };
  } else if (ext === '.tscn') {
    const parsed = parseTscn(absPath, projectPath);
    let contract = { exports: [], signals: [], requires: [] };

    if (parsed.rootScript) {
      const scriptPath = join(projectPath, parsed.rootScript);
      if (existsSync(scriptPath)) {
        const sc = parseGdScript(scriptPath, projectPath);
        contract = {
          exports: [...sc.exports, ...sc.publicFuncs],
          signals: [...sc.signals],
          requires: []
        };
      }
    }

    const dependsOn = parsed.extResources.map(r => r.path);
    return {
      id,
      engine: 'godot',
      type: 'scene',
      contract,
      depends_on: [...new Set(dependsOn)].sort()
    };
  }

  throw new Error(`Unsupported Godot file extension "${ext}" for single-file extraction`);
}
