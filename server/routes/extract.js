import { Router } from 'express';
import { existsSync } from 'node:fs';
import { cleanAndResolvePath, detectEngines, computeDependedOnBy } from '../paths.js';
import { serverState, getLockState } from '../state.js';
import { validateManifest } from '../schema/validate.js';
import { extract as extractGodot } from '../extractors/godot-extractor.js';
import { extract as extractJs } from '../extractors/js-extractor.js';

const router = Router();

/**
 * Run extractors, merge, compute depended_on_by, validate, return manifest.
 * @param {string} projectPath
 * @returns {Promise<object>}
 */
export async function runExtraction(projectPath) {
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

/**
 * POST /extract
 * Run extractor(s) against a given project path.
 * Body: { "projectPath": "/absolute/path/to/project" }
 */
router.post('/extract', async (req, res) => {
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
    serverState.currentManifest = manifest;
    serverState.currentProjectPath = absPath;

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
router.get('/manifest', (_req, res) => {
  if (!serverState.currentManifest) {
    return res.status(404).json({
      error: 'No manifest loaded. Use POST /extract with a project path first.'
    });
  }
  res.json(serverState.currentManifest);
});

/**
 * POST /lock
 * Attempt to lock a node for a session.
 * Body: { "nodeId": "scenes/Player.tscn", "holder": "agent-1" }
 * Fails if already locked by a different holder (unless stale).
 */
router.post('/lock', (req, res) => {
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
      serverState.locks.set(nodeId, refreshed);
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
  serverState.locks.set(nodeId, newLock);
  res.json({ success: true, lock: newLock });
});

/**
 * POST /unlock
 * Release a lock held by the caller's session.
 * Body: { "nodeId": "scenes/Player.tscn", "holder": "agent-1" }
 * Optionally: { "nodeId": "...", "holder": "...", "force": true } to force-unlock.
 */
router.post('/unlock', (req, res) => {
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
    serverState.locks.set(nodeId, freed);
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
  serverState.locks.set(nodeId, freed);
  res.json({ success: true, lock: freed });
});

/**
 * POST /force-unlock (compatibility alias for POST /unlock with force: true)
 */
router.post('/force-unlock', (req, res) => {
  const { nodeId } = req.body || {};
  if (!nodeId) {
    return res.status(400).json({ error: 'Missing "nodeId" in request body' });
  }
  const current = getLockState(nodeId);
  const freed = { status: 'free', holder: '', locked_at: '' };
  serverState.locks.set(nodeId, freed);
  res.json({ success: true, message: `Force-unlocked (was held by "${current.holder}")`, lock: freed });
});

/**
 * GET /locks
 * List all current locks (for the UI and orchestrators).
 */
router.get('/locks', (_req, res) => {
  const result = {};
  for (const [nodeId, _lock] of serverState.locks.entries()) {
    const current = getLockState(nodeId); // auto-releases stale
    if (current.status === 'locked') {
      result[nodeId] = current;
    }
  }
  res.json(result);
});

export default router;
