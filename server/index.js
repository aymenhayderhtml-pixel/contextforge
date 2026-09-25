/**
 * server/index.js — ContextForge HTTP server.
 *
 * Serves /public as static files and provides the API routes
 * defined in docs/ARCHITECTURE.md §5.
 *
 * Phase 3: POST /extract runs real extractors against a project path.
 *          Server computes depended_on_by from the edge set.
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { validateManifest } from './schema/validate.js';
import { extract as extractGodot, extractSingleGodotFile } from './extractors/godot-extractor.js';
import { extract as extractJs, extractSingleJsFile } from './extractors/js-extractor.js';
import { inspectAssetFile, validateAssetAgainstSlot, parseSlotContract } from './slot-contract.js';
import { validateNodeId } from './scaffold-validator.js';
import { scaffoldNewProject, parseProjectProgress, writeAiFilesToProject, parseAiFileBlocks, applyAiEditBlocks, parseAiEditBlocks, getProjectFileTree } from './project-init.js';
import { generateFileOutline, getCachedFileOutline, extractScopedSnippet, OVERSIZED_LINE_THRESHOLD, checkOversizedFile } from './outline.js';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { setupAndStartDevServer, stopDevServer, getDevServerStatus, stopAllDevServers } from './dev-server.js';
import { recordConsoleLog, getConsoleLogs, clearConsoleLogs, runGodotCheck, runJsCheck, ensureDiagnosticsBridge, recordAppLog, getAppLogs, clearAppLogs } from './console-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Serve frontend from /public
app.use(express.static(join(projectRoot, 'public')));

// ---------- State ----------

/** @type {object|null} The current manifest in memory */
let currentManifest = null;

/** @type {string|null} The project path the current manifest was extracted from */
let currentProjectPath = null;

/** @type {{ pid: number, child: any, target: string, isPaused: boolean }|null} Active Godot runtime process */
let activeGodotProcess = null;

recordAppLog('ContextForge server online at http://localhost:3000', 'success');
recordAppLog('Ready for Godot 4.x and JS/Three.js game engines', 'info');

// ---------- Helpers ----------

/**
 * Strips enclosing quotes and resolves path.
 */
export function cleanAndResolvePath(p) {
  if (!p || typeof p !== 'string') return '';
  let cleaned = p.trim();
  if ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"'))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return resolve(cleaned).replace(/\\/g, '/');
}

/**
 * Detect which engines a project uses.
 * @param {string} projectPath
 * @returns {{ godot: boolean, js: boolean }}
 */
function detectEngines(projectPath) {
  const hasGodot = existsSync(join(projectPath, 'project.godot'));

  // Check for JS by looking for common indicators
  const hasPackageJson = existsSync(join(projectPath, 'package.json'));
  const hasSrc = existsSync(join(projectPath, 'src'));
  const hasIndexHtml = existsSync(join(projectPath, 'index.html'));
  const js = hasPackageJson || hasIndexHtml || hasSrc;

  return { godot: hasGodot, js };
}

/**
 * Compute depended_on_by for all nodes from the edge set.
 * Per ARCHITECTURE.md §1: this is always derived, never parsed.
 */
function computeDependedOnBy(nodes, edges) {
  // Build reverse lookup from edges
  const reverseMap = new Map();
  for (const edge of edges) {
    if (!reverseMap.has(edge.to)) {
      reverseMap.set(edge.to, new Set());
    }
    reverseMap.get(edge.to).add(edge.from);
  }

  // Apply to each node
  for (const node of nodes) {
    const dependents = reverseMap.get(node.id);
    node.depended_on_by = dependents
      ? [...dependents].sort()
      : [];
  }
}

/**
 * Run extractors, merge, compute depended_on_by, validate, return manifest.
 */
async function runExtraction(projectPath) {
  const engines = detectEngines(projectPath);
  let allNodes = [];
  let allEdges = [];

  if (engines.godot) {
    const result = await extractGodot(projectPath);
    allNodes.push(...result.nodes);
    allEdges.push(...result.edges);
  }

  if (engines.js) {
    const result = await extractJs(projectPath);
    allNodes.push(...result.nodes);
    allEdges.push(...result.edges);
  }

  if (!engines.godot && !engines.js) {
    throw new Error(
      `No supported engine detected at "${projectPath}". ` +
      `Expected project.godot (Godot) or package.json + src/ (JS/Three.js).`
    );
  }

  // Sort for determinism
  allNodes.sort((a, b) => a.id.localeCompare(b.id));
  allEdges.sort((a, b) =>
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.kind.localeCompare(b.kind)
  );

  // Compute depended_on_by (server's responsibility per ARCHITECTURE.md §2)
  computeDependedOnBy(allNodes, allEdges);

  const manifest = {
    project_root: projectPath,
    generated_at: new Date().toISOString(),
    nodes: allNodes,
    edges: allEdges
  };

  // Validate
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(
      `Manifest validation failed:\n  - ${validation.errors.join('\n  - ')}`
    );
  }

  return manifest;
}

// ---------- API Routes ----------

/**
 * POST /extract
 * Run extractor(s) against a given project path.
 * Body: { "projectPath": "/absolute/path/to/project" }
 */
