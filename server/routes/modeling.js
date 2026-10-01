import express, { Router } from 'express';
import path from 'node:path';
import os from 'node:os';
import { promises as fsPromises, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cleanAndResolvePath } from '../paths.js';
import { serverState } from '../state.js';
import {
  startProjectGameServer,
  stopProjectGameServer,
  activeProjectServers,
  normalizeProjectPath,
  saveLayout,
  loadLayout,
  loadConfig,
  saveConfig,
  checkHookInstallation,
  installHook,
  importModelFile
} from '../modeling-project-server.js';

const router = Router();

/**
 * POST /modeling/server/start
 * Launches static HTTP server for project on a free port + /cf WebSocket.
 */
router.post('/modeling/server/start', async (req, res) => {
  const target = cleanAndResolvePath(req.body?.projectPath || serverState.currentProjectPath);
  if (!target) {
    return res.status(400).json({ error: 'Missing projectPath' });
  }

  try {
    const result = await startProjectGameServer(target);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /modeling/server/status
 * Queries current status of static project server and /cf WebSocket.
 */
router.get('/modeling/server/status', (req, res) => {
  const target = cleanAndResolvePath(req.query?.projectPath || serverState.currentProjectPath);
  if (!target) {
    return res.json({ running: false, gameConnected: false });
  }

  const norm = normalizeProjectPath(target);
  const entry = activeProjectServers.get(norm);
  if (!entry || !entry.server.listening) {
    return res.json({ running: false, gameConnected: false });
  }

  const gameConnected = Boolean(entry.gameWs && entry.gameWs.readyState === 1);
  return res.json({
    running: true,
    port: entry.port,
    url: entry.url,
    wsUrl: entry.wsUrl,
    gameConnected
  });
});

/**
 * POST /modeling/server/stop
 */
router.post('/modeling/server/stop', (req, res) => {
  const target = cleanAndResolvePath(req.body?.projectPath || serverState.currentProjectPath);
  const result = stopProjectGameServer(target);
  return res.json(result);
});

/**
 * GET /modeling/layout
 * Reads <project>/contextforge/layout.json
 */
router.get('/modeling/layout', async (req, res) => {
  const target = cleanAndResolvePath(req.query?.projectPath || serverState.currentProjectPath);
  if (!target) {
    return res.status(400).json({ error: 'Missing projectPath' });
  }

  try {
    const layout = await loadLayout(target);
    return res.json({ success: true, layout });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /modeling/layout
 * Writes <project>/contextforge/layout.json atomically and keeps .bak copy.
 */
router.post('/modeling/layout', async (req, res) => {
  const target = cleanAndResolvePath(req.body?.projectPath || serverState.currentProjectPath);
  const layout = req.body?.layout;
  if (!target || !layout) {
    return res.status(400).json({ error: 'Missing projectPath or layout in request body' });
  }

  try {
    const result = await saveLayout(target, layout);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /modeling/hook/check
 * Checks if ContextForge runtime hook is present in target main.js and generates diff.
 */
router.post('/modeling/hook/check', (req, res) => {
  const target = cleanAndResolvePath(req.body?.projectPath || serverState.currentProjectPath);
  if (!target) {
    return res.status(400).json({ error: 'Missing projectPath' });
  }

  try {
    const result = checkHookInstallation(target);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /modeling/hook/install
 * Applies the hook to main.js and ensures runtime.js is copied.
 */
router.post('/modeling/hook/install', async (req, res) => {
  const target = cleanAndResolvePath(req.body?.projectPath || serverState.currentProjectPath);
  if (!target) {
    return res.status(400).json({ error: 'Missing projectPath' });
  }

  try {
    const result = await installHook(target);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /modeling/config
 * Reads <project>/contextforge/config.json
 */
router.get('/modeling/config', async (req, res) => {
  const target = cleanAndResolvePath(req.query?.projectPath || serverState.currentProjectPath);
  if (!target) {
    return res.status(400).json({ error: 'Missing projectPath' });
  }

  try {
    const config = await loadConfig(target);
    return res.json({ success: true, config });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /modeling/config
 * Writes <project>/contextforge/config.json
 */
router.post('/modeling/config', async (req, res) => {
  const target = cleanAndResolvePath(req.body?.projectPath || serverState.currentProjectPath);
  const config = req.body?.config;
  if (!target || !config) {
    return res.status(400).json({ error: 'Missing projectPath or config in request body' });
  }

  try {
    const result = await saveConfig(target, config);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /modeling/model/import
 * Copies a .glb/.gltf from sourcePath into <project>/assets/models/ and
 * returns the project-relative path. Rejects files over 50 MB.
 */
router.post('/modeling/model/import', async (req, res) => {
  const target = cleanAndResolvePath(req.body?.projectPath || serverState.currentProjectPath);
  const sourcePath = req.body?.sourcePath;
  const fileName = req.body?.fileName || '';

  if (!target) {
    return res.status(400).json({ error: 'Missing projectPath' });
  }
  if (!sourcePath) {
    return res.status(400).json({ error: 'Missing sourcePath' });
  }

  try {
    const result = await importModelFile(target, sourcePath, fileName);
    return res.json(result);
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ error: err.message });
  }
});

/**
 * POST /modeling/temp/write
 * Stages an uploaded binary (the picked .glb/.gltf) in a temp dir and returns
 * its absolute path, so /modeling/model/import can copy it into the project.
 */
router.post('/modeling/temp/write', express.raw({ type: 'application/octet-stream', limit: '60mb' }), async (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'Empty upload' });
  }
  try {
    const rawName = decodeURIComponent(req.get('X-File-Name') || 'model.glb');
    const name = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'model.glb';
    const dir = path.join(os.tmpdir(), 'cf-model-staging');
    await fsPromises.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}-${name}`);
    await fsPromises.writeFile(dest, req.body);
    return res.json({ success: true, path: dest, bytes: req.body.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /modeling/temp/cleanup
 * Removes a previously staged temp file. Best-effort; never fails the request.
 */
router.post('/modeling/temp/cleanup', async (req, res) => {
  const p = req.body?.path;
  try {
    if (p && p.startsWith(path.join(os.tmpdir(), 'cf-model-staging'))) {
      await fsPromises.unlink(p).catch(() => {});
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Settings (ContextForge-wide, not per-project)
// ---------------------------------------------------------------------------

const SETTINGS_FILE = path.join(os.homedir(), '.contextforge', 'settings.json');
const DEFAULT_SETTINGS = { blenderPath: 'blender' };

async function readSettings() {
  try {
    const raw = await fsPromises.readFile(SETTINGS_FILE, 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(patch) {
  const current = await readSettings();
  const next = { ...current, ...patch };
  await fsPromises.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fsPromises.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

/** GET /modeling/settings */
router.get('/modeling/settings', async (_req, res) => {
  try {
    return res.json(await readSettings());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** POST /modeling/settings — persists blenderPath and friends. */
router.post('/modeling/settings', async (req, res) => {
  try {
    const patch = {};
    if (typeof req.body?.blenderPath === 'string') patch.blenderPath = req.body.blenderPath;
    return res.json(await writeSettings(patch));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /modeling/open-blender
 * Launches Blender on a model file. Uses the configured blenderPath (default
 * `blender`, resolved from PATH). A missing binary produces one clear message.
 */
router.post('/modeling/open-blender', async (req, res) => {
  const target = cleanAndResolvePath(req.body?.projectPath || serverState.currentProjectPath);
  const relPath = req.body?.filePath;
  if (!target) return res.status(400).json({ error: 'Missing projectPath' });
  if (!relPath) return res.status(400).json({ error: 'Missing filePath' });

  const norm = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.includes('..')) return res.status(400).json({ error: 'Directory traversal not allowed' });
  const absPath = path.join(target, norm);
  if (!existsSync(absPath)) return res.status(404).json({ error: `File not found: ${relPath}` });

  const { blenderPath } = await readSettings();
  // spawn() reports a missing binary through the async 'error' event, not by
  // throwing, so wait for the first of (spawn ok | error) before responding.
  const launched = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(blenderPath, [absPath], { detached: true, stdio: 'ignore' });
    } catch (err) {
      return resolve({ ok: false, error: err });
    }
    let settled = false;
    child.once('error', (err) => { if (!settled) { settled = true; resolve({ ok: false, error: err }); } });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      // Detached so Blender keeps running after this request returns.
      child.unref();
      resolve({ ok: true });
    });
  });

  if (!launched.ok) {
    if (launched.error && launched.error.code === 'ENOENT') {
      return res.status(404).json({
        error: 'Blender not found. Set its path in Settings.',
        blenderPath
      });
    }
    return res.status(500).json({ error: launched.error ? launched.error.message : 'Could not launch Blender' });
  }
  return res.json({ success: true, blenderPath, file: absPath });
});

export default router;
