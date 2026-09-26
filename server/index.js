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

// CORS middleware allowing cross-origin requests from game tabs (Vite, Godot web exports, localhost ports)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '50mb' }));

// Serve frontend static files from /public
app.use(express.static(join(projectRoot, 'public')));

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