app.post('/extract', async (req, res) => {
  try {
    const { projectPath } = req.body;

    if (!projectPath) {
      return res.status(400).json({
        error: 'Missing "projectPath" in request body'
      });
    }

    const absPath = cleanAndResolvePath(projectPath);

    if (!existsSync(absPath)) {
      return res.status(400).json({
        error: `Project path does not exist: "${absPath}"`
      });
    }

    const manifest = await runExtraction(absPath);
    currentManifest = manifest;
    currentProjectPath = absPath;

    res.json(manifest);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * GET /manifest
 * Returns the current manifest, or an error if none has been extracted yet.
 */
app.get('/manifest', (_req, res) => {
  if (!currentManifest) {
    return res.status(404).json({
      error: 'No manifest loaded. Use POST /extract with a project path first.'
    });
  }
  res.json(currentManifest);
});

// ---------- Task Locking (Phase 4) ----------

/** @type {Map<string, { status: string, holder: string, locked_at: string }>} */
const locks = new Map();

/** Stale-lock timeout in milliseconds (default: 30 minutes) */
const STALE_LOCK_MS = 30 * 60 * 1000;

/**
 * Check if a lock is stale (holder crashed/abandoned).
 * @param {{ locked_at: string }} lock
 * @returns {boolean}
 */
function isLockStale(lock) {
  if (!lock.locked_at) return false;
  const lockedTime = new Date(lock.locked_at).getTime();
  return Date.now() - lockedTime > STALE_LOCK_MS;
}

/**
 * Get the current lock state for a node.
 * Auto-releases stale locks.
 * @param {string} nodeId
 * @returns {{ status: string, holder: string, locked_at: string }}
 */
function getLockState(nodeId) {
  const lock = locks.get(nodeId);
  if (!lock) {
    return { status: 'free', holder: '', locked_at: '' };
  }
  // Auto-release stale locks
  if (lock.status === 'locked' && isLockStale(lock)) {
    const freed = { status: 'free', holder: '', locked_at: '' };
    locks.set(nodeId, freed);
    return freed;
  }
  return lock;
}

/**
 * POST /lock
 * Attempt to lock a node for a session.
 * Body: { "nodeId": "scenes/Player.tscn", "holder": "agent-1" }
 * Fails if already locked by a different holder (unless stale).
 */
app.post('/lock', (req, res) => {
  const { nodeId, holder } = req.body;

  if (!nodeId || !holder) {
    return res.status(400).json({
      error: 'Missing "nodeId" and/or "holder" in request body'
    });
  }

  const current = getLockState(nodeId);

  if (current.status === 'locked') {
    if (current.holder === holder) {
      // Same holder re-locking — refresh the timestamp
      const refreshed = { status: 'locked', holder, locked_at: new Date().toISOString() };
      locks.set(nodeId, refreshed);
      return res.json({ success: true, lock: refreshed, message: 'Lock refreshed' });
    }
    // Different holder — reject
    return res.status(409).json({
      error: `Node "${nodeId}" is already locked by "${current.holder}" (since ${current.locked_at}). Cannot lock for "${holder}".`,
      lock: current
    });
  }

  // Lock it
  const newLock = { status: 'locked', holder, locked_at: new Date().toISOString() };
  locks.set(nodeId, newLock);
  res.json({ success: true, lock: newLock });
});

/**
 * POST /unlock
 * Release a lock held by the caller's session.
 * Body: { "nodeId": "scenes/Player.tscn", "holder": "agent-1" }
 * Optionally: { "nodeId": "...", "holder": "...", "force": true } to force-unlock.
 */
app.post('/unlock', (req, res) => {
  const { nodeId, holder, force } = req.body;

  if (!nodeId) {
    return res.status(400).json({
      error: 'Missing "nodeId" in request body'
    });
  }

  const current = getLockState(nodeId);

  if (current.status === 'free') {
    return res.json({ success: true, message: 'Node was already free' });
  }

  // Force unlock bypasses holder check (for UI manual override, T021)
  if (force) {
    const freed = { status: 'free', holder: '', locked_at: '' };
    locks.set(nodeId, freed);
    return res.json({ success: true, message: `Force-unlocked (was held by "${current.holder}")`, lock: freed });
  }

  if (!holder) {
    return res.status(400).json({
      error: 'Missing "holder" in request body (required unless force=true)'
    });
  }

  if (current.holder !== holder) {
    return res.status(403).json({
      error: `Node "${nodeId}" is locked by "${current.holder}", not "${holder}". Use force=true to override.`,
      lock: current
    });
  }

  const freed = { status: 'free', holder: '', locked_at: '' };
  locks.set(nodeId, freed);
  res.json({ success: true, lock: freed });
});

/**
 * GET /locks
 * List all current locks (for the UI and orchestrators).
 */
app.get('/locks', (_req, res) => {
  const result = {};
  for (const [nodeId, lock] of locks.entries()) {
    const current = getLockState(nodeId); // auto-releases stale
    if (current.status === 'locked') {
      result[nodeId] = current;
    }
  }
  res.json(result);
});

// ---------- Context Packager (Phase 5) ----------

/** Static conventions snippet included in every context package. */
const CONVENTIONS_SNIPPET = `
## Project Conventions
- Godot: @export vars are public contract. Prefix private funcs with _.
  Signals are the inter-scene communication mechanism.
- JS/Three.js: Named exports form the public contract. Use ES module imports.
- Every file's public interface (contract) is tracked. Do NOT change function
  signatures, signal names, or export names without updating dependents.
- If you add a new dependency, it must be importable/loadable from the project.
`.trim();

/**
 * Build an interface-only stub for a node (contract summary + signature outline, not full source).
 */
function buildStub(node, projectPath = currentProjectPath) {
  const lines = [`// --- Stub: ${node.id} (${node.engine}/${node.type}) ---`];

  if (node.contract.exports.length > 0) {
    lines.push(`// Exports: ${node.contract.exports.join(', ')}`);
  }
  if (node.contract.signals.length > 0) {
    lines.push(`// Signals: ${node.contract.signals.join(', ')}`);
  }
  if (node.contract.requires.length > 0) {
    lines.push(`// Requires: ${node.contract.requires.join(', ')}`);
  }

  if (projectPath) {
    const cached = getCachedFileOutline(projectPath, node.id);
    if (cached && cached.outline && !cached.outline.startsWith('// (No')) {
      lines.push('// Outline:');
      for (const sig of cached.outline.split('\n')) {
        lines.push(`//   ${sig}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * POST /package-context
 * Assemble a context bundle for handing a task to an AI model.
 * Body: { "nodeId": "scenes/Player.tscn", "scoped": true, "fullDepIds": [] }
 */
app.post('/package-context', (req, res) => {
  const { nodeId, scoped = true, fullDepIds = [] } = req.body;

  if (!nodeId) {
    return res.status(400).json({ error: 'Missing "nodeId" in request body' });
  }
  if (!currentManifest) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  const node = currentManifest.nodes.find(n => n.id === nodeId);
  if (!node) {
    return res.status(404).json({ error: `Node "${nodeId}" not found in manifest` });
  }

  const parts = [];

  // 1. Target file's full content
  const targetPath = join(currentProjectPath, nodeId);
  let targetLines = 0;
  if (existsSync(targetPath)) {
    const content = readFileSync(targetPath, 'utf-8');
    targetLines = content.split(/\r?\n/).length;
    parts.push(`## Target File: ${nodeId}\n\`\`\`\n${content}\n\`\`\``);
  } else {
    parts.push(`## Target File: ${nodeId}\n(File does not exist yet — this is a new node)`);
  }

  // 2. Interface-only stubs of direct dependencies
  if (node.depends_on.length > 0) {
    parts.push('\n## Direct Dependencies (interface only)');
    for (const depId of node.depends_on) {
      const depNode = currentManifest.nodes.find(n => n.id === depId);
      const isFull = fullDepIds.includes(depId) || scoped === false;
      const depPath = join(currentProjectPath, depId);
      if (isFull && existsSync(depPath)) {
        parts.push(`// --- Full Source: ${depId} ---\n\`\`\`\n${readFileSync(depPath, 'utf-8')}\n\`\`\``);
      } else if (depNode) {
        parts.push(buildStub(depNode, currentProjectPath));
      } else {
        parts.push(`// --- Stub: ${depId} (not in manifest) ---`);
      }
    }
  }

  // 3. Interface-only stubs of dependents (what expects this node's contract)
  if (node.depended_on_by.length > 0) {
    parts.push('\n## Dependents (what expects this node\'s contract)');
    for (const depId of node.depended_on_by) {
      const depNode = currentManifest.nodes.find(n => n.id === depId);
      const isFull = fullDepIds.includes(depId) || scoped === false;
      const depPath = join(currentProjectPath, depId);
      if (isFull && existsSync(depPath)) {
        parts.push(`// --- Full Source: ${depId} ---\n\`\`\`\n${readFileSync(depPath, 'utf-8')}\n\`\`\``);
      } else if (depNode) {
        parts.push(buildStub(depNode, currentProjectPath));
      }
    }
  }

  // 4. Conventions
  parts.push(`\n${CONVENTIONS_SNIPPET}`);

  const context = parts.join('\n\n');
  const chars = context.length;
  const tokens = Math.round(chars / 4);

  res.json({
    nodeId,
    context,
    chars,
    tokens,
    targetLines,
    isOversized: targetLines >= OVERSIZED_LINE_THRESHOLD
  });
});

/**
 * POST /scaffold
 * Create a new scene/module with boilerplate and a generated prompt.
 * Body: { "nodeId": "scenes/NewScene.tscn", "engine": "godot"|"js", "type": "scene"|"script"|"module", "holder": "agent-1" }
 */
app.post('/scaffold', async (req, res) => {
  const { nodeId, engine, type, holder } = req.body;

  if (!nodeId || !engine || !type || !holder) {
    return res.status(400).json({
      error: 'Missing required fields: nodeId, engine, type, holder'
    });
  }
  if (!currentManifest || !currentProjectPath) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  // Validate node ID pattern for engine and type (T031)
  const validation = validateNodeId(nodeId, engine, type);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }
  const cleanNodeId = validation.normalizedId;

  // Acquire lock first (per T023)
  const lockState = getLockState(cleanNodeId);
  if (lockState.status === 'locked' && lockState.holder !== holder) {
    return res.status(409).json({
      error: `Node "${cleanNodeId}" is already locked by "${lockState.holder}". Cannot scaffold.`,
      lock: lockState
    });
  }
  // Lock it
  const newLock = { status: 'locked', holder, locked_at: new Date().toISOString() };
  locks.set(cleanNodeId, newLock);

  // Generate boilerplate based on engine/type
  let boilerplate = '';
  let prompt = '';

  if (engine === 'godot') {
    if (type === 'scene') {
      const scriptId = cleanNodeId.replace(/\.tscn$/, '.gd').replace(/^scenes\//, 'scripts/');
      boilerplate = `[gd_scene load_steps=1 format=3]\n\n[node name="${cleanNodeId.split('/').pop().replace('.tscn', '')}" type="Node2D"]\n`;
      prompt = `Create a Godot 4.x scene "${cleanNodeId}". It needs a root node and should attach a script at "${scriptId}".`;
    } else if (type === 'script') {
      boilerplate = `extends Node\n\n## TODO: Implement this script\n\n`;
      prompt = `Create a GDScript file "${cleanNodeId}".`;
    }
  } else if (engine === 'js') {
    if (type === 'module') {
      boilerplate = `/**\n * ${cleanNodeId}\n * TODO: Implement this module\n */\n\n`;
      prompt = `Create a JS module "${cleanNodeId}".`;
    }
  }

  // Add dependency context to the prompt
  const existingNodes = currentManifest.nodes;
  const potentialDeps = existingNodes.filter(n => n.engine === engine).slice(0, 5);
  if (potentialDeps.length > 0) {
    prompt += `\n\nExisting ${engine} nodes in the project:\n`;
    for (const dep of potentialDeps) {
      prompt += `- ${dep.id} (${dep.type}): exports [${dep.contract.exports.join(', ')}]`;
      if (dep.contract.signals.length > 0) {
        prompt += `, signals [${dep.contract.signals.join(', ')}]`;
      }
      prompt += '\n';
    }
    prompt += '\nDecide which of these to depend on, and define your own exports/signals contract.';
  }

  // Write the boilerplate file
  const targetPath = join(currentProjectPath, cleanNodeId);
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, boilerplate, 'utf-8');
  }

  res.json({
    nodeId: cleanNodeId,
    boilerplate,
    prompt,
    lock: newLock
  });
});

// ---------- Validation on Write-back (Phase 6) ----------

/**
 * Extract an identifier name from an export signature.
 */
function getExportIdentifier(sig) {
  const match = sig.match(/^(?:(?:async\s+)?function|class|const|let|var|default)\s+([A-Za-z0-9_$]+)/) ||
                sig.match(/^([A-Za-z0-9_$]+)\s*:/) ||
                sig.match(/^([A-Za-z0-9_$]+)/);
  return match ? match[1] : sig;
}

/**
 * Extract signal base name.
 */
function getSignalName(sig) {
  const match = sig.match(/^([A-Za-z0-9_$]+)/);
  return match ? match[1] : sig;
}

/**
 * Validate a freshly extracted node contract against what existing dependents expect (T025, T026).
 *
 * @param {string} nodeId - relative path to the edited node
 * @param {object} newContract - { exports: string[], signals: string[], requires: string[] }
 * @param {object} manifest - current manifest
 * @param {string} projectPath - absolute path to project root
 * @returns {{ valid: boolean, mismatches: string[], newContract: object }}
 */
function validateAgainstDependents(nodeId, newContract, manifest, projectPath) {
  const mismatches = [];
  if (!manifest || !manifest.nodes) {
    return { valid: true, mismatches, newContract };
  }

  const existingNode = manifest.nodes.find(n => n.id === nodeId);
  if (!existingNode) {
    return { valid: true, mismatches, newContract };
  }

  const oldContract = existingNode.contract || { exports: [], signals: [], requires: [] };
  const directDependents = existingNode.depended_on_by || [];

  // Gather all dependents (direct dependents + higher scene dependents if this is a script backing a scene)
  const allDependentIds = new Set(directDependents);
  if (existingNode.type === 'script') {
    for (const depId of directDependents) {
      const depNode = manifest.nodes.find(n => n.id === depId);
      if (depNode && depNode.type === 'scene') {
        for (const higherDep of (depNode.depended_on_by || [])) {
          allDependentIds.add(higherDep);
        }
      }
    }
  }

  const nodeBase = nodeId.split('/').pop().replace(/\.\w+$/, '');

  // 1. Check Godot Signals
  const newSignalNames = new Set(newContract.signals.map(getSignalName));
  for (const oldSig of oldContract.signals) {
    const oldSigName = getSignalName(oldSig);
    if (!newSignalNames.has(oldSigName)) {
      // Signal was removed! Check which dependents expected it
      let foundExpectingDependent = false;
      for (const depId of allDependentIds) {
        const depPath = join(projectPath, depId);
        let depContent = '';
        if (existsSync(depPath)) {
          depContent = readFileSync(depPath, 'utf-8');
        }

        // Check if dependent connects to this signal
        const connectsInScene = depContent.includes(`signal="${oldSigName}"`);
        const connectsInScript = depContent.includes(`.${oldSigName}.connect`) || depContent.includes(`"${oldSigName}"`);
        const hasEdge = manifest.edges.some(e => e.from === depId && e.kind === 'signal_connection');

        if (connectsInScene || connectsInScript || hasEdge) {
          const depBase = depId.split('/').pop().replace(/\.\w+$/, '');
          mismatches.push(`${depBase} expects ${nodeBase} to emit \`${oldSig}\`, but the new ${nodeBase} does not declare that signal`);
          foundExpectingDependent = true;
        }
      }

      if (!foundExpectingDependent && allDependentIds.size > 0) {
        for (const depId of allDependentIds) {
          const depBase = depId.split('/').pop().replace(/\.\w+$/, '');
          mismatches.push(`${depBase} expects ${nodeBase} to emit \`${oldSig}\`, but the new ${nodeBase} does not declare that signal`);
        }
      }
    }
  }

  // 2. Check Exports
  const newExportIds = new Set(newContract.exports.map(getExportIdentifier));
  for (const oldExp of oldContract.exports) {
    const oldExpId = getExportIdentifier(oldExp);
    if (!newExportIds.has(oldExpId)) {
      // Export was removed! Check which dependents expected it
      for (const depId of allDependentIds) {
        const depPath = join(projectPath, depId);
        let depContent = '';
        if (existsSync(depPath)) {
          depContent = readFileSync(depPath, 'utf-8');
        }
        const mentionsExport = depContent.length > 0 && new RegExp(`\\b${oldExpId}\\b`).test(depContent);
        if (mentionsExport || directDependents.includes(depId)) {
          const depBase = depId.split('/').pop().replace(/\.\w+$/, '');
          mismatches.push(`${depBase} expects ${nodeBase} to export \`${oldExp}\`, but it is missing from the new contract`);
        }
      }
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
    newContract
  };
}

/**
 * POST /paste-back
 * Write AI-generated code to a target file. Requires the caller to hold the lock.
 * Re-runs extractor on the changed file only and validates contract against dependents (T025, T026).
 * Body: { "nodeId": "scenes/Player.tscn", "holder": "agent-1", "code": "...", "releaseLock": false }
 */
app.post('/paste-back', (req, res) => {
  const { nodeId, holder, code, releaseLock } = req.body;

  if (!nodeId || !holder || code === undefined) {
    return res.status(400).json({
      error: 'Missing required fields: nodeId, holder, code'
    });
  }
  if (!currentProjectPath) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  // Verify lock ownership (per T024)
  const lockState = getLockState(nodeId);
  if (lockState.status !== 'locked') {
    return res.status(403).json({
      error: `Node "${nodeId}" is not locked. Call POST /lock first before writing.`
    });
  }
  if (lockState.holder !== holder) {
    return res.status(403).json({
      error: `Node "${nodeId}" is locked by "${lockState.holder}", not "${holder}". Cannot write.`,
      lock: lockState
    });
  }

  // Write the file
  const targetPath = join(currentProjectPath, nodeId);
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  writeFileSync(targetPath, code, 'utf-8');

  // Re-run extractor on the changed file only (T025)
  let extractedNode = null;
  const ext = nodeId.split('.').pop();
  try {
    if (ext === 'gd' || ext === 'tscn') {
      extractedNode = extractSingleGodotFile(targetPath, currentProjectPath);
    } else if (['js', 'mjs', 'ts', 'jsx', 'tsx'].includes(ext)) {
      extractedNode = extractSingleJsFile(targetPath, currentProjectPath);
    }
  } catch (err) {
    console.error(`Single-file extraction error on "${nodeId}":`, err.message);
  }

  const newContract = extractedNode ? extractedNode.contract : { exports: [], signals: [], requires: [] };

  // Compare new contract against what existing dependents expect (T025, T026)
  const validation = validateAgainstDependents(nodeId, newContract, currentManifest, currentProjectPath);

  // Update in-memory manifest for this node so subsequent checks reflect current state
  if (currentManifest && currentManifest.nodes) {
    const nodeInManifest = currentManifest.nodes.find(n => n.id === nodeId);
    if (nodeInManifest) {
      nodeInManifest.contract = newContract;
    }
  }

  // Release lock if requested
  let lockReleased = false;
  if (releaseLock) {
    const freed = { status: 'free', holder: '', locked_at: '' };
    locks.set(nodeId, freed);
    lockReleased = true;
  }

  res.json({
    success: true,
    nodeId,
    path: targetPath,
    bytesWritten: Buffer.byteLength(code, 'utf-8'),
    validation,
    lockReleased
  });
});

// ---------- Asset Graph & Slot Contracts (Phase 7) ----------

/**
 * POST /swap-asset
 * Swap in a replacement asset file and validate it against the slot's contract (T028).
 * Body: { "nodeId": "models/character.glb", "fileName": "hero_v2.glb", "fileContent": "...", "holder": "user" }
 */
app.post('/swap-asset', (req, res) => {
  const { nodeId, fileName, fileContent, holder } = req.body;

  if (!nodeId || fileContent === undefined) {
    return res.status(400).json({
      error: 'Missing required fields: nodeId, fileContent'
    });
  }
  if (!currentProjectPath) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  // Find node in manifest
  const node = currentManifest ? currentManifest.nodes.find(n => n.id === nodeId) : null;
  if (!node) {
    return res.status(404).json({ error: `Node "${nodeId}" not found in manifest` });
  }

  // Check lock if locked
  const lockState = getLockState(nodeId);
  if (lockState.status === 'locked' && holder && lockState.holder !== holder) {
    return res.status(403).json({
      error: `Node "${nodeId}" is locked by "${lockState.holder}". Cannot swap asset.`,
      lock: lockState
    });
  }

  // Convert fileContent to Buffer
  let buffer;
  if (typeof fileContent === 'string') {
    const base64Prefix = /^data:[^;]+;base64,/;
    if (base64Prefix.test(fileContent)) {
      buffer = Buffer.from(fileContent.replace(base64Prefix, ''), 'base64');
    } else {
      try {
        const testBuf = Buffer.from(fileContent, 'base64');
        if (testBuf.length > 0 && (testBuf.toString('ascii', 0, 4) === 'glTF' || testBuf[0] === 0x89)) {
          buffer = testBuf;
        } else {
          buffer = Buffer.from(fileContent, 'utf-8');
        }
      } catch (_) {
        buffer = Buffer.from(fileContent, 'utf-8');
      }
    }
  } else if (Buffer.isBuffer(fileContent)) {
    buffer = fileContent;
  } else {
    buffer = Buffer.from(JSON.stringify(fileContent), 'utf-8');
  }

  // Inspect the replacement asset
  const assetInfo = inspectAssetFile(buffer, fileName || nodeId);

  // Get slot contract
  let slotContract = node.slot;
  if (!slotContract && node.contract && node.contract.slot) {
    slotContract = node.contract.slot;
  }
  if (!slotContract) {
    const parsed = parseSlotContract(nodeId, currentProjectPath);
    slotContract = parsed.slot;
  }

  // Validate replacement asset against slot contract
  const validation = validateAssetAgainstSlot(slotContract, assetInfo);

  // Write file to target path
  const targetPath = join(currentProjectPath, nodeId);
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }
  writeFileSync(targetPath, buffer);

  res.json({
    success: true,
    nodeId,
    path: targetPath,
    fileName: fileName || basename(nodeId),
    bytesWritten: buffer.length,
    validation,
    assetInfo
  });
});

/**
 * POST /validate-asset
 * Validate an asset file against a slot contract without swapping (T028).
 * Body: { nodeId: "...", fileContent: "...", fileName: "..." }
 */
app.post('/validate-asset', (req, res) => {
  const { nodeId, fileName, fileContent } = req.body;

  if (!nodeId) {
    return res.status(400).json({ error: 'Missing required field: nodeId' });
  }
  if (!currentProjectPath) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  const node = currentManifest ? currentManifest.nodes.find(n => n.id === nodeId) : null;
  if (!node) {
    return res.status(404).json({ error: `Node "${nodeId}" not found in manifest` });
  }

  let buffer;
  if (fileContent !== undefined) {
    const base64Prefix = /^data:[^;]+;base64,/;
    if (typeof fileContent === 'string' && base64Prefix.test(fileContent)) {
      buffer = Buffer.from(fileContent.replace(base64Prefix, ''), 'base64');
    } else if (typeof fileContent === 'string') {
      buffer = Buffer.from(fileContent, 'utf-8');
    } else {
      buffer = Buffer.from(fileContent);
    }
  } else {
    // Read from disk
    const targetPath = join(currentProjectPath, nodeId);
    if (!existsSync(targetPath)) {
      return res.status(404).json({ error: `Asset file "${nodeId}" does not exist on disk` });
    }
    buffer = readFileSync(targetPath);
  }

  const assetInfo = inspectAssetFile(buffer, fileName || nodeId);
  let slotContract = node.slot || (node.contract && node.contract.slot);
  if (!slotContract) {
    const parsed = parseSlotContract(nodeId, currentProjectPath);
    slotContract = parsed.slot;
  }

  const validation = validateAssetAgainstSlot(slotContract, assetInfo);

  res.json({
    success: true,
    nodeId,
    validation,
    assetInfo
  });
});

/**
 * GET /preview-url
 * Returns last-used preview URL for a project from .contextforge.preview.json (T048).
 * Query: ?projectPath=...
 */
app.get('/preview-url', (req, res) => {
  const projectPath = req.query.projectPath || currentProjectPath;
  if (!projectPath) {
    return res.status(400).json({ error: 'Missing projectPath query param' });
  }

  const sidecarPath = join(projectPath, '.contextforge.preview.json');
  if (existsSync(sidecarPath)) {
    try {
      const data = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
      return res.json({ url: data.url || null });
    } catch (_) {
      return res.json({ url: null });
    }
  }
  return res.json({ url: null });
});

/**
 * POST /preview-url
 * Persists last-used preview URL for a project into .contextforge.preview.json (T048).
 * Body: { projectPath, url }
 */
app.post('/preview-url', (req, res) => {
  const { projectPath, url } = req.body;
  const targetProject = projectPath || currentProjectPath;
  if (!targetProject) {
    return res.status(400).json({ error: 'Missing projectPath in request body' });
  }
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing valid url string' });
  }

  try {
    const sidecarPath = join(targetProject, '.contextforge.preview.json');
    const data = {
      url: url.trim(),
      updated_at: new Date().toISOString()
    };
    writeFileSync(sidecarPath, JSON.stringify(data, null, 2), 'utf-8');
    return res.json({ success: true, url: data.url });
  } catch (err) {
    return res.status(500).json({ error: `Failed to save preview URL: ${err.message}` });
  }
});

/**
 * POST /init-project
 * Scaffold a new game project folder with engine boilerplate and AI-agent-loop docs (T050, T051).
 * Body: { targetFolder: "...", engine: "godot"|"js"|"mixed", projectName: "..." }
 */
app.post('/init-project', (req, res) => {
  try {
    const { targetFolder, engine, projectName } = req.body;
    const result = scaffoldNewProject({ targetFolder, engine, projectName });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /project-progress
 * Parse target project's TASKS.md checkbox states into phase progress stats (T052, T053).
 * Query: ?projectPath=...
 */
app.get('/project-progress', (req, res) => {
  const projectPath = req.query.projectPath || currentProjectPath;
  if (!projectPath) {
    return res.status(400).json({ error: 'Missing projectPath query param' });
  }

  const result = parseProjectProgress(projectPath);
  return res.json(result);
});

/**
 * POST /browse-folder
 * Open native directory picker (zenity on Linux) to select a folder.
 */
app.post('/browse-folder', (_req, res) => {
  try {
    const chosen = execSync('zenity --file-selection --directory --title="Choose Parent Directory" 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 60000
    }).trim();
    if (chosen) {
      return res.json({ success: true, path: chosen });
    }
    return res.json({ success: false, cancelled: true });
  } catch (err) {
    return res.json({ success: false, error: err.message || 'Folder picker cancelled or unavailable' });
  }
});

/**
 * POST /open-godot
 * Launch installed Godot editor at specified project path.
 * Body: { projectPath: "..." }
 */
app.post('/open-godot', (req, res) => {
  const { projectPath, mode } = req.body || {};
  const target = cleanAndResolvePath(projectPath || currentProjectPath);
  if (!target || !existsSync(target)) {
    return res.status(400).json({ error: 'Missing or non-existent projectPath' });
  }

  let godotBin = null;
  try {
    const whichRes = execSync('which godot 2>/dev/null || which godot4 2>/dev/null || which /home/aymen/.local/bin/godot 2>/dev/null', {
      encoding: 'utf-8'
    }).trim();
    if (whichRes) godotBin = whichRes.split('\n')[0];
  } catch (_) {}

  if (!godotBin) {
    return res.json({ success: false, launched: false, error: 'Godot executable was not found on your system PATH.', projectPath: target });
  }

  if (mode === 'run') {
    // Proactively capture any compiler/parse errors immediately on launch
    try {
      runGodotCheck(target);
    } catch (_) {}
  }

  try {
    const args = mode === 'run' ? ['--path', target] : ['--editor', '--path', target];
    const child = spawn(godotBin, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (mode === 'run') {
      activeGodotProcess = { pid: child.pid, child, target, isPaused: false };
      child.on('exit', () => {
        if (activeGodotProcess && activeGodotProcess.child === child) {
          activeGodotProcess = null;
        }
        recordAppLog(`Godot game process (PID ${child.pid}) exited`, 'info');
      });
      recordAppLog(`Launched Godot game at: ${basename(target)} (PID ${child.pid})`, 'success');
    } else {
      recordAppLog(`Opened Godot editor for: ${basename(target)}`, 'info');
    }

    if (child.stdout) {
      child.stdout.on('data', (d) => {
        recordConsoleLog(target, d.toString(), false);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        recordConsoleLog(target, d.toString(), true);
      });
    }
    child.on('error', (err) => {
      console.warn('Godot process error:', err.message);
      recordConsoleLog(target, `Godot process error: ${err.message}`, true);
      recordAppLog(`Godot process error: ${err.message}`, 'error');
    });
    child.unref();
    return res.json({ success: true, launched: true, mode: mode || 'editor', bin: godotBin, projectPath: target });
  } catch (err) {
    recordAppLog(`Failed to launch Godot: ${err.message}`, 'error');
    return res.json({ success: false, launched: false, error: err.message, projectPath: target });
  }
});

/**
 * GET /app-logs
 * Returns ContextForge app & server logs.
 */
app.get('/app-logs', (_req, res) => {
  return res.json({ success: true, logs: getAppLogs() });
});

/**
 * POST /app-logs/clear
 * Clears ContextForge app & server logs.
 */
app.post('/app-logs/clear', (_req, res) => {
  clearAppLogs();
  recordAppLog('ContextForge console cleared', 'info');
  return res.json({ success: true });
});

/**
 * POST /game/pause
 * Toggles pause on the running game process (Godot SIGSTOP/SIGCONT).
 */
app.post('/game/pause', (req, res) => {
  if (activeGodotProcess && activeGodotProcess.pid) {
    try {
      if (!activeGodotProcess.isPaused) {
        process.kill(activeGodotProcess.pid, 'SIGSTOP');
        activeGodotProcess.isPaused = true;
        recordAppLog(`Godot process (PID ${activeGodotProcess.pid}) paused (SIGSTOP)`, 'warn');
        return res.json({ success: true, isPaused: true, type: 'godot' });
      } else {
        process.kill(activeGodotProcess.pid, 'SIGCONT');
        activeGodotProcess.isPaused = false;
        recordAppLog(`Godot process (PID ${activeGodotProcess.pid}) resumed (SIGCONT)`, 'success');
        return res.json({ success: true, isPaused: false, type: 'godot' });
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  return res.json({ success: true, isPaused: false, noProcess: true });
});

/**
 * POST /game/stop
 * Terminates running game process (Godot SIGTERM or dev server).
 */
app.post('/game/stop', async (req, res) => {
  const { projectPath } = req.body || {};
  let stoppedAny = false;

  if (activeGodotProcess && activeGodotProcess.pid) {
    try {
      process.kill(activeGodotProcess.pid, 'SIGTERM');
      recordAppLog(`Terminated Godot game process (PID ${activeGodotProcess.pid})`, 'warn');
      activeGodotProcess = null;
      stoppedAny = true;
    } catch (_) {}
  }

  const target = cleanAndResolvePath(projectPath || currentProjectPath);
  if (target) {
    try {
      const devRes = await stopDevServer(target);
      if (devRes && devRes.stopped) {
        recordAppLog(`Stopped web dev server for ${basename(target)}`, 'warn');
        stoppedAny = true;
      }
    } catch (_) {}
  }

  return res.json({ success: true, stopped: stoppedAny });
});

/**
 * GET /console-logs
 * Return captured console output for project, with Godot check support.
 * Query: ?projectPath=...&check=true&clear=true
 */
app.get('/console-logs', (req, res) => {
  const projectPath = req.query.projectPath || currentProjectPath;
  const forceCheck = req.query.check === 'true';
  const clear = req.query.clear === 'true';

  const norm = cleanAndResolvePath(projectPath);

  if (!norm || !existsSync(norm)) {
    return res.status(400).json({ error: 'Missing or non-existent projectPath' });
  }

  if (clear) {
    clearConsoleLogs(norm);
    return res.json({ success: true, projectPath: norm, logs: [], redLogs: [], totalCount: 0, errorCount: 0 });
  }

  const isGodot = existsSync(join(norm, 'project.godot')) ||
    (currentManifest && (currentManifest.engine === 'godot' || (currentManifest.nodes && currentManifest.nodes.some(n => n.engine === 'godot'))));

  let currentData = getConsoleLogs(norm);

  // If Godot project and either forceCheck requested OR buffer has 0 errors, run godot check
  if (isGodot && (forceCheck || currentData.errorCount === 0)) {
    runGodotCheck(norm);
    currentData = getConsoleLogs(norm);
  }

  const isJs = !isGodot && (
    existsSync(join(norm, 'package.json')) ||
    existsSync(join(norm, 'index.html')) ||
    (currentManifest && (currentManifest.engine === 'js' || currentManifest.engine === 'html'))
  );

  // If JS/HTML project: ensure diagnostics bridge is in HTML and run static syntax check
  if (isJs && (forceCheck || currentData.errorCount === 0)) {
    ensureDiagnosticsBridge(norm);
    runJsCheck(norm);
    currentData = getConsoleLogs(norm);
  }

  return res.json({
    success: true,
    projectPath: norm,
    logs: currentData.logs,
    redLogs: currentData.redLogs,
    totalCount: currentData.totalCount,
    errorCount: currentData.errorCount
  });
});

/**
 * POST /client-log
 * Receives runtime browser errors, unhandled rejections, and console.error calls from HTML games.
 */
app.post('/client-log', (req, res) => {
  const { projectPath, level, message, source, lineno, colno, stack } = req.body || {};
  const target = projectPath || currentProjectPath;
  if (!target) {
    return res.status(400).json({ error: 'Missing projectPath' });
  }
  const norm = cleanAndResolvePath(target);
  const isError = level === 'error';

  let formatted = message;
  if (!formatted) {
    formatted = `${isError ? 'SCRIPT ERROR' : 'CONSOLE WARN'}: Unknown browser error`;
    if (source) formatted += `\n          at: (${source}${lineno ? `:${lineno}` : ''})`;
  }

  recordConsoleLog(norm, formatted, isError);
  recordAppLog(`[HTML Game ${level ? level.toUpperCase() : 'ERROR'}] ${formatted.split('\n')[0]}`, isError ? 'error' : 'warn');

  return res.json({ success: true });
});

/**
 * GET /file-tree
 * Return recursive disk file tree for the project (excluding .git, node_modules, etc.).
 * Query: ?projectPath=...
 */
app.get('/file-tree', (req, res) => {
  const projectPath = cleanAndResolvePath(req.query.projectPath || currentProjectPath);
  if (!projectPath || !existsSync(projectPath)) {
    return res.status(400).json({ error: 'Missing or non-existent projectPath' });
  }
  try {
    const files = getProjectFileTree(projectPath);
    return res.json({ success: true, projectPath, files });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /file-content
 * Read raw content of any file in the project.
 * Query: ?projectPath=...&filePath=...
 */
app.get('/file-content', (req, res) => {
  const projectPath = cleanAndResolvePath(req.query.projectPath || currentProjectPath);
  const filePath = req.query.filePath;
  if (!projectPath || !filePath) {
    return res.status(400).json({ error: 'Missing projectPath or filePath' });
  }
  const norm = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.includes('..')) {
    return res.status(400).json({ error: 'Directory traversal not allowed' });
  }
  const absPath = join(projectPath, norm);
  if (!existsSync(absPath)) {
    return res.status(404).json({ error: `File not found: ${filePath}` });
  }
  try {
    const content = readFileSync(absPath, 'utf-8');
    return res.json({ success: true, filePath: norm, content });
  } catch (err) {
    return res.status(500).json({ error: `Failed to read file: ${err.message}` });
  }
});

/**
 * POST /save-file
 * Save raw content to a file in the project.
 * Body: { projectPath: "...", filePath: "...", content: "..." }
 */
app.post('/save-file', (req, res) => {
  const { projectPath, filePath, content } = req.body;
  const target = cleanAndResolvePath(projectPath || currentProjectPath);
  if (!target || !filePath) {
    return res.status(400).json({ error: 'Missing projectPath or filePath' });
  }
  const norm = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.includes('..')) {
    return res.status(400).json({ error: 'Directory traversal not allowed' });
  }
  const absPath = join(target, norm);
  try {
    const parent = resolve(absPath, '..');
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(absPath, content !== undefined ? content : '', 'utf-8');
    return res.json({ success: true, filePath: norm });
  } catch (err) {
    return res.status(500).json({ error: `Failed to save file: ${err.message}` });
  }
});

/**
 * GET /ping-dev-server
 * Test if the configured dev server URL is responding.
 * Query: ?url=...
 */
app.get('/ping-dev-server', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.json({ reachable: false, error: 'Missing url' });
  }
  let responded = false;
  const sendRes = (data) => {
    if (!responded) {
      responded = true;
      res.json(data);
    }
  };
  try {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const checkReq = client.request(parsed, { method: 'HEAD', timeout: 1200 }, (checkRes) => {
      sendRes({ reachable: true, statusCode: checkRes.statusCode });
    });
    checkReq.on('timeout', () => {
      checkReq.destroy();
      sendRes({ reachable: false, reason: 'timeout' });
    });
    checkReq.on('error', (err) => {
      sendRes({ reachable: false, reason: err.message });
    });
    checkReq.end();
  } catch (err) {
    sendRes({ reachable: false, reason: err.message });
  }
});

/**
 * POST /dev-server/start
 * Ensure dependencies are installed (npm install) and start dev server (npm run dev).
 * Body: { projectPath: "..." }
 */
app.post('/dev-server/start', async (req, res) => {
  const target = req.body?.projectPath || currentProjectPath;
  if (!target) {
    return res.status(400).json({ error: 'Missing projectPath' });
  }
  try {
    const result = await setupAndStartDevServer({ projectPath: target });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /dev-server/stop
 * Gracefully stop running dev server and its child process tree.
 * Body: { projectPath: "..." } or text
 */
app.post('/dev-server/stop', (req, res) => {
  let projectPath = req.query.projectPath;
  if (!projectPath && req.body) {
    if (typeof req.body === 'string') {
      try {
        const parsed = JSON.parse(req.body);
        projectPath = parsed.projectPath;
      } catch (_) {
        projectPath = req.body;
      }
    } else {
      projectPath = req.body.projectPath;
    }
  }
  const target = projectPath || currentProjectPath;
  const result = stopDevServer(target);
  return res.json(result);
});

/**
 * GET /dev-server/status
 * Get the current dev server running state for a project.
 * Query: ?projectPath=...
 */
app.get('/dev-server/status', async (req, res) => {
  const target = req.query.projectPath || currentProjectPath;
  const status = await getDevServerStatus(target);
  return res.json(status);
});

/**
 * POST /add-from-clipboard
 * Parse browser AI response containing either ### FILE: blocks or ### EDIT: blocks.
 * Auto-detects paste format:
 * - Contains "### EDIT:" -> applyAiEditBlocks (surgical patch)
 * - Contains "### FILE:" -> writeAiFilesToProject (full files)
 * Body: { projectPath: "...", content: "..." }
 */
app.post('/add-from-clipboard', (req, res) => {
  try {
    const { projectPath, content } = req.body;
    const target = cleanAndResolvePath(projectPath || currentProjectPath);
    if (!target) {
      return res.status(400).json({ error: 'No project currently loaded. Please extract or specify a project path.' });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing clipboard content' });
    }

    const editBlocks = parseAiEditBlocks(content);
    if (editBlocks.length > 0) {
      const result = applyAiEditBlocks(target, content);
      return res.json(result);
    }

    const fileBlocks = parseAiFileBlocks(content);
    if (fileBlocks.length > 0) {
      const result = writeAiFilesToProject(target, content);
      return res.json({ ...result, type: 'file' });
    } else {
      return res.status(400).json({
        error: "Zero blocks found matching '### FILE:' or '### EDIT:' formats.\n\n" +
          "Expected formats:\n\n" +
          "1) Full File (Create/Overwrite):\n" +
          "### FILE: relative/path/to/file.ext\n" +
          "```\n" +
          "<complete file contents>\n" +
          "```\n\n" +
          "2) Surgical Edit (Patch):\n" +
          "### EDIT: relative/path/to/file.ext\n" +
          "<<<<<<< FIND\n" +
          "<exact original code snippet>\n" +
          "=======\n" +
          "<replacement code>\n" +
          ">>>>>>> REPLACE"
      });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /file-outline
 * Query: projectPath, filePath
 * Return lightweight cached outline and line metrics.
 */
app.get('/file-outline', (req, res) => {
  try {
    const { projectPath, filePath } = req.query;
    const target = cleanAndResolvePath(projectPath || currentProjectPath);
    if (!target || !filePath) {
      return res.status(400).json({ success: false, error: 'Missing projectPath or filePath' });
    }
    const outlineData = getCachedFileOutline(target, filePath);
    if (!outlineData) {
      return res.status(404).json({ success: false, error: `File not found: ${filePath}` });
    }
    res.json({
      success: true,
      filePath,
      outline: outlineData.outline,
      linesCount: outlineData.linesCount,
      isOversized: outlineData.linesCount >= OVERSIZED_LINE_THRESHOLD,
      threshold: OVERSIZED_LINE_THRESHOLD
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /scoped-context
 * Assembles scoped context prompt for issue reporting or task handoffs.
 * Body: { projectPath, targetFile, issueDescription, attachedFiles, fileModes }
 */
app.post('/scoped-context', (req, res) => {
  try {
    const {
      projectPath,
      targetFile,
      issueDescription,
      attachedFiles = [],
      fileModes = {},
      consoleLogs = '',
      consoleMode = 'red_only'
    } = req.body;
    const target = cleanAndResolvePath(projectPath || currentProjectPath);
    if (!target) {
      return res.status(400).json({ error: 'No project currently loaded. Please extract or specify a project path.' });
    }

    let formattedConsole = '';
    if (typeof consoleLogs === 'string' && consoleLogs.trim()) {
      formattedConsole = consoleLogs.trim();
    } else if (Array.isArray(consoleLogs) && consoleLogs.length > 0) {
      formattedConsole = consoleLogs.map(l => (typeof l === 'object' && l.text ? l.text : String(l))).join('\n');
    }

    const filesToProcess = attachedFiles.length > 0 ? [...attachedFiles] : (targetFile ? [targetFile] : []);

    // Auto-detect target file from console if not specified
    let effectiveTarget = targetFile;
    if (!effectiveTarget && formattedConsole) {
      const match = formattedConsole.match(/(?:res:\/\/|[\s('"])([a-zA-Z0-9_./-]+\.(?:gd|js|ts|html|tscn|json))(?::(\d+))?/);
      if (match) {
        const candidate = match[1].replace(/^res:\/\//, '');
        if (existsSync(resolve(target, candidate))) {
          effectiveTarget = candidate;
          if (!filesToProcess.includes(candidate)) {
            filesToProcess.unshift(candidate);
          }
        }
      }
    }

    const isGodot = currentManifest && (currentManifest.engine === 'godot' || (currentManifest.nodes && currentManifest.nodes.some(n => n.engine === 'godot')));
    const engineName = isGodot ? 'Godot 4.x (GDScript)' : 'HTML5, Vite, and Three.js';
    const gameName = currentManifest ? basename(currentManifest.project_root) : (target ? basename(target) : 'My Game');

    const scopedSections = [];
    const fullSections = [];
    const oversizedFiles = [];

    for (const f of filesToProcess) {
      const absPath = resolve(target, f);
      if (!existsSync(absPath)) continue;

      const rawContent = readFileSync(absPath, 'utf-8');
      const linesCount = rawContent.split(/\r?\n/).length;
      if (linesCount >= OVERSIZED_LINE_THRESHOLD) {
        oversizedFiles.push({ file: f, linesCount });
      }

      const mode = fileModes[f] || 'scoped';
      const outlineData = getCachedFileOutline(target, f);
      const outlineText = outlineData ? outlineData.outline : '// (No outline available)';

      // Full representation for baseline comparison
      fullSections.push(`### FILE: ${f}\n\`\`\`\n${rawContent}\n\`\`\``);

      if (mode === 'full') {
        scopedSections.push(`### FILE: ${f} (Full Source)\n\`\`\`\n${rawContent}\n\`\`\``);
      } else {
        // Scoped mode
        if (f === effectiveTarget || f === targetFile) {
          const queryText = (issueDescription || '') + '\n' + (formattedConsole || '');
          const snippet = extractScopedSnippet(rawContent, queryText);
          let targetSection = `### FILE: ${f} (Scoped Context)\n// --- Symbol Outline ---\n${outlineText}`;
          if (snippet) {
            targetSection += `\n\n// --- Focused snippet around line ${snippet.targetLine} ---\n\`\`\`\n${snippet.snippet}\n\`\`\``;
          } else {
            targetSection += '\n\n// (No specific line or symbol detected in description. Toggle to Full File if whole implementation is needed.)';
          }
          scopedSections.push(targetSection);
        } else {
          // Dependency file: outline only
          scopedSections.push(`### FILE: ${f} (Outline / Interface Only)\n\`\`\`\n${outlineText}\n\`\`\``);
        }
      }
    }

    const buildPrompt = (sections) => `I am working on the game "${gameName}" using ${engineName}.

ISSUE DESCRIPTION / ERROR:
${issueDescription || '[Describe what is wrong or paste the error message above]'}${formattedConsole ? `\n\nCONSOLE OUTPUT / ERROR LOG:\n\`\`\`\n${formattedConsole}\n\`\`\`` : ''}

CURRENT FILE CONTEXT:
${sections.length > 0 ? sections.join('\n\n') : '(No files attached)'}

Please provide a surgical patch to fix this issue.

CRITICAL FORMAT REQUIREMENT:
Respond ONLY with a PATCH using surgical edit blocks in this exact format:
### EDIT: relative/path.ext
<<<<<<< FIND
<exact original code snippet, unmodified, enough lines to be unique in the file>
=======
<replacement code>
>>>>>>> REPLACE

RULES:
- Only include the lines that need to change in FIND, with enough surrounding context to make it uniquely identifiable in the file. Do not repeat the whole file.
- Output ONLY edit blocks in this format — no explanation before, between, or after them.
- Never truncate replacement code or write placeholders like '// rest stays the same'.`;

    const scopedPrompt = buildPrompt(scopedSections);
    const fullPrompt = buildPrompt(fullSections);

    const chars = scopedPrompt.length;
    const tokens = Math.round(chars / 4);
    const fullChars = fullPrompt.length;
    const fullTokens = Math.round(fullChars / 4);
    const savingsPercent = fullChars > 0 ? Math.max(0, Math.round(((fullChars - chars) / fullChars) * 100)) : 0;

    res.json({
      success: true,
      prompt: scopedPrompt,
      chars,
      tokens,
      fullChars,
      fullTokens,
      savingsPercent,
      oversizedFiles
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Start ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ContextForge server running at http://localhost:${PORT}`);
});
