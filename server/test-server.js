/**
 * server/test-server.js — shared helper for tests that need a live server.
 *
 * Starts the real ContextForge app on a free OS-assigned port so the suite
 * never depends on something already listening on :3000. Returns the base URL
 * plus a close() that shuts it back down.
 *
 * Usage:
 *   import { startTestServer } from './test-server.js';
 *   const { BASE_URL, close } = await startTestServer();
 *   ...
 *   await close();
 *
 * If a server is ALREADY running on CF_TEST_PORT (or :3000 when
 * CF_REUSE_SERVER=1), the caller can reuse it instead of starting another.
 */

import { app } from './index.js';

/**
 * @returns {Promise<{ BASE_URL: string, server: import('http').Server, close: () => Promise<void> }>}
 */
export async function startTestServer() {
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const port = server.address().port;
  return {
    BASE_URL: `http://127.0.0.1:${port}`,
    port,
    server,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
  };
}
