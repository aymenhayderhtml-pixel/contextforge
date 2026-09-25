import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { recordConsoleLog } from './console-manager.js';

/**
 * Registry of managed dev servers.
 * Key: normalized project root path (string)
 * Value: { child: ChildProcess, url: string, pid: number, projectPath: string, startedAt: Date }
 */
export const activeServers = new Map();

/**
 * Normalizes project path key to consistent format.
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  if (!p) return '';
  return resolve(p).replace(/\\/g, '/');
}

/**
 * Checks if a given HTTP/HTTPS URL is reachable.
 * @param {string} targetUrl
 * @param {number} [timeoutMs=1000]
 * @returns {Promise<boolean>}
 */
export function isUrlReachable(targetUrl, timeoutMs = 1000) {
  return new Promise((resolveResult) => {
    try {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request(parsed, { method: 'HEAD', timeout: timeoutMs }, (res) => {
        resolveResult(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('timeout', () => {
        req.destroy();
        resolveResult(false);
      });
      req.on('error', () => {
        resolveResult(false);
      });
      req.end();
    } catch (_) {
      resolveResult(false);
    }
  });
}

/**
 * Polls targetUrl until it is reachable or maxWaitMs has elapsed.
 * @param {string} targetUrl
 * @param {number} [maxWaitMs=15000]
 * @param {number} [intervalMs=300]
 * @returns {Promise<boolean>}
 */
export async function waitForUrl(targetUrl, maxWaitMs = 15000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const reachable = await isUrlReachable(targetUrl, 600);
    if (reachable) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Safely kills a spawned dev server child process and its entire process tree.
 * @param {import('node:child_process').ChildProcess} child
 */
export function killDevServerProcess(child) {
  if (!child || !child.pid) return;
  const pid = child.pid;

  try {
    // Kill the whole process group
    process.kill(-pid, 'SIGTERM');
  } catch (_) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_) {}
  }

  // Double-check with pkill for sub-processes (like esbuild/vite)
  try {
    execSync(`pkill -TERM -P ${pid} 2>/dev/null || true`);
  } catch (_) {}

  // After 800ms, force kill if still lingering
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (_) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (_) {}
    }
    try {
      execSync(`pkill -KILL -P ${pid} 2>/dev/null || true`);
    } catch (_) {}
  }, 800);
}

/**
 * Set up dependencies (npm install if needed) and start the Vite/npm dev server.
 * Returns when the dev server is active and reachable via HTTP.
 *
 * @param {{ projectPath: string, port?: number }} options
 * @returns {Promise<{ success: boolean, url: string, pid: number, ranInstall: boolean, alreadyRunning?: boolean }>}
 */
