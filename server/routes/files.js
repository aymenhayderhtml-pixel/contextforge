import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanAndResolvePath } from '../paths.js';
import { serverState } from '../state.js';
import { getProjectFileTree } from '../project-init.js';
import { recordHistoryStep } from '../history-manager.js';

const router = Router();

/**
 * GET /file-tree
 * Return recursive disk file tree for the project (excluding .git, node_modules, etc.).
 */
router.get('/file-tree', (req, res) => {
  const projectPath = cleanAndResolvePath(req.query.projectPath || serverState.currentProjectPath);
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
 */
router.get('/file-content', (req, res) => {
  const projectPath = cleanAndResolvePath(req.query.projectPath || serverState.currentProjectPath);
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
 */
router.post('/save-file', (req, res) => {
  const { projectPath, filePath, content } = req.body || {};
  const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
  if (!target || !filePath) {
    return res.status(400).json({ error: 'Missing projectPath or filePath' });
  }
  const norm = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.includes('..')) {
    return res.status(400).json({ error: 'Directory traversal not allowed' });
  }
  const absPath = join(target, norm);
  try {
    const beforeContent = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : null;
    const parent = resolve(absPath, '..');
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    const newContent = content !== undefined ? content : '';
    writeFileSync(absPath, newContent, 'utf-8');
    const tx = recordHistoryStep(target, `Saved ${norm}`, [{ path: norm, before: beforeContent, after: newContent }], { type: 'save' });
    return res.json({ success: true, filePath: norm, patchId: tx ? tx.patchId : null, canUndo: true });
  } catch (err) {
    return res.status(500).json({ error: `Failed to save file: ${err.message}` });
  }
});

export default router;
