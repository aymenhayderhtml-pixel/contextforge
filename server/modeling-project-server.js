import { createServer } from 'node:http';
import net from 'node:net';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync, statSync, watch } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, resolve, dirname, extname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNTIME_TEMPLATE_PATH = join(__dirname, 'runtime.js');
// ContextForge's own GLTFLoader build, served to game runtimes that lack one.
const VENDOR_GLTF_LOADER = join(__dirname, '..', 'public', 'vendor', 'GLTFLoader.js');
// Same for SkeletonUtils, which skinned clones need to keep their bones bound.
const VENDOR_SKELETON_UTILS = join(__dirname, '..', 'public', 'vendor', 'SkeletonUtils.js');

/**
 * Registry of active project static + WS servers.
 * Key: normalized projectPath
 * Value: { port, url, wsUrl, server, app, wss, watcher, gameWs, editorWsSet, lastSnapshot, projectPath }
 */
export const activeProjectServers = new Map();

export function normalizeProjectPath(p) {
  if (!p) return '';
  return resolve(p).replace(/\\/g, '/');
}

export function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Ensures that <project>/contextforge/runtime.js exists and is up to date.
 */
export async function ensureRuntimeCopied(projectPath) {
  const cfDir = join(projectPath, 'contextforge');
  if (!existsSync(cfDir)) {
    mkdirSync(cfDir, { recursive: true });
  }
  const dest = join(cfDir, 'runtime.js');
  if (existsSync(RUNTIME_TEMPLATE_PATH)) {
    const templateContent = readFileSync(RUNTIME_TEMPLATE_PATH, 'utf-8');
    writeFileSync(dest, templateContent, 'utf-8');
  }

  // Ship ContextForge's vendored GLTFLoader / SkeletonUtils next to runtime.js.
  // The runtime falls back to them when the project has no local copy, so a
  // skinned model with clips still clones correctly. They live under the
  // project root so the project's own dev server serves them.
  for (const [src, name] of [[VENDOR_GLTF_LOADER, 'GLTFLoader.js'], [VENDOR_SKELETON_UTILS, 'SkeletonUtils.js']]) {
    if (!existsSync(src)) continue;
    const vendorDir = join(cfDir, 'vendor');
    if (!existsSync(vendorDir)) mkdirSync(vendorDir, { recursive: true });
    const vendorDest = join(vendorDir, name);
    const bytes = readFileSync(src);
    if (!existsSync(vendorDest) || readFileSync(vendorDest).length !== bytes.length) {
      writeFileSync(vendorDest, bytes);
    }
  }

  return dest;
}

/**
 * Starts or retrieves the static server + /cf WebSocket server for the given project.
 */
