import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { extractSingleGodotFile } from '../extractors/godot-extractor.js';
import { extractSingleJsFile } from '../extractors/js-extractor.js';
import { inspectAssetFile, validateAssetAgainstSlot, parseSlotContract } from '../slot-contract.js';
import { recordHistoryStep } from '../history-manager.js';
import { recomputeManifestLinks, resolveProjectPath } from '../paths.js';
import { serverState, getLockState } from '../state.js';

const router = Router();

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
router.post('/paste-back', (req, res) => {
  const { nodeId, holder, code, releaseLock } = req.body;

  if (!nodeId || !holder || code === undefined) {
    return res.status(400).json({
      error: 'Missing required fields: nodeId, holder, code'
    });
  }
  if (!serverState.currentProjectPath) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  // Verify the target stays inside the project before taking the lock
  const safeTargetPath = resolveProjectPath(serverState.currentProjectPath, nodeId);
  if (!safeTargetPath) {
    return res.status(400).json({
      error: `Invalid nodeId "${nodeId}" — must be a relative path inside the project.`
    });
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
  const targetPath = safeTargetPath;
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const beforeContent = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : null;
  writeFileSync(targetPath, code, 'utf-8');
  recordHistoryStep(serverState.currentProjectPath, `Pasted back node ${nodeId}`, [{ path: nodeId, before: beforeContent, after: code }], { type: 'paste-back', nodeId });

  // Re-run extractor on the changed file only (T025)
  let extractedNode = null;
  const ext = nodeId.split('.').pop();
  try {
    if (ext === 'gd' || ext === 'tscn') {
      extractedNode = extractSingleGodotFile(targetPath, serverState.currentProjectPath);
    } else if (['js', 'mjs', 'ts', 'jsx', 'tsx'].includes(ext)) {
      extractedNode = extractSingleJsFile(targetPath, serverState.currentProjectPath);
    }
  } catch (err) {
    console.error(`Single-file extraction error on "${nodeId}":`, err.message);
  }

  const newContract = extractedNode ? extractedNode.contract : { exports: [], signals: [], requires: [] };

  // Compare new contract against what existing dependents expect (T025, T026)
  const validation = validateAgainstDependents(nodeId, newContract, serverState.currentManifest, serverState.currentProjectPath);

  // Update in-memory manifest for this node so subsequent checks reflect current state
  if (serverState.currentManifest && serverState.currentManifest.nodes) {
    const nodeInManifest = serverState.currentManifest.nodes.find(n => n.id === nodeId);
    if (nodeInManifest) {
      nodeInManifest.contract = newContract;
      if (extractedNode && extractedNode.depends_on) {
        nodeInManifest.depends_on = [...new Set(extractedNode.depends_on)].sort();
      }
    } else if (extractedNode) {
      // The node did not exist in the manifest (a brand new file). Add it so the
      // graph does not go stale after a write-back.
      const freshNode = {
        ...extractedNode,
        id: nodeId,
        depends_on: [...new Set(extractedNode.depends_on || [])].sort(),
        depended_on_by: []
      };
      serverState.currentManifest.nodes.push(freshNode);
      recomputeManifestLinks(serverState.currentManifest);
    }
  }

  // Release lock if requested
  let lockReleased = false;
  if (releaseLock) {
    const freed = { status: 'free', holder: '', locked_at: '' };
    serverState.locks.set(nodeId, freed);
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

/**
 * POST /swap-asset
 * Swap in a replacement asset file and validate it against the slot's contract (T028).
 * Body: { "nodeId": "models/character.glb", "fileName": "hero_v2.glb", "fileContent": "...", "holder": "user" }
 */
router.post('/swap-asset', (req, res) => {
  const { nodeId, fileName, fileContent, holder } = req.body;

  if (!nodeId || fileContent === undefined) {
    return res.status(400).json({
      error: 'Missing required fields: nodeId, fileContent'
    });
  }
  if (!serverState.currentProjectPath) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  // Find node in manifest
  const node = serverState.currentManifest ? serverState.currentManifest.nodes.find(n => n.id === nodeId) : null;
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
    const parsed = parseSlotContract(nodeId, serverState.currentProjectPath);
    slotContract = parsed.slot;
  }

  const validation = validateAssetAgainstSlot(slotContract, assetInfo);

  // Verify target path stays inside project root (path traversal defense, T072)
  const safeTargetPath = resolveProjectPath(serverState.currentProjectPath, nodeId);
  if (!safeTargetPath) {
    return res.status(400).json({
      error: `Invalid nodeId "${nodeId}" — must be a relative path inside the project.`
    });
  }

  // Write file to target path
  const targetPath = safeTargetPath;
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
router.post('/validate-asset', (req, res) => {
  const { nodeId, fileName, fileContent } = req.body;

  if (!nodeId) {
    return res.status(400).json({ error: 'Missing required field: nodeId' });
  }
  if (!serverState.currentProjectPath) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  const node = serverState.currentManifest ? serverState.currentManifest.nodes.find(n => n.id === nodeId) : null;
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
    const targetPath = join(serverState.currentProjectPath, nodeId);
    if (!existsSync(targetPath)) {
      return res.status(404).json({ error: `Asset file "${nodeId}" does not exist on disk` });
    }
    buffer = readFileSync(targetPath);
  }

  const assetInfo = inspectAssetFile(buffer, fileName || nodeId);
  let slotContract = node.slot || (node.contract && node.contract.slot);
  if (!slotContract) {
    const parsed = parseSlotContract(nodeId, serverState.currentProjectPath);
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

export default router;
