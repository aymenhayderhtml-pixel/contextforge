import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { recordConsoleLog, recordAppLog } from './console-manager.js';

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
/**
 * Returns true if the body or headers indicate a Chromium / DevTools remote debugging endpoint
 * rather than a game application.
 * @param {string} body
 * @returns {boolean}
 */
export function isDevToolsOrDebuggerResponse(body) {
  if (!body || typeof body !== 'string') return false;
  return (
    body.includes('Content shell remote debugging') ||
    body.includes('Inspectable WebContents') ||
    body.includes('devtoolsFrontendUrl') ||
    body.includes('webSocketDebuggerUrl') ||
    body.includes('/json/list')
  );
}

/**
 * Snapshots all TCP ports currently in LISTEN state on the system.
 * Cross-platform: queries ss -tln, falls back to netstat -an.
 * @returns {Set<number>}
 */
export function getSystemListeningPorts() {
  const ports = new Set();
  try {
    let output = '';
    try {
      output = execSync('ss -tln 2>/dev/null', { encoding: 'utf-8', timeout: 600 });
    } catch (_) {
      try {
        output = execSync('netstat -an 2>/dev/null', { encoding: 'utf-8', timeout: 600 });
      } catch (_) {}
    }
    for (const line of output.split('\n')) {
      if (!line.includes('LISTEN')) continue;
      const match = line.match(/:(\d+)\s+/);
      if (match) {
        const p = parseInt(match[1], 10);
        if (p > 0 && p <= 65535) {
          ports.add(p);
        }
      }
    }
  } catch (_) {}
  return ports;
}

/**
 * Checks if targetUrl is reachable and not a debugger/devtools endpoint.
 * @param {string} targetUrl
 * @param {number} [timeoutMs=1000]
 * @returns {Promise<boolean>}
 */
export function isUrlReachable(targetUrl, timeoutMs = 1000) {
  return new Promise((resolveResult) => {
    try {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        resolveResult(val);
      };

      const req = client.request(parsed, { method: 'GET', timeout: timeoutMs }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 500) {
          res.resume();
          return done(false);
        }

        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 2048) {
            req.destroy();
          }
        });
        res.on('end', () => {
          if (isDevToolsOrDebuggerResponse(body)) {
            done(false);
          } else {
            done(true);
          }
        });
        res.on('close', () => {
          if (isDevToolsOrDebuggerResponse(body)) {
            done(false);
          } else {
            done(true);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => {
        done(false);
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

  // Stop any dev servers running for other projects to prevent port collisions
  for (const [otherPath, entry] of activeServers.entries()) {
    if (otherPath !== normPath) {
      try {
        killDevServerProcess(entry.child);
      } catch (_) {}
      activeServers.delete(otherPath);
    }
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
    recordAppLog(`📦 Missing node_modules for ${basename(normPath)} — running automatic npm install...`, 'info');
    try {
      execSync('npm install', {
        cwd: normPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
        encoding: 'utf-8'
      });
      ranInstall = true;
      recordAppLog(`✓ Automatic npm install completed for ${basename(normPath)}`, 'success');
    } catch (err) {
      const errDetail = err.stderr ? err.stderr.toString() : err.message;
      recordAppLog(`❌ Automatic npm install failed: ${errDetail}`, 'error');
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

  // 3. Snapshot all listening ports currently on the system BEFORE spawning.
  // Sockets already listening before the dev server started can never be the newly launched dev server.
  const preExistingPorts = getSystemListeningPorts();
  const candidateUrls = ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:5176', 'http://localhost:3001'];
  for (const candidate of candidateUrls) {
    try {
      const port = parseInt(new URL(candidate).port, 10);
      if (await isUrlReachable(candidate, 200)) {
        preExistingPorts.add(port);
      }
    } catch (_) {}
  }

  // 4. Spawn the dev server process
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

  // 5. Poll until the server responds
  const startWait = Date.now();
  let readyUrl = null;

  while (Date.now() - startWait < 18000) {
    if (child.killed || child.exitCode !== null) {
      activeServers.delete(normPath);
      throw new Error('Dev server process exited prematurely before port was ready.');
    }

    // A. PRIMARY: Check if child stdout/stderr emitted its specific URL (e.g. Vite prints Local: http://localhost:PORT)
    if (detectedUrl) {
      const ok = await isUrlReachable(detectedUrl, 400);
      if (ok) {
        readyUrl = detectedUrl;
        break;
      }
    }

    const elapsed = Date.now() - startWait;

    // B. FALLBACK: Socket inspection (last resort after bounded grace period, e.g. 2000ms, for tools that don't print URL)
    if (!readyUrl && elapsed > 2000 && child.pid) {
      try {
        const pids = [child.pid];
        try {
          const pgrepOut = execSync(`pgrep -P ${child.pid} 2>/dev/null`, { encoding: 'utf-8', timeout: 300 });
          pgrepOut.split('\n').map(s => s.trim()).filter(Boolean).forEach(p => pids.push(p));
        } catch (_) {}
        const pidPattern = pids.join('|');
        const ssOut = execSync(`ss -tulpn 2>/dev/null | grep -E "pid=(${pidPattern})" || true`, { encoding: 'utf-8', timeout: 300 });

        // Find all listening ports matching the child process tree
        const portRegex = /(?:127\.0\.0\.1|0\.0\.0\.0|\*):(\d+)/g;
        let match;
        while ((match = portRegex.exec(ssOut)) !== null) {
          const port = parseInt(match[1], 10);
          // Crucial: Skip any port that was already listening BEFORE child was spawned!
          if (preExistingPorts.has(port)) {
            continue;
          }
          const inspectedUrl = `http://localhost:${port}`;
          const ok = await isUrlReachable(inspectedUrl, 400);
          if (ok) {
            readyUrl = inspectedUrl;
            break;
          }
        }
      } catch (_) {}
    }

    // C. SECONDARY FALLBACK: Test candidate URLs that were NOT pre-existing
    if (!readyUrl && elapsed > 2000) {
      const availableCandidates = candidateUrls.filter(u => {
        try {
          const p = parseInt(new URL(u).port, 10);
          return !preExistingPorts.has(p);
        } catch (_) {
          return false;
        }
      });
      for (const target of availableCandidates) {
        const ok = await isUrlReachable(target, 400);
        if (ok) {
          readyUrl = target;
          break;
        }
      }
    }

    if (readyUrl) break;
    await new Promise((r) => setTimeout(r, 250));
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
    return { running: false, url: null, pid: null, projectPath: '', hasPackageJson: false, hasNodeModules: false };
  }
  const normPath = normalizePath(projectPath);
  const pkgJsonPath = join(normPath, 'package.json');
  const hasPackageJson = existsSync(pkgJsonPath);
  const hasNodeModules = existsSync(join(normPath, 'node_modules'));

  const entry = activeServers.get(normPath);

  if (!entry || !entry.child || entry.child.killed) {
    activeServers.delete(normPath);
    return {
      running: false,
      url: null,
      pid: null,
      projectPath: normPath,
      hasPackageJson,
      hasNodeModules
    };
  }

  const isAlive = await isUrlReachable(entry.url || 'http://localhost:5173', 800);
  if (!isAlive) {
    return {
      running: false,
      url: entry.url,
      pid: entry.pid,
      projectPath: normPath,
      reachable: false,
      hasPackageJson,
      hasNodeModules
    };
  }

  return {
    running: true,
    url: entry.url,
    pid: entry.pid,
    projectPath: normPath,
    hasPackageJson,
    hasNodeModules
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