export async function startProjectGameServer(projectPath) {
  const normPath = normalizeProjectPath(projectPath);
  if (!existsSync(normPath)) {
    throw new Error(`Project directory does not exist: ${normPath}`);
  }

  // Check if server already running
  const existing = activeProjectServers.get(normPath);
  if (existing && existing.server.listening) {
    return {
      port: existing.port,
      url: existing.url,
      wsUrl: existing.wsUrl,
      alreadyRunning: true
    };
  }

  // Ensure runtime.js is copied into project
  try {
    await ensureRuntimeCopied(normPath);
  } catch (err) {
    console.warn('[GameServer] Failed to copy runtime.js:', err.message);
  }

  const port = await getFreePort();
  const app = express();

  // CORS headers for all static resources
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Serve runtime.js if requested via /contextforge/runtime.js
  app.get('/contextforge/runtime.js', (_req, res) => {
    const localRuntime = join(normPath, 'contextforge', 'runtime.js');
    if (existsSync(localRuntime)) {
      res.setHeader('Content-Type', 'application/javascript');
      return res.sendFile(localRuntime);
    }
    if (existsSync(RUNTIME_TEMPLATE_PATH)) {
      res.setHeader('Content-Type', 'application/javascript');
      return res.sendFile(RUNTIME_TEMPLATE_PATH);
    }
    res.status(404).send('runtime.js not found');
  });

  // ContextForge's own vendored GLTFLoader, used by the runtime as a fallback
  // when the game project has no three/examples/jsm/loaders/GLTFLoader.js.
  app.get('/__contextforge/vendor/GLTFLoader.js', (_req, res) => {
    if (existsSync(VENDOR_GLTF_LOADER)) {
      res.setHeader('Content-Type', 'application/javascript');
      return res.sendFile(VENDOR_GLTF_LOADER);
    }
    res.status(404).send('ContextForge vendored GLTFLoader not found');
  });

  // ContextForge's own vendored SkeletonUtils, used when a project has no local
  // copy. Skinned model clones need it to keep their bones bound.
  app.get('/__contextforge/vendor/SkeletonUtils.js', (_req, res) => {
    if (existsSync(VENDOR_SKELETON_UTILS)) {
      res.setHeader('Content-Type', 'application/javascript');
      return res.sendFile(VENDOR_SKELETON_UTILS);
    }
    res.status(404).send('ContextForge vendored SkeletonUtils not found');
  });

  // Serve layout.json if requested via /contextforge/layout.json
  app.get('/contextforge/layout.json', (_req, res) => {
    const layoutPath = join(normPath, 'contextforge', 'layout.json');
    if (existsSync(layoutPath)) {
      res.setHeader('Content-Type', 'application/json');
      return res.sendFile(layoutPath);
    }
    res.json({ version: 1, objects: {} });
  });

  // Serve config.json if requested via /contextforge/config.json
  app.get('/contextforge/config.json', (_req, res) => {
    const configPath = join(normPath, 'contextforge', 'config.json');
    if (existsSync(configPath)) {
      res.setHeader('Content-Type', 'application/json');
      return res.sendFile(configPath);
    }
    res.json({ drivenIds: ['Kart_Player', 'Kart_AI_*'] });
  });

  // HTML Middleware: If serving index.html, inject importmap for Three.js if needed
  app.get(['/', '/index.html'], (req, res, next) => {
    let indexHtmlPath = join(normPath, 'index.html');
    if (!existsSync(indexHtmlPath)) {
      if (existsSync(join(normPath, 'public', 'index.html'))) {
        indexHtmlPath = join(normPath, 'public', 'index.html');
      } else if (existsSync(join(normPath, 'dist', 'index.html'))) {
        indexHtmlPath = join(normPath, 'dist', 'index.html');
      } else if (existsSync(join(normPath, 'src', 'index.html'))) {
        indexHtmlPath = join(normPath, 'src', 'index.html');
      } else {
        const isGodot = existsSync(join(normPath, 'project.godot'));
        const projName = basename(normPath);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ContextForge — ${projName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 2rem; max-width: 500px; text-align: center; }
    h1 { font-size: 1.25rem; color: #58a6ff; margin: 0 0 0.75rem 0; }
    p { font-size: 0.85rem; color: #8b949e; line-height: 1.5; margin: 0.5rem 0; }
    code { background: #21262d; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 2.2rem; margin-bottom: 0.5rem;">🎮</div>
    <h1>${isGodot ? 'Godot Engine Project Detected' : 'No Web Entry Point Found'}</h1>
    <p>
      ${isGodot
        ? `<strong>${projName}</strong> is a native Godot project. It runs natively through the Godot Engine executable (click the Play button in the top toolbar to launch it). Live 3D browser mirroring (?cf=1) is designed for Three.js web games.`
        : `Could not locate an <code>index.html</code> in <code>${projName}</code>.`}
    </p>
  </div>
</body>
</html>`);
      }
    }

    try {
      let html = readFileSync(indexHtmlPath, 'utf-8');
      const hasNodeModulesThree = existsSync(join(normPath, 'node_modules', 'three', 'build', 'three.module.js'));
      const hasImportMap = html.includes('type="importmap"');

      if (hasNodeModulesThree && !hasImportMap) {
        const importMap = `
  <script type="importmap">
  {
    "imports": {
      "three": "/node_modules/three/build/three.module.js",
      "three/addons/": "/node_modules/three/examples/jsm/",
      "three/examples/jsm/": "/node_modules/three/examples/jsm/"
    }
  }
  </script>`;
        if (html.includes('</head>')) {
          html = html.replace('</head>', `${importMap}\n</head>`);
        } else {
          html = importMap + '\n' + html;
        }
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch (_) {
      next();
    }
  });

  // Static file serving from project root
  app.use(express.static(normPath, { dotfiles: 'allow' }));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/cf' });

  const serverEntry = {
    port,
    url: `http://localhost:${port}/`,
    wsUrl: `ws://localhost:${port}/cf`,
    server,
    app,
    wss,
    watcher: null,
    gameWs: null,
    editorWsSet: new Set(),
    lastSnapshot: null,
    projectPath: normPath
  };

  // --------------------------------------------------------------------------
  // WebSocket Handling
  // --------------------------------------------------------------------------
  wss.on('connection', (ws, req) => {
    const isEditor = req.url && req.url.includes('role=editor');

    if (isEditor) {
      serverEntry.editorWsSet.add(ws);
      // Immediately notify editor about current game connection state
      ws.send(
        JSON.stringify({
          version: 1,
          type: 'status',
          connected: Boolean(serverEntry.gameWs && serverEntry.gameWs.readyState === WebSocket.OPEN)
        })
      );

      // If we have a cached snapshot from the active game, forward it to the new editor
      if (serverEntry.lastSnapshot) {
        ws.send(JSON.stringify(serverEntry.lastSnapshot));
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          // Forward transform or mode commands from editor to active game
          if (serverEntry.gameWs && serverEntry.gameWs.readyState === WebSocket.OPEN) {
            serverEntry.gameWs.send(JSON.stringify(msg));
          }
        } catch (_) {}
      });

      ws.on('close', () => {
        serverEntry.editorWsSet.delete(ws);
      });
      return;
    }

    // Game Client Connection
    // Rule: "Only one game session at a time"
    if (serverEntry.gameWs && serverEntry.gameWs !== ws && serverEntry.gameWs.readyState === WebSocket.OPEN) {
      serverEntry.gameWs.close(1000, 'Replaced by newer game session');
    }
    serverEntry.gameWs = ws;

    // Notify all editors that game is connected
    const statusMsg = JSON.stringify({ version: 1, type: 'status', connected: true });
    for (const editor of serverEntry.editorWsSet) {
      if (editor.readyState === WebSocket.OPEN) editor.send(statusMsg);
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'snapshot') {
          serverEntry.lastSnapshot = msg;
        }
        // Broadcast to all editors
        const str = JSON.stringify(msg);
        for (const editor of serverEntry.editorWsSet) {
          if (editor.readyState === WebSocket.OPEN) editor.send(str);
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      if (serverEntry.gameWs === ws) {
        serverEntry.gameWs = null;
        const discMsg = JSON.stringify({ version: 1, type: 'status', connected: false });
        for (const editor of serverEntry.editorWsSet) {
          if (editor.readyState === WebSocket.OPEN) editor.send(discMsg);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // File Watcher
  // "Watch the project folder and send reload to the game tab when files change."
  // --------------------------------------------------------------------------
  let reloadDebounceTimer = null;
  let modelDebounceTimer = null;
  const MODEL_RE = /\.(glb|gltf)$/i;
  try {
    serverEntry.watcher = watch(normPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const fn = filename.replace(/\\/g, '/');
      // Ignore git, node_modules, and layout files
      if (
        fn.includes('.git/') ||
        fn.includes('node_modules/') ||
        fn.includes('contextforge/layout.json') ||
        fn.endsWith('.tmp') ||
        fn.endsWith('.bak')
      ) {
        return;
      }

      // A model file change is a targeted reload, not a page reload: the game
      // and the editor swap the model in place, keeping transform, animation
      // state and selection. Debounced 500 ms so a multi-file export settles.
      if (MODEL_RE.test(fn)) {
        const relPath = fn.replace(/\\/g, '/');
        if (modelDebounceTimer) clearTimeout(modelDebounceTimer);
        modelDebounceTimer = setTimeout(() => {
          const abs = join(normPath, relPath);
          let version = Date.now();
          try { version = statSync(abs).mtimeMs; } catch (_) { /* deleted file */ }
          const msg = JSON.stringify({ version: 1, type: 'model_changed', path: relPath, mtime: version });
          if (serverEntry.gameWs && serverEntry.gameWs.readyState === WebSocket.OPEN) {
            serverEntry.gameWs.send(msg);
          }
          for (const editor of serverEntry.editorWsSet) {
            if (editor.readyState === WebSocket.OPEN) editor.send(msg);
          }
        }, 500);
        return;
      }

      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        if (serverEntry.gameWs && serverEntry.gameWs.readyState === WebSocket.OPEN) {
          serverEntry.gameWs.send(JSON.stringify({ version: 1, type: 'reload' }));
        }
      }, 200);
    });
  } catch (err) {
    console.warn('[GameServer] File watch unavailable:', err.message);
  }

  await new Promise((res, rej) => {
    server.listen(port, '127.0.0.1', () => res());
    server.on('error', rej);
  });

  activeProjectServers.set(normPath, serverEntry);

  return {
    port,
    url: serverEntry.url,
    wsUrl: serverEntry.wsUrl,
    alreadyRunning: false
  };
}

function matchesPattern(str, pattern) {
  if (!str || !pattern) return false;
  if (pattern === str) return true;
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return regex.test(str);
  }
  return false;
}

function isDrivenId(id, drivenList = []) {
  if (!id || !Array.isArray(drivenList)) return false;
  const segments = id.split('/');
  const lastName = segments[segments.length - 1];
  return drivenList.some((pat) => matchesPattern(id, pat) || matchesPattern(lastName, pat));
}

/**
 * Writes layout.json atomically with a .bak copy.
 */
export async function saveLayout(projectPath, layout) {
  const normPath = normalizeProjectPath(projectPath);
  const cfDir = join(normPath, 'contextforge');
  if (!existsSync(cfDir)) {
    await fs.mkdir(cfDir, { recursive: true });
  }

  // Load config to check driven IDs: never save position or rotation for driven objects
  let config = { drivenIds: ['Kart_Player', 'Kart_AI_*'] };
  try {
    const cfgPath = join(cfDir, 'config.json');
    if (existsSync(cfgPath)) {
      config = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
    }
  } catch (_) {}

  if (layout && layout.objects) {
    for (const [id, data] of Object.entries(layout.objects)) {
      if (isDrivenId(id, config.drivenIds)) {
        delete data.position;
        delete data.rotation;
      }
    }
  }

  const targetPath = join(cfDir, 'layout.json');
  const tmpPath = join(cfDir, 'layout.json.tmp');
  const bakPath = join(cfDir, 'layout.json.bak');

  if (existsSync(targetPath)) {
    await fs.copyFile(targetPath, bakPath);
  }

  const content = JSON.stringify(layout, null, 2);
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, targetPath);

  // Broadcast to game client if active
  const serverEntry = activeProjectServers.get(normPath);
  if (serverEntry && serverEntry.gameWs && serverEntry.gameWs.readyState === WebSocket.OPEN) {
    serverEntry.gameWs.send(JSON.stringify({ version: 1, type: 'apply_layout', layout }));
  }

  return { success: true };
}

/**
 * Maximum size for an imported model file (50 MB).
 */
export const MAX_MODEL_BYTES = 50 * 1024 * 1024;

/**
 * Copies an uploaded model into <project>/assets/models/.
 *
 * Keeps the original file name; if a file with that name already exists,
 * appends -2, -3, ... before the extension. Returns the project-relative path.
 *
 * @param {string} projectPath absolute project root
 * @param {string} sourcePath  absolute path of the file to import
 * @param {string} fileName    original file name (used for the stored name)
 */
export async function importModelFile(projectPath, sourcePath, fileName) {
  const normPath = normalizeProjectPath(projectPath);
  const ext = extname(fileName || sourcePath || '').toLowerCase();
  if (ext !== '.glb' && ext !== '.gltf') {
    const err = new Error(`Unsupported model format "${ext || 'unknown'}". Only .glb and .gltf are supported.`);
    err.statusCode = 400;
    throw err;
  }

  const stat = await fs.stat(sourcePath);
  if (stat.size > MAX_MODEL_BYTES) {
    const err = new Error(
      `Model is ${(stat.size / (1024 * 1024)).toFixed(1)} MB, which exceeds the 50 MB limit. ` +
      `Please use a smaller .glb or optimise the mesh first.`
    );
    err.statusCode = 413;
    throw err;
  }

  const modelsDir = join(normPath, 'assets', 'models');
  await fs.mkdir(modelsDir, { recursive: true });

  const base = extname(fileName || sourcePath) ? fileName.slice(0, fileName.length - extname(fileName).length) : 'model';
  const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '_') || 'model';

  let finalName = `${safeBase}${ext}`;
  let n = 2;
  while (existsSync(join(modelsDir, finalName))) {
    finalName = `${safeBase}-${n}${ext}`;
    n++;
  }

  const target = join(modelsDir, finalName);
  await fs.copyFile(sourcePath, target);

  return {
    success: true,
    path: `assets/models/${finalName}`,
    absolutePath: target,
    bytes: stat.size
  };
}

/**
 * Loads layout.json from <project>/contextforge/layout.json.
 */
export async function loadLayout(projectPath) {
  const normPath = normalizeProjectPath(projectPath);
  const targetPath = join(normPath, 'contextforge', 'layout.json');
  if (existsSync(targetPath)) {
    try {
      const data = await fs.readFile(targetPath, 'utf-8');
      return JSON.parse(data);
    } catch (_) {}
  }
  return { version: 1, objects: {} };
}

/**
 * Loads config.json from <project>/contextforge/config.json.
 */
export async function loadConfig(projectPath) {
  const normPath = normalizeProjectPath(projectPath);
  const targetPath = join(normPath, 'contextforge', 'config.json');
  if (existsSync(targetPath)) {
    try {
      const data = await fs.readFile(targetPath, 'utf-8');
      return JSON.parse(data);
    } catch (_) {}
  }
  return { drivenIds: ['Kart_Player', 'Kart_AI_*'] };
}

/**
 * Writes config.json to <project>/contextforge/config.json.
 */
export async function saveConfig(projectPath, config) {
  const normPath = normalizeProjectPath(projectPath);
  const cfDir = join(normPath, 'contextforge');
  if (!existsSync(cfDir)) {
    await fs.mkdir(cfDir, { recursive: true });
  }
  const targetPath = join(cfDir, 'config.json');
  const tmpPath = join(cfDir, 'config.json.tmp');
  const content = JSON.stringify(config, null, 2);
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, targetPath);

  // Broadcast to game client if active
  const serverEntry = activeProjectServers.get(normPath);
  if (serverEntry && serverEntry.gameWs && serverEntry.gameWs.readyState === WebSocket.OPEN) {
    serverEntry.gameWs.send(JSON.stringify({ version: 1, type: 'set_config', config }));
  }

  return { success: true, config };
}

/**
 * Detects if installContextForge is present in target project main.js and computes diff.
 */
export function checkHookInstallation(projectPath) {
  const normPath = normalizeProjectPath(projectPath);
  const candidateFiles = [
    join(normPath, 'src', 'main.js'),
    join(normPath, 'main.js'),
    join(normPath, 'src', 'index.js'),
    join(normPath, 'index.js')
  ];

  let targetFile = null;
  for (const f of candidateFiles) {
    if (existsSync(f)) {
      targetFile = f;
      break;
    }
  }

  if (!targetFile) {
    return { installed: false, error: 'No main.js or index.js found in project' };
  }

  const code = readFileSync(targetFile, 'utf-8');
  const installed = code.includes('installContextForge');
  if (installed) {
    return { installed: true, targetFile: relative(normPath, targetFile), code };
  }

  // Generate proposed diff
  const relPath = relative(normPath, targetFile).replace(/\\/g, '/');
  const runtimeImportPath = relPath.startsWith('src/') ? '../contextforge/runtime.js' : './contextforge/runtime.js';

  let modified = code;
  // 1. Add import statement
  const importLine = `import { installContextForge } from '${runtimeImportPath}';\n`;
  if (!modified.includes('installContextForge')) {
    modified = importLine + modified;
  }

  // 2. Add install call before game loop
  const hookCall = `
    // ContextForge Modeling Runtime Hook
    installContextForge({
      THREE,
      scene: this.scene,
      getCamera: () => (this.sceneManager ? this.sceneManager.camera : this.camera),
      renderer: (this.sceneManager ? this.sceneManager.renderer : this.renderer),
      GLTFLoader: null
    });
`;

  if (modified.includes('this.animate = this.animate.bind(this);')) {
    modified = modified.replace('this.animate = this.animate.bind(this);', `${hookCall}    this.animate = this.animate.bind(this);`);
  } else if (modified.includes('requestAnimationFrame(')) {
    const idx = modified.indexOf('requestAnimationFrame(');
    const lineStart = modified.lastIndexOf('\n', idx);
    modified = modified.slice(0, lineStart + 1) + hookCall + modified.slice(lineStart + 1);
  } else {
    modified += `\n${hookCall}\n`;
  }

  const diff = `--- ${relPath} (original)\n+++ ${relPath} (with ContextForge hook)\n+ ${importLine.trim()}\n+ installContextForge({ THREE, scene: this.scene, getCamera: () => ... });`;

  return {
    installed: false,
    targetFile: relPath,
    diff,
    originalCode: code,
    proposedCode: modified
  };
}

/**
 * Applies the hook to target file and copies runtime.js.
 */
export async function installHook(projectPath) {
  const normPath = normalizeProjectPath(projectPath);
  await ensureRuntimeCopied(normPath);

  const check = checkHookInstallation(normPath);
  if (check.installed) {
    return { success: true, alreadyInstalled: true, targetFile: check.targetFile };
  }
  if (!check.proposedCode) {
    throw new Error(check.error || 'Failed to determine hook location');
  }

  const fullPath = join(normPath, check.targetFile);
  await fs.writeFile(fullPath, check.proposedCode, 'utf-8');
  return { success: true, targetFile: check.targetFile };
}

/**
 * Stop running project server if active.
 */
export function stopProjectGameServer(projectPath) {
  const normPath = normalizeProjectPath(projectPath);
  const entry = activeProjectServers.get(normPath);
  if (!entry) return { stopped: false };

  try {
    if (entry.watcher) entry.watcher.close();
  } catch (_) {}

  try {
    if (entry.gameWs) entry.gameWs.close();
  } catch (_) {}

  try {
    for (const ed of entry.editorWsSet) ed.close();
  } catch (_) {}

  try {
    entry.server.close();
  } catch (_) {}

  activeProjectServers.delete(normPath);
  return { stopped: true };
}

/**
 * Attaches a /cf WebSocket server to ContextForge's main HTTP server (port 3000)
 * so that any game tab opened on dev servers (e.g. Vite on 5173) can also connect.
 */
export const mainEditorWsSet = new Set();
export let mainGameWs = null;
export let mainLastSnapshot = null;

export function setupMainServerWebSocket(httpServer) {
  if (!httpServer) return null;
  const wss = new WebSocketServer({ server: httpServer, path: '/cf' });

  wss.on('connection', (ws, req) => {
    const isEditor = req.url && req.url.includes('role=editor');

    if (isEditor) {
      mainEditorWsSet.add(ws);
      ws.send(
        JSON.stringify({
          version: 1,
          type: 'status',
          connected: Boolean(mainGameWs && mainGameWs.readyState === WebSocket.OPEN)
        })
      );
      if (mainLastSnapshot) {
        ws.send(JSON.stringify(mainLastSnapshot));
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (mainGameWs && mainGameWs.readyState === WebSocket.OPEN) {
            mainGameWs.send(JSON.stringify(msg));
          }
        } catch (_) {}
      });

      ws.on('close', () => {
        mainEditorWsSet.delete(ws);
      });
      return;
    }

    // Game Client
    if (mainGameWs && mainGameWs !== ws && mainGameWs.readyState === WebSocket.OPEN) {
      mainGameWs.close(1000, 'Replaced by newer game session');
    }
    mainGameWs = ws;

    const statusMsg = JSON.stringify({ version: 1, type: 'status', connected: true });
    for (const editor of mainEditorWsSet) {
      if (editor.readyState === WebSocket.OPEN) editor.send(statusMsg);
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'snapshot') {
          mainLastSnapshot = msg;
        }
        const str = JSON.stringify(msg);
        for (const editor of mainEditorWsSet) {
          if (editor.readyState === WebSocket.OPEN) editor.send(str);
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      if (mainGameWs === ws) {
        mainGameWs = null;
        const discMsg = JSON.stringify({ version: 1, type: 'status', connected: false });
        for (const editor of mainEditorWsSet) {
          if (editor.readyState === WebSocket.OPEN) editor.send(discMsg);
        }
      }
    });
  });

  return wss;
}