export async function setupAndStartDevServer(options) {
  const { projectPath } = options || {};
  if (!projectPath) {
    throw new Error('Missing projectPath');
  }

  const normPath = normalizePath(projectPath);
  if (!existsSync(normPath)) {
    throw new Error(`Project directory does not exist: ${normPath}`);
  }

  const pkgJsonPath = join(normPath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`No package.json found in project: ${normPath}`);
  }

  // Check if an existing server is running for this path
  const existing = activeServers.get(normPath);
  if (existing && existing.child && !existing.child.killed) {
    const testUrl = existing.url || 'http://localhost:5173';
    const isAlive = await isUrlReachable(testUrl, 800);
    if (isAlive) {
      return {
        success: true,
        alreadyRunning: true,
        url: testUrl,
        pid: existing.child.pid,
        ranInstall: false
      };
    }
    // Clean up dead/stale instance
    killDevServerProcess(existing.child);
    activeServers.delete(normPath);
  }

  // 1. Check if node_modules exists; if not, automatically run npm install
  const nodeModulesPath = join(normPath, 'node_modules');
  let ranInstall = false;
  if (!existsSync(nodeModulesPath)) {
    try {
      execSync('npm install', {
        cwd: normPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
        encoding: 'utf-8'
      });
      ranInstall = true;
    } catch (err) {
      const errDetail = err.stderr ? err.stderr.toString() : err.message;
      throw new Error(`Automatic npm install failed: ${errDetail}`);
    }
  }

  // 2. Read package.json to determine script
  let cmd = 'npm';
  let args = ['run', 'dev'];
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const scripts = pkg.scripts || {};
    if (!scripts.dev && scripts.start) {
      args = ['start'];
    } else if (!scripts.dev && !scripts.start) {
      cmd = 'npx';
      args = ['vite'];
    }
  } catch (_) {}

  // 3. Spawn the dev server process
  const child = spawn(cmd, args, {
    cwd: normPath,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none', NO_COLOR: '1' }
  });

  const urlRegex = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+[\w/]*)/i;
  let detectedUrl = null;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    recordConsoleLog(normPath, text, false);
    const match = text.match(urlRegex);
    if (match && !detectedUrl) {
      detectedUrl = match[1].replace(/\/+$/, '');
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    recordConsoleLog(normPath, text, true);
    const match = text.match(urlRegex);
    if (match && !detectedUrl) {
      detectedUrl = match[1].replace(/\/+$/, '');
    }
  });

  child.on('exit', () => {
    activeServers.delete(normPath);
  });

  // 4. Poll until the server responds
  const startWait = Date.now();
  let readyUrl = null;

  while (Date.now() - startWait < 18000) {
    if (child.killed || child.exitCode !== null) {
      activeServers.delete(normPath);
      throw new Error('Dev server process exited prematurely before port was ready.');
    }

    const testTargets = [];
    if (detectedUrl) testTargets.push(detectedUrl);
    testTargets.push('http://localhost:5173', 'http://localhost:5174', 'http://localhost:3001');

    for (const target of testTargets) {
      const ok = await isUrlReachable(target, 500);
      if (ok) {
        readyUrl = target;
        break;
      }
    }

    if (readyUrl) break;
    await new Promise((r) => setTimeout(r, 350));
  }

  if (!readyUrl) {
    killDevServerProcess(child);
    activeServers.delete(normPath);
    throw new Error('Dev server started but port was not reachable within 18 seconds.');
  }

  activeServers.set(normPath, {
    child,
    url: readyUrl,
    pid: child.pid,
    projectPath: normPath,
    startedAt: new Date(),
    ranInstall
  });

  return {
    success: true,
    url: readyUrl,
    pid: child.pid,
    ranInstall
  };
}

/**
 * Stop running dev server for given project.
 * @param {string} projectPath
 * @returns {{ success: boolean, stopped: boolean, pid?: number, message?: string }}
 */
export function stopDevServer(projectPath) {
  if (!projectPath) {
    return { success: false, stopped: false, error: 'Missing projectPath' };
  }

  const normPath = normalizePath(projectPath);
  const entry = activeServers.get(normPath);

  if (!entry) {
    return { success: true, stopped: false, message: 'No dev server was running for this project.' };
  }

  killDevServerProcess(entry.child);
  activeServers.delete(normPath);

  return {
    success: true,
    stopped: true,
    pid: entry.pid,
    message: `Dev server (PID ${entry.pid}) stopped.`
  };
}

/**
 * Query current dev server status.
 * @param {string} projectPath
 * @returns {Promise<{ running: boolean, url: string|null, pid: number|null, projectPath: string }>}
 */
export async function getDevServerStatus(projectPath) {
  if (!projectPath) {
    return { running: false, url: null, pid: null, projectPath: '' };
  }
  const normPath = normalizePath(projectPath);
  const entry = activeServers.get(normPath);

  if (!entry || !entry.child || entry.child.killed) {
    activeServers.delete(normPath);
    return { running: false, url: null, pid: null, projectPath: normPath };
  }

  const isAlive = await isUrlReachable(entry.url || 'http://localhost:5173', 800);
  if (!isAlive) {
    return { running: false, url: entry.url, pid: entry.pid, projectPath: normPath, reachable: false };
  }

  return {
    running: true,
    url: entry.url,
    pid: entry.pid,
    projectPath: normPath
  };
}

/**
 * Terminate all running dev servers managed by this process.
 */
export function stopAllDevServers() {
  for (const [normPath, entry] of activeServers.entries()) {
    try {
      killDevServerProcess(entry.child);
    } catch (_) {}
  }
  activeServers.clear();
}

// Ensure cleanup on process exit
process.on('SIGINT', () => {
  stopAllDevServers();
});
process.on('SIGTERM', () => {
  stopAllDevServers();
});
process.on('exit', () => {
  stopAllDevServers();
});
