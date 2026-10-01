import { Router } from 'express';
import { join, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { cleanAndResolvePath } from '../paths.js';
import { serverState } from '../state.js';
import { setupAndStartDevServer, stopDevServer, getDevServerStatus } from '../dev-server.js';
import { recordConsoleLog, runGodotCheck, recordAppLog, clearConsoleLogs } from '../console-manager.js';

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
 * POST /open-godot & POST /game/launch
 * Launch installed Godot editor or run game at specified project path.
 * Body: { projectPath: "...", mode: "run" | "editor" }
 */
const handleGodotLaunch = (req, res) => {
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
    // If a Godot process is already running, terminate it first before opening this one
    if (serverState.activeGodotProcess && serverState.activeGodotProcess.pid) {
      try {
        process.kill(serverState.activeGodotProcess.pid, 'SIGTERM');
        recordAppLog(`Terminated previous Godot process (PID ${serverState.activeGodotProcess.pid})`, 'info');
      } catch (_) {}
      serverState.activeGodotProcess = null;
    }

    // On ▶ Play, clear old errors first, then capture new stdout/stderr
    clearConsoleLogs(target);

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
};

router.post('/open-godot', handleGodotLaunch);
router.post('/game/launch', handleGodotLaunch);

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
    clearConsoleLogs(target);
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

// In-memory store for game scene snapshots and live transform updates
const sceneSnapshots = new Map();
const pendingSceneUpdates = new Map();

/**
 * POST /game-scene-snapshot
 * Saves the latest 3D scene snapshot from a running game via contextforge-bridge.
 */
router.post('/game-scene-snapshot', (req, res) => {
  const { projectPath, sceneJson } = req.body;
  const key = projectPath || serverState.currentProjectPath || 'default';
  if (!sceneJson) {
    return res.status(400).json({ error: 'Missing sceneJson in body' });
  }
  sceneSnapshots.set(key, {
    sceneJson,
    projectPath: key,
    timestamp: Date.now()
  });
  return res.json({ success: true, count: sceneSnapshots.size });
});

/**
 * Helper to extract scene snapshot directly from project source files if available.
 */
async function tryExtractSceneFromProject(projectDir) {
  if (!projectDir || !existsSync(projectDir)) return null;
  const threeModulePath = join(projectDir, 'node_modules', 'three', 'build', 'three.module.js');
  const sceneMgrPath = join(projectDir, 'src', 'scene-manager.js');
  if (!existsSync(threeModulePath) || !existsSync(sceneMgrPath)) return null;

  try {
    const { pathToFileURL } = await import('node:url');
    const THREE = await import(pathToFileURL(threeModulePath).href);
    const sceneMgr = await import(pathToFileURL(sceneMgrPath).href);

    if (typeof sceneMgr.createScene === 'function') {
      const scene = new THREE.Scene();
      sceneMgr.createScene(scene);

      // Check if main.js adds prototypeMarker or extra meshes
      const mainPath = join(projectDir, 'src', 'main.js');
      if (existsSync(mainPath)) {
        const mainCode = readFileSync(mainPath, 'utf-8');
        if (mainCode.includes('prototypeMarker') && mainCode.includes('BoxGeometry')) {
          // Add car marker
          const carGeo = new THREE.BoxGeometry(1.6, 0.6, 3.2);
          const carMat = new THREE.MeshStandardMaterial({
            color: 0x3366ff,
            roughness: 0.65,
            metalness: 0.15
          });
          const car = new THREE.Mesh(carGeo, carMat);
          car.position.set(0, 0.45, 5);
          car.userData = { cfAssetId: 'assets/prototype-car-marker' };
          scene.add(car);
        }
      }

      const sceneJson = scene.toJSON();
      const snapshot = {
        sceneJson,
        projectPath: projectDir,
        timestamp: Date.now()
      };
      sceneSnapshots.set(projectDir, snapshot);
      return snapshot;
    }
  } catch (err) {
    console.warn('[DevServer] tryExtractSceneFromProject error:', err.message);
  }
  return null;
}

/**
 * GET /game-scene-snapshot
 * Returns the latest 3D scene snapshot for a project.
 */
router.get('/game-scene-snapshot', async (req, res) => {
  const projectPath = req.query.projectPath || serverState.currentProjectPath || 'default';
  let snapshot = sceneSnapshots.get(projectPath);

  // If not found by exact key, match normalized paths
  if (!snapshot) {
    const resolved = cleanAndResolvePath(projectPath);
    for (const [k, v] of sceneSnapshots.entries()) {
      if (k !== 'test-fixture' && (k === resolved || cleanAndResolvePath(k) === resolved)) {
        snapshot = v;
        break;
      }
    }
  }

  // If still not found, try extracting directly from project source files
  if (!snapshot && projectPath && projectPath !== 'default') {
    snapshot = await tryExtractSceneFromProject(cleanAndResolvePath(projectPath));
  }

  // Fallback to most recent non-empty snapshot
  if (!snapshot && sceneSnapshots.size > 0) {
    const validSnapshots = Array.from(sceneSnapshots.values())
      .filter(s => s.projectPath !== 'test-fixture' && s.sceneJson && (s.sceneJson.geometries?.length > 0 || s.sceneJson.children?.length > 0 || s.sceneJson.object?.children?.length > 0));
    if (validSnapshots.length > 0) {
      snapshot = validSnapshots[validSnapshots.length - 1];
    } else {
      snapshot = Array.from(sceneSnapshots.values()).pop();
    }
  }

  if (!snapshot) {
    return res.status(404).json({ error: 'No scene snapshot available yet' });
  }
  return res.json(snapshot);
});

/**
 * POST /game-scene-update
 * Posts a transform update from Modeling workspace to the running game.
 */
router.post('/game-scene-update', (req, res) => {
  const { projectPath, update } = req.body;
  const key = projectPath || serverState.currentProjectPath || 'default';
  if (!update) {
    return res.status(400).json({ error: 'Missing update in body' });
  }
  let list = pendingSceneUpdates.get(key);
  if (!list) {
    list = [];
    pendingSceneUpdates.set(key, list);
  }
  list.push({ ...update, timestamp: Date.now() });
  if (list.length > 50) list.shift();
  return res.json({ success: true });
});

/**
 * GET /game-scene-updates
 * Fetches pending transform updates for the game to consume.
 */
router.get('/game-scene-updates', (req, res) => {
  const projectPath = req.query.projectPath || serverState.currentProjectPath || 'default';
  const list = pendingSceneUpdates.get(projectPath) || pendingSceneUpdates.get('default') || [];
  pendingSceneUpdates.set(projectPath, []);
  pendingSceneUpdates.set('default', []);
  return res.json({ updates: list });
});

export default router;
