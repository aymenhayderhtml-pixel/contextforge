/**
 * server/index.js — ContextForge HTTP server.
 *
 * Serves /public as static files and mounts domain-partitioned API routes
 * defined in docs/ARCHITECTURE.md and docs/PROJECT_MAP.md.
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { recordAppLog } from './console-manager.js';
import { cleanAndResolvePath, resolveProjectPath } from './paths.js';

// Domain-partitioned Express routers
import extractRouter from './routes/extract.js';
import scaffoldRouter from './routes/scaffold.js';
import pasteRouter from './routes/paste.js';
import devserverRouter from './routes/devserver.js';
import filesRouter from './routes/files.js';
import clipboardRouter from './routes/clipboard.js';
import contextRouter from './routes/context.js';
import consoleRouter from './routes/console.js';
import historyRouter from './routes/history.js';
import sessionsRouter from './routes/sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const app = express();

// CORS and Security Middleware:
// Allows cross-origin telemetry from local dev servers (Vite, Godot web exports on localhost)
// but strictly blocks external websites from calling file-modifying endpoints.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isTelemetry = req.path === '/client-log';
  const isLocalhostOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);

  if (isTelemetry) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (isLocalhostOrigin) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  } else {
    res.header('Access-Control-Allow-Origin', 'null');
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') {
    if (!isTelemetry && !isLocalhostOrigin) {
      return res.status(403).send('Forbidden cross-origin preflight');
    }
    return res.sendStatus(204);
  }

  // Guard file-writing endpoints against cross-origin attacks from external web pages
  const MUTATION_PATHS = [
    '/save-file', '/add-from-clipboard', '/swap-asset', '/paste-back',
    '/scaffold', '/init-project', '/history/undo', '/history/redo',
    '/history/clear', '/lock', '/unlock'
  ];

  if (MUTATION_PATHS.includes(req.path) && origin && !isLocalhostOrigin) {
    return res.status(403).json({
      error: `Forbidden: Cross-origin requests from external origin "${origin}" are not permitted to modify local files.`
    });
  }

  next();
});

app.use(express.json({ limit: '50mb' }));

// Serve frontend static files from /public
app.use(express.static(join(projectRoot, 'public')));

// Optional snapshot synchronization endpoints for automated UI verification
let pendingSnapshotRes = [];
app.get('/hold-screenshot', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  pendingSnapshotRes.push(res);
  setTimeout(() => {
    if (!res.writableEnded) res.end('<!DOCTYPE html><html><body>timeout</body></html>');
  }, 8000);
});

app.all('/release-screenshot', (req, res) => {
  while (pendingSnapshotRes.length > 0) {
    const r = pendingSnapshotRes.shift();
    if (!r.writableEnded) r.end('<!DOCTYPE html><html><body>ready</body></html>');
  }
  res.json({ released: true });
});

// Mount API routers
app.use(extractRouter);
app.use(scaffoldRouter);
app.use(pasteRouter);
app.use(devserverRouter);
app.use(filesRouter);
app.use(clipboardRouter);
app.use(contextRouter);
app.use(consoleRouter);
app.use(historyRouter);
app.use(sessionsRouter);

// Export path helpers for backward compatibility
export { cleanAndResolvePath, resolveProjectPath };

recordAppLog('ContextForge server online at http://localhost:3000', 'success');
recordAppLog('Ready for Godot 4.x and JS/Three.js game engines', 'info');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ContextForge server running at http://localhost:${PORT}`);
});
