/**
 * server/routes/sessions.js
 * Express routes for Debug Sessions and Structured Verification Comparison.
 */

import { Router } from 'express';
import {
  listSessions,
  createSession,
  getSession,
  updateSession,
  addSessionIteration
} from '../debug-session-manager.js';
import { compareVerification } from '../verification-comparator.js';
import { cleanAndResolvePath } from '../paths.js';

const router = Router();

// GET /debug-sessions?projectPath=...
router.get('/debug-sessions', (req, res) => {
  const projectPath = req.query.projectPath;
  if (!projectPath) {
    return res.status(400).json({ error: 'projectPath query param is required' });
  }
  try {
    const sessions = listSessions(projectPath);
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /debug-sessions
router.post('/debug-sessions', (req, res) => {
  const { projectPath, title, category, strategy, problem } = req.body || {};
  if (!projectPath) {
    return res.status(400).json({ error: 'projectPath is required' });
  }
  try {
    const session = createSession(projectPath, { title, category, strategy, problem });
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /debug-sessions/:id?projectPath=...
router.get('/debug-sessions/:id', (req, res) => {
  const projectPath = req.query.projectPath;
  const sessionId = req.params.id;
  if (!projectPath) {
    return res.status(400).json({ error: 'projectPath query param is required' });
  }
  try {
    const session = getSession(projectPath, sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /debug-sessions/:id/iteration
router.post('/debug-sessions/:id/iteration', (req, res) => {
  const projectPath = req.body?.projectPath;
  const sessionId = req.params.id;
  const iteration = req.body?.iteration;

  if (!projectPath || !iteration) {
    return res.status(400).json({ error: 'projectPath and iteration payload are required' });
  }
  try {
    const session = addSessionIteration(projectPath, sessionId, iteration);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /debug-sessions/:id
router.put('/debug-sessions/:id', (req, res) => {
  const projectPath = req.body?.projectPath;
  const sessionId = req.params.id;
  const updates = req.body?.updates || {};

  if (!projectPath) {
    return res.status(400).json({ error: 'projectPath is required' });
  }
  try {
    const session = updateSession(projectPath, sessionId, updates);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /compare-verification
router.post('/compare-verification', (req, res) => {
  const { previousError, currentError, syntaxValid, syntaxError } = req.body || {};
  try {
    const result = compareVerification({
      previousError,
      currentError,
      syntaxValid,
      syntaxError
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
