import { Router } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanAndResolvePath } from '../paths.js';
import { serverState } from '../state.js';
import {
  recordConsoleLog,
  getConsoleLogs,
  clearConsoleLogs,
  runGodotCheck,
  runJsCheck,
  ensureDiagnosticsBridge,
  recordAppLog,
  getAppLogs,
  clearAppLogs
} from '../console-manager.js';

const router = Router();

/**
 * GET /console-logs
 * Return captured console output for project, with Godot and JS check support.
 * Query: ?projectPath=...&check=true&clear=true
 */
router.get('/console-logs', (req, res) => {
  const projectPath = req.query.projectPath || serverState.currentProjectPath;
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
    (serverState.currentManifest && (serverState.currentManifest.engine === 'godot' || (serverState.currentManifest.nodes && serverState.currentManifest.nodes.some(n => n.engine === 'godot'))));

  let currentData = getConsoleLogs(norm);

  const checkedProjects = router._checkedProjects || (router._checkedProjects = new Set());
  const needsInitialCheck = !checkedProjects.has(norm);

  if (isGodot && (forceCheck || needsInitialCheck)) {
    checkedProjects.add(norm);
    runGodotCheck(norm);
    currentData = getConsoleLogs(norm);
  }

  const isJs = !isGodot && (
    existsSync(join(norm, 'package.json')) ||
    existsSync(join(norm, 'index.html')) ||
    (serverState.currentManifest && (serverState.currentManifest.engine === 'js' || serverState.currentManifest.engine === 'html'))
  );

  if (isJs && (forceCheck || needsInitialCheck)) {
    checkedProjects.add(norm);
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
router.post('/client-log', (req, res) => {
  const { projectPath, level, message, source, lineno } = req.body || {};
  let target = projectPath || serverState.currentProjectPath;
  if (!target && projectConsoleLogs.size > 0) {
    target = projectConsoleLogs.keys().next().value;
  }
  if (!target) {
    target = process.cwd();
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
 * GET /app-logs
 * Returns ContextForge app & server logs.
 */
router.get('/app-logs', (_req, res) => {
  return res.json({ success: true, logs: getAppLogs() });
});

/**
 * POST /app-logs/clear
 * Clears ContextForge app & server logs.
 */
router.post('/app-logs/clear', (_req, res) => {
  clearAppLogs();
  recordAppLog('ContextForge console cleared', 'info');
  return res.json({ success: true });
});

export default router;
