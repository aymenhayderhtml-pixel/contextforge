/**
 * server/routes/favorites.js
 * API routes for persistent cross-project asset favorites library (T124, T126).
 */

import express from 'express';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  loadFavorites,
  addFavorite,
  removeFavorite,
  updateFavorite,
  getFavorite
} from '../favorites-manager.js';
import { inspectAssetFile, validateAssetAgainstSlot, parseSlotContract } from '../slot-contract.js';
import { resolveProjectPath } from '../paths.js';
import { serverState } from '../state.js';

const router = express.Router();

/**
 * GET /favorites
 * Lists stored favorites with optional filters (?format, ?tag, ?starred).
 */
router.get('/favorites', (req, res) => {
  try {
    let favorites = loadFavorites();
    const { format, tag, starred } = req.query;

    if (format) {
      const f = String(format).toLowerCase();
      favorites = favorites.filter(item => (item.format || '').toLowerCase() === f);
    }
    if (tag) {
      const t = String(tag).toLowerCase();
      favorites = favorites.filter(item => Array.isArray(item.tags) && item.tags.includes(t));
    }
    if (starred !== undefined) {
      const isStarred = starred === 'true' || starred === '1';
      favorites = favorites.filter(item => Boolean(item.starred) === isStarred);
    }

    res.json({
      success: true,
      count: favorites.length,
      favorites
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /favorites
 * Adds an asset to the cross-project favorites library.
 * Body: { name, format, tags, thumbnail, fileContent, assetInfo, sourceProject }
 */
router.post('/favorites', (req, res) => {
  try {
    const { name, format, tags, thumbnail, fileContent, assetInfo, sourceProject } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Missing required field: name' });
    }

    const created = addFavorite({
      name,
      format,
      tags,
      thumbnail,
      fileContent,
      assetInfo,
      sourceProject: sourceProject || serverState.currentProjectPath || ''
    });

    res.status(201).json({
      success: true,
      favorite: created
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /favorites/:id
 * Removes a favorite from the library.
 */
router.delete('/favorites/:id', (req, res) => {
  try {
    const { id } = req.params;
    const removed = removeFavorite(id);
    if (!removed) {
      return res.status(404).json({ error: `Favorite with ID "${id}" not found` });
    }
    res.json({ success: true, deleted: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /favorites/:id
 * Updates tags, name, or starred status.
 */
router.put('/favorites/:id', (req, res) => {
  try {
    const { id } = req.params;
    const updated = updateFavorite(id, req.body);
    if (!updated) {
      return res.status(404).json({ error: `Favorite with ID "${id}" not found` });
    }
    res.json({ success: true, favorite: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /favorites/:id/swap-into
 * Directly swaps a favorite asset into the current target project slot (T126).
 * Body: { nodeId, projectPath }
 */
router.post('/favorites/:id/swap-into', (req, res) => {
  try {
    const { id } = req.params;
    const { nodeId, projectPath } = req.body;
    const projPath = projectPath || serverState.currentProjectPath;

    if (!nodeId) {
      return res.status(400).json({ error: 'Missing required field: nodeId' });
    }
    if (!projPath) {
      return res.status(400).json({ error: 'No active project path. Extract a project first.' });
    }

    const fav = getFavorite(id);
    if (!fav) {
      return res.status(404).json({ error: `Favorite asset "${id}" not found in library` });
    }
    if (!fav.fileContent) {
      return res.status(400).json({ error: `Favorite asset "${id}" does not have stored fileContent to swap` });
    }

    const buffer = Buffer.from(fav.fileContent, 'base64');
    const assetInfo = fav.assetInfo || inspectAssetFile(buffer, fav.name);

    // Get slot contract from manifest or disk
    let node = serverState.currentManifest ? serverState.currentManifest.nodes.find(n => n.id === nodeId) : null;
    let slotContract = node?.slot || node?.contract?.slot;
    if (!slotContract) {
      const parsed = parseSlotContract(nodeId, projPath);
      slotContract = parsed.slot;
    }

    const validation = validateAssetAgainstSlot(slotContract, assetInfo);
    if (!validation.valid) {
      return res.status(422).json({
        success: false,
        error: 'Favorite asset does not satisfy slot contract requirements',
        validation,
        assetInfo
      });
    }

    const safeTargetPath = resolveProjectPath(projPath, nodeId);
    if (!safeTargetPath) {
      return res.status(400).json({ error: `Invalid target nodeId "${nodeId}"` });
    }

    const targetDir = dirname(safeTargetPath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    writeFileSync(safeTargetPath, buffer);

    res.json({
      success: true,
      nodeId,
      path: safeTargetPath,
      favoriteId: fav.id,
      favoriteName: fav.name,
      bytesWritten: buffer.length,
      validation,
      assetInfo
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
