import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * In-memory buffer of console lines per project path.
 * Map<string, Array<{ id: number, text: string, isError: boolean, timestamp: string }>>
 */
export const projectConsoleLogs = new Map();
let logCounter = 1;

/**
 * Normalizes project path key.
 */
export function normalizeProjectPath(p) {
  if (!p) return '';
  let cleaned = String(p).trim();
  if ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"'))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return resolve(cleaned).replace(/\\/g, '/');
}

/**
 * Checks if a string line indicates an error.
 */
export function isErrorLine(line) {
  if (!line || typeof line !== 'string') return false;
  return /\b(?:SCRIPT ERROR|Parse Error|Parser Error|ERROR|Error|\w+Error|Failed to load script|exception|fatal|could not resolve|warning treated as error|Uncaught|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|InternalError|BROWSER ERROR|CONSOLE ERROR)\b/i.test(line) ||
    /^\s*at:\s*/i.test(line) ||
    /^\s*at\s+[\w$.<>]+\s+\(/i.test(line) ||
    /^\s*at\s+(?:http|file|\/|[a-zA-Z]:)/i.test(line);
}

/**
 * Record a chunk of console output (stdout or stderr).
 */
export function recordConsoleLog(projectPath, text, isError = false) {
  if (!projectPath || !text) return;
  const norm = normalizeProjectPath(projectPath);
  if (!projectConsoleLogs.has(norm)) {
    projectConsoleLogs.set(norm, []);
  }
  const logs = projectConsoleLogs.get(norm);
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const detectedError = isError || isErrorLine(line);
    logs.push({
      id: logCounter++,
      text: line,
      isError: !!detectedError,
      timestamp: new Date().toLocaleTimeString()
    });
  }
  if (logs.length > 1000) {
    logs.splice(0, logs.length - 1000);
  }
}

/**
 * Clear console logs for a project.
 */
export function clearConsoleLogs(projectPath) {
  if (!projectPath) return;
  const norm = normalizeProjectPath(projectPath);
  projectConsoleLogs.set(norm, []);
}

/**
 * Get logs for a project.
 */
export function getConsoleLogs(projectPath) {
  if (!projectPath) return { logs: [], redLogs: [], totalCount: 0, errorCount: 0 };
  const norm = normalizeProjectPath(projectPath);
  const logs = projectConsoleLogs.get(norm) || [];
  const redLogs = logs.filter(l => l.isError);
  return {
    logs,
    redLogs,
    totalCount: logs.length,
    errorCount: redLogs.length
  };
}

/**
 * Run headless Godot check on project to capture fresh GDScript compile/syntax errors.
 */
export function runGodotCheck(projectPath) {
  if (!projectPath) return;
  const norm = normalizeProjectPath(projectPath);
  if (!existsSync(norm) || !existsSync(join(norm, 'project.godot'))) return;

  let godotBin = null;
  try {
    const whichRes = execSync('which godot 2>/dev/null || which godot4 2>/dev/null || which /home/aymen/.local/bin/godot 2>/dev/null', {
      encoding: 'utf-8'
    }).trim();
    if (whichRes) godotBin = whichRes.split('\n')[0];
  } catch (_) {}

  if (!godotBin) return;

  try {
    const output = execSync(`timeout 2s "${godotBin}" --headless --quit-after 1 --path "${norm}" 2>&1 || true`, {
      encoding: 'utf-8',
      timeout: 3000
    });
    if (output) {
      recordConsoleLog(norm, output);
    }
  } catch (err) {
    if (err.stdout) recordConsoleLog(norm, err.stdout.toString());
    if (err.stderr) recordConsoleLog(norm, err.stderr.toString(), true);
  }
}

/**
 * Run syntax and static checks on JS files in project to capture syntax errors.
 */
export function runJsCheck(projectPath) {
  if (!projectPath) return;
  const norm = normalizeProjectPath(projectPath);
  if (!existsSync(norm)) return;

  const jsFiles = [];
  function scan(dir, depth = 0) {
    if (depth > 4) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (/\.(m?js|ts)$/.test(entry.name)) {
          jsFiles.push(full);
        }
      }
    } catch (_) {}
  }
  scan(norm);

  for (const file of jsFiles) {
    try {
      execSync(`node --check "${file}" 2>&1`, { timeout: 1500, encoding: 'utf-8' });
    } catch (err) {
      const output = (err.stdout || err.stderr || err.message).toString();
      const rel = relative(norm, file);
      const cleanErr = output.split('\n').filter(l => !l.includes('at compileSourceTextModule') && !l.includes('at node:internal')).join('\n').trim();
      const formatted = `SCRIPT ERROR: Syntax Error in ${rel}\n${cleanErr}\n          at: (${rel})`;
      recordConsoleLog(norm, formatted, true);
    }
  }
}

/**
 * Ensures HTML entrypoint files include the ContextForge diagnostics bridge.
 */
export function ensureDiagnosticsBridge(projectPath) {
  if (!projectPath) return;
  const norm = normalizeProjectPath(projectPath);
  if (!existsSync(norm)) return;

  const htmlFiles = ['index.html', 'main.html', 'game.html'];
  for (const name of htmlFiles) {
    const p = join(norm, name);
    if (existsSync(p)) {
      try {
        let content = readFileSync(p, 'utf-8');
        if (!content.includes('contextforge-bridge.js')) {
          const bridgeTag = `\n    <!-- ContextForge Diagnostics Bridge -->\n    <script src="http://localhost:3000/contextforge-bridge.js" data-project="${norm}"></script>\n`;
          if (content.includes('</head>')) {
            content = content.replace('</head>', `${bridgeTag}</head>`);
          } else if (content.includes('<head>')) {
            content = content.replace('<head>', `<head>${bridgeTag}`);
          } else if (content.includes('<body>')) {
            content = content.replace('<body>', `<body>${bridgeTag}`);
          } else {
            content = bridgeTag + content;
          }
          writeFileSync(p, content, 'utf-8');
          recordAppLog(`[ContextForge Bridge] Injected diagnostics bridge into ${name}`, 'info');
        }
      } catch (_) {}
    }
  }
}

/**
 * ContextForge Application / Server logs buffer
 */
export const appConsoleLogs = [];
let appLogCounter = 1;

export function recordAppLog(message, level = 'info') {
  if (!message) return;
  const line = String(message).trim();
  if (!line) return;
  appConsoleLogs.push({
    id: appLogCounter++,
    text: line,
    level, // 'info', 'warn', 'error', 'success'
    timestamp: new Date().toLocaleTimeString()
  });
  if (appConsoleLogs.length > 500) {
    appConsoleLogs.splice(0, appConsoleLogs.length - 500);
  }
}

export function getAppLogs() {
  return [...appConsoleLogs];
}

export function clearAppLogs() {
  appConsoleLogs.length = 0;
}
