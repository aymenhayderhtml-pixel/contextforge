import { Router } from 'express';
import { join, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { cleanAndResolvePath } from '../paths.js';
import { serverState } from '../state.js';
import { setupAndStartDevServer, stopDevServer, getDevServerStatus } from '../dev-server.js';
import { recordConsoleLog, runGodotCheck, recordAppLog } from '../console-manager.js';

const router = Router();

/**
 * GET /preview-url
 * Returns last-used preview URL for a project from .contextforge.preview.json (T048).
 * Query: ?projectPath=...
 */
router.get('/preview-url', (req, res) => {
  const projectPath = req.query.projectPath || serverState.currentProjectPath;
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
router.post('/preview-url', (req, res) => {
  const { projectPath, url } = req.body;
  const targetProject = projectPath || serverState.currentProjectPath;
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
 * POST /browse-folder
 * Open native directory picker (zenity on Linux) to select a folder.
 */
router.post('/browse-folder', (_req, res) => {
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
router.post('/open-godot', (req, res) => {
  const { projectPath, mode } = req.body || {};
  const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
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
      serverState.activeGodotProcess = { pid: child.pid, child, target, isPaused: false };
      child.on('exit', () => {
        if (serverState.activeGodotProcess && serverState.activeGodotProcess.child === child) {
          serverState.activeGodotProcess = null;
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
 * POST /game/pause
 * Toggles pause on the running game process (Godot SIGSTOP/SIGCONT).
 */
router.post('/game/pause', (req, res) => {
  if (serverState.activeGodotProcess && serverState.activeGodotProcess.pid) {
    try {
      if (!serverState.activeGodotProcess.isPaused) {
        process.kill(serverState.activeGodotProcess.pid, 'SIGSTOP');
        serverState.activeGodotProcess.isPaused = true;
        recordAppLog(`Godot process (PID ${serverState.activeGodotProcess.pid}) paused (SIGSTOP)`, 'warn');
        return res.json({ success: true, isPaused: true, type: 'godot' });
      } else {
        process.kill(serverState.activeGodotProcess.pid, 'SIGCONT');
        serverState.activeGodotProcess.isPaused = false;
        recordAppLog(`Godot process (PID ${serverState.activeGodotProcess.pid}) resumed (SIGCONT)`, 'success');
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
router.post('/game/stop', async (req, res) => {
  const { projectPath } = req.body || {};
  let stoppedAny = false;

  if (serverState.activeGodotProcess && serverState.activeGodotProcess.pid) {
    try {
      process.kill(serverState.activeGodotProcess.pid, 'SIGTERM');
      recordAppLog(`Terminated Godot game process (PID ${serverState.activeGodotProcess.pid})`, 'warn');
      serverState.activeGodotProcess = null;
      stoppedAny = true;
    } catch (_) {}
  }

  const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
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
 * GET /ping-dev-server
 */
router.get('/ping-dev-server', (req, res) => {
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
router.post('/dev-server/start', async (req, res) => {
  const target = req.body?.projectPath || serverState.currentProjectPath;
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
router.post('/dev-server/stop', (req, res) => {
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
  const target = projectPath || serverState.currentProjectPath;
  const result = stopDevServer(target);
  return res.json(result);
});

/**
 * GET /dev-server/status
 * Get the current dev server running state for a project.
 * Query: ?projectPath=...
 */
router.get('/dev-server/status', async (req, res) => {
  const target = cleanAndResolvePath(req.query.projectPath || serverState.currentProjectPath);
  const status = await getDevServerStatus(target);
  const isGodot = target ? existsSync(join(target, 'project.godot')) : false;
  const godotRunning = !!(serverState.activeGodotProcess && serverState.activeGodotProcess.target === target && !serverState.activeGodotProcess.child.killed);
  return res.json({
    ...status,
    isGodot,
    godotRunning
  });
});

export default router;
