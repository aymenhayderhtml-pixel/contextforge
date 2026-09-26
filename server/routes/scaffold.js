import { Router } from 'express';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateNodeId } from '../scaffold-validator.js';
import { resolveProjectPath } from '../paths.js';
import { serverState, getLockState } from '../state.js';

const router = Router();

/**
 * POST /scaffold
 * Create a new scene/module with boilerplate and a generated prompt.
 * Body: { "nodeId": "scenes/NewScene.tscn", "engine": "godot"|"js", "type": "scene"|"script"|"module", "holder": "agent-1" }
 */
router.post('/scaffold', async (req, res) => {
  const { nodeId, engine, type, holder } = req.body;

  if (!nodeId || !engine || !type || !holder) {
    return res.status(400).json({
      error: 'Missing required fields: nodeId, engine, type, holder'
    });
  }
  if (!serverState.currentManifest || !serverState.currentProjectPath) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  // Validate node ID pattern for engine and type (T031)
  const validation = validateNodeId(nodeId, engine, type);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }
  const cleanNodeId = validation.normalizedId;

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

  // Reject engine/type pairs we have no boilerplate for *before* taking the lock
  if (!boilerplate || !prompt) {
    return res.status(400).json({
      error: `Unsupported combination engine="${engine}" type="${type}". Valid pairs: godot/scene, godot/script, js/module.`
    });
  }

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
  serverState.locks.set(cleanNodeId, newLock);

  // Add dependency context to the prompt
  const existingNodes = serverState.currentManifest.nodes;
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
  const targetPath = resolveProjectPath(serverState.currentProjectPath, cleanNodeId);
  if (!targetPath) {
    return res.status(400).json({ error: `Invalid nodeId "${cleanNodeId}" — must stay inside the project.` });
  }
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

export default router;
