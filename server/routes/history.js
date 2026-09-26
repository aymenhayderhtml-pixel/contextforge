import { Router } from 'express';
import { cleanAndResolvePath } from '../paths.js';
import { serverState } from '../state.js';
import { undo, redo, getHistoryStatus, clearHistory } from '../history-manager.js';

const router = Router();

/**
 * POST /history/undo
 * Undo the most recent file change transaction (up to 20 steps).
 */
router.post('/history/undo', (req, res) => {
  const { projectPath } = req.body || {};
  const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
  if (!target) return res.status(400).json({ error: 'Missing or unloaded projectPath' });
  const result = undo(target);
  return res.json(result);
});

/**
 * POST /history/redo
 * Redo the most recently undone transaction.
 */
router.post('/history/redo', (req, res) => {
  const { projectPath } = req.body || {};
  const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
  if (!target) return res.status(400).json({ error: 'Missing or unloaded projectPath' });
  const result = redo(target);
  return res.json(result);
});

/**
 * GET /history/status
 * Get canUndo, canRedo, counts, and descriptions.
 */
router.get('/history/status', (req, res) => {
  const target = cleanAndResolvePath(req.query.projectPath || serverState.currentProjectPath);
  if (!target) return res.json({ success: true, canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
  const status = getHistoryStatus(target);
  return res.json({ success: true, ...status });
});

/**
 * POST /history/clear
 * Clear undo/redo history for a project.
 */
router.post('/history/clear', (req, res) => {
  const { projectPath } = req.body || {};
  const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
  if (target) clearHistory(target);
  return res.json({ success: true });
});

export default router;
