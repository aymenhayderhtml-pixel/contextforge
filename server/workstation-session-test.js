/**
 * server/workstation-session-test.js
 * Comprehensive tests for the 3-Pane Workstation, Sidecar Session Manager, and Verification Comparator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

import {
  createSession,
  getSession,
  updateSession,
  addSessionIteration,
  listSessions,
  loadProjectSessions,
  getSidecarPath
} from './debug-session-manager.js';

import {
  extractErrorFingerprints,
  compareVerification
} from './verification-comparator.js';

// Helper for test HTTP requests
function makeRequest(method, path, body = null, port = 3000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          resolve({ status: res.statusCode, data: parsed });
        } catch (_) {
          resolve({ status: res.statusCode, raw: responseBody });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('Verification Comparator: fingerprint extraction and error comparison', async (t) => {
  await t.test('extractErrorFingerprints extracts normalized errors and strips volatile lines', () => {
    const log = `
      [INFO] Server started
      Uncaught TypeError: Cannot read properties of undefined at src/player.js:42:15
      Normal log line
      Error: Failed to fetch data at /home/user/app/api.js:10:5
    `;
    const fps = extractErrorFingerprints(log);
    assert.strictEqual(fps.length, 2);
    assert.ok(fps[0].includes('Cannot read properties of undefined'));
    assert.ok(fps[1].includes('Failed to fetch data'));
  });

  await t.test('compareVerification handles ERROR_RESOLVED', () => {
    const res = compareVerification({
      previousError: 'TypeError: Cannot read properties of undefined (reading jump)',
      currentError: '',
      syntaxValid: true
    });
    assert.strictEqual(res.comparison, 'ERROR_RESOLVED');
    assert.strictEqual(res.errorCountDelta, -1);
    assert.ok(res.message.includes('Error resolved'));
  });

  await t.test('compareVerification handles SAME_ERROR', () => {
    const res = compareVerification({
      previousError: 'TypeError: Cannot read properties of undefined (reading jump)',
      currentError: 'TypeError: Cannot read properties of undefined (reading jump)',
      syntaxValid: true
    });
    assert.strictEqual(res.comparison, 'SAME_ERROR');
    assert.strictEqual(res.errorCountDelta, 0);
  });

  await t.test('compareVerification handles NEW_ERROR when syntax error occurs', () => {
    const res = compareVerification({
      previousError: '',
      currentError: '',
      syntaxValid: false,
      syntaxError: { file: 'src/main.js', message: 'Unexpected token }' }
    });
    assert.strictEqual(res.comparison, 'NEW_ERROR');
    assert.ok(res.message.includes('Syntax error introduced in src/main.js'));
  });

  await t.test('compareVerification handles NEW_ERROR when different runtime error appears', () => {
    const res = compareVerification({
      previousError: 'TypeError: player is undefined',
      currentError: 'ReferenceError: enemy is not defined',
      syntaxValid: true
    });
    assert.strictEqual(res.comparison, 'NEW_ERROR');
    assert.ok(res.introducedErrors.length > 0);
  });

  await t.test('compareVerification handles FEWER_ERRORS', () => {
    const prev = 'Error: Error A in line 1\nError: Error B in line 2';
    const curr = 'Error: Error A in line 1';
    const res = compareVerification({
      previousError: prev,
      currentError: curr,
      syntaxValid: true
    });
    assert.strictEqual(res.comparison, 'FEWER_ERRORS');
    assert.strictEqual(res.errorCountDelta, -1);
  });

  await t.test('compareVerification handles NO_RUNTIME_DATA', () => {
    const res = compareVerification({
      previousError: '',
      currentError: '',
      syntaxValid: true
    });
    assert.strictEqual(res.comparison, 'NO_RUNTIME_DATA');
  });
});

test('Sidecar Session Manager: persistence and multi-turn iterations', async (t) => {
  const tmpProject = join(tmpdir(), `cf_test_session_${Date.now()}`);
  mkdirSync(tmpProject, { recursive: true });

  try {
    await t.test('createSession writes to .contextforge.sessions.json', () => {
      const sess = createSession(tmpProject, {
        title: 'Fix Jump Bug',
        category: 'runtime_error',
        strategy: 'balanced',
        problem: { description: 'Player jumps backwards' }
      });

      assert.ok(sess.id.startsWith('sess_'));
      assert.strictEqual(sess.title, 'Fix Jump Bug');
      assert.strictEqual(sess.status, 'active');
      assert.strictEqual(sess.iterations.length, 1);

      const sidecarPath = getSidecarPath(tmpProject);
      assert.ok(existsSync(sidecarPath));

      const raw = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
      assert.strictEqual(raw.activeSessionId, sess.id);
      assert.strictEqual(raw.sessions.length, 1);
    });

    await t.test('addSessionIteration appends subsequent iterations', () => {
      const sessions = listSessions(tmpProject);
      const sessId = sessions[0].id;

      const updated = addSessionIteration(tmpProject, sessId, {
        iterationIndex: 2,
        problem: { description: 'Refine jump velocity' },
        prompt: '### CONTEXT...',
        patchApplied: { patchId: 'PATCH-001', count: 1, files: ['src/player.js'] },
        verification: { success: true, syntaxValid: true }
      });

      assert.ok(updated);
      assert.strictEqual(updated.iterations.length, 2);
      assert.strictEqual(updated.iterations[1].iterationIndex, 2);
      assert.strictEqual(updated.iterations[1].patchApplied.patchId, 'PATCH-001');
    });

    await t.test('updateSession updates status to resolved', () => {
      const sessions = listSessions(tmpProject);
      const sessId = sessions[0].id;

      const updated = updateSession(tmpProject, sessId, { status: 'resolved' });
      assert.strictEqual(updated.status, 'resolved');

      const fetched = getSession(tmpProject, sessId);
      assert.strictEqual(fetched.status, 'resolved');
    });

  } finally {
    if (existsSync(tmpProject)) {
      rmSync(tmpProject, { recursive: true, force: true });
    }
  }
});

test('HTTP Routes: /debug-sessions and /compare-verification', async (t) => {
  const tmpProject = join(tmpdir(), `cf_http_session_${Date.now()}`);
  mkdirSync(tmpProject, { recursive: true });

  try {
    await t.test('POST /debug-sessions creates session', async () => {
      const res = await makeRequest('POST', '/debug-sessions', {
        projectPath: tmpProject,
        title: 'Collision bug',
        category: 'logic_bug'
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.success);
      assert.strictEqual(res.data.session.title, 'Collision bug');
    });

    await t.test('GET /debug-sessions lists sessions', async () => {
      const res = await makeRequest('GET', `/debug-sessions?projectPath=${encodeURIComponent(tmpProject)}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.success);
      assert.strictEqual(res.data.sessions.length, 1);
    });

    await t.test('POST /compare-verification endpoint compares states', async () => {
      const res = await makeRequest('POST', '/compare-verification', {
        previousError: 'Uncaught TypeError in player.js:40',
        currentError: '',
        syntaxValid: true
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.success);
      assert.strictEqual(res.data.comparison, 'ERROR_RESOLVED');
    });

  } finally {
    if (existsSync(tmpProject)) {
      rmSync(tmpProject, { recursive: true, force: true });
    }
  }
});

test('Workstation Layout & Client UI Contracts', async (t) => {
  const indexPath = join(process.cwd(), 'public/index.html');
  const indexHtml = readFileSync(indexPath, 'utf-8');

  await t.test('index.html contains view-mode-toggle and workstation layout elements', () => {
    assert.ok(indexHtml.includes('id="view-mode-toggle"'), 'Should have view-mode-toggle');
    assert.ok(indexHtml.includes('id="btn-view-graph"'), 'Should have btn-view-graph');
    assert.ok(indexHtml.includes('id="btn-view-workstation"'), 'Should have btn-view-workstation');
    assert.ok(indexHtml.includes('id="workstation-container"'), 'Should have workstation-container');
    assert.ok(indexHtml.includes('id="ws-pane-problem"'), 'Should have ws-pane-problem');
    assert.ok(indexHtml.includes('id="ws-pane-workspace"'), 'Should have ws-pane-workspace');
    assert.ok(indexHtml.includes('id="ws-pane-inspector"'), 'Should have ws-pane-inspector');
  });

  await t.test('workstation.css exists with 3-pane grid styling', () => {
    const cssPath = join(process.cwd(), 'public/css/workstation.css');
    assert.ok(existsSync(cssPath));
    const css = readFileSync(cssPath, 'utf-8');
    assert.ok(css.includes('workstation-container'));
    assert.ok(css.includes('grid-template-columns'));
  });

  await t.test('all workstation client modules exist and are non-empty', () => {
    const modules = [
      'public/js/workstation/problem-pane.js',
      'public/js/workstation/workspace-pane.js',
      'public/js/workstation/inspector-pane.js',
      'public/js/workstation/session-stepper.js',
      'public/js/workstation/workstation.js'
    ];
    for (const m of modules) {
      const full = join(process.cwd(), m);
      assert.ok(existsSync(full), `${m} must exist`);
      const content = readFileSync(full, 'utf-8');
      assert.ok(content.length > 100, `${m} must not be empty`);
    }
  });
});
