/**
 * server/workstation-session-test.js
 * Comprehensive tests for the 3-Pane Workstation, Sidecar Session Manager, and Verification Comparator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
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

import { parseProjectProgress } from './project-init.js';

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

  await t.test('workspace-pane.js implements 1-click Undo Patch safety net on verification banner (T076)', () => {
    const wsPanePath = join(process.cwd(), 'public/js/workstation/workspace-pane.js');
    assert.ok(existsSync(wsPanePath));
    const content = readFileSync(wsPanePath, 'utf-8');
    assert.ok(content.includes('id="btn-ws-undo-patch"'), 'Should render Undo Patch button');
    assert.ok(content.includes('performUndo'), 'Should integrate performUndo from history engine');
    assert.ok(content.includes('v.undone'), 'Should handle undone state in verification banner');
  });

  await t.test('forceUnlock in detail-panel.js points to POST /unlock with { force: true } (T066)', () => {
    const detailPanelPath = join(process.cwd(), 'public/js/panel/detail-panel.js');
    assert.ok(existsSync(detailPanelPath));
    const content = readFileSync(detailPanelPath, 'utf-8');
    assert.ok(content.includes("fetch('/unlock'"), 'Should call /unlock');
    assert.ok(content.includes('force: true'), 'Should pass force: true');
  });

  await t.test('btn-add-node and btn-new-project are unhidden and wired in app.js (T067)', () => {
    const indexPath = join(process.cwd(), 'public/index.html');
    const indexHtml = readFileSync(indexPath, 'utf-8');
    assert.ok(!indexHtml.includes('id="btn-add-node" class="secondary" disabled style="display:none;"'), 'btn-add-node must not be style="display:none;"');
    assert.ok(!indexHtml.includes('id="btn-new-project" class="secondary" style="display:none;"'), 'btn-new-project must not be style="display:none;"');

    const appJsPath = join(process.cwd(), 'public/js/app.js');
    const appJs = readFileSync(appJsPath, 'utf-8');
    assert.ok(appJs.includes("getElementById('btn-add-node')?.addEventListener('click', openAddNodeModal)"), 'btn-add-node should be wired');
    assert.ok(appJs.includes("getElementById('btn-new-project')?.addEventListener('click', openNewProjectModal)"), 'btn-new-project should be wired');

    const addNodeModalPath = join(process.cwd(), 'public/js/project/add-node-modal.js');
    assert.ok(existsSync(addNodeModalPath), 'add-node-modal.js must exist');
  });

  await t.test('server restricts CORS to localhost and blocks external websites from modifying files (T068)', async () => {
    // 1. External preflight options on mutation endpoint -> rejected with 403
    const optRes = await fetch('http://localhost:3000/save-file', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://malicious-site.com',
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.strictEqual(optRes.status, 403, 'External origin preflight must return 403 Forbidden');

    // 2. External direct POST to mutation endpoint -> rejected with 403
    const postRes = await fetch('http://localhost:3000/save-file', {
      method: 'POST',
      headers: {
        'Origin': 'https://malicious-site.com',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filePath: 'test.js', content: 'hacked' })
    });
    assert.strictEqual(postRes.status, 403, 'External origin POST must return 403 Forbidden');

    // 3. Telemetry on /client-log with game client localhost origin -> allowed
    const telRes = await fetch('http://localhost:3000/client-log', {
      method: 'POST',
      headers: {
        'Origin': 'http://localhost:5173',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ level: 'info', message: 'test game log' })
    });
    assert.ok(telRes.ok, 'Localhost telemetry must be allowed');
  });

  await t.test('all remaining action buttons are wired in app.js (T069)', () => {
    const appJsPath = join(process.cwd(), 'public/js/app.js');
    const appJs = readFileSync(appJsPath, 'utf-8');

    const expectedButtons = [
      'btn-pause-game',
      'btn-stop-game',
      'btn-open-godot',
      'btn-preview-reload',
      'btn-preview-newtab',
      'btn-term-report',
      'btn-toggle-preview'
    ];

    for (const btnId of expectedButtons) {
      assert.ok(appJs.includes(`getElementById('${btnId}')?.addEventListener('click'`), `Button ${btnId} must be wired to a click listener in app.js`);
    }
  });

  await t.test('detail-panel.js builds paste-back UI with lock claim and code textarea (T070)', () => {
    const detailPanelPath = join(process.cwd(), 'public/js/panel/detail-panel.js');
    assert.ok(existsSync(detailPanelPath));
    const content = readFileSync(detailPanelPath, 'utf-8');

    assert.ok(content.includes('id="panel-paste-back-section"'), 'Should render paste-back section');
    assert.ok(content.includes('id="pasteback-holder"'), 'Should render holder input');
    assert.ok(content.includes('id="btn-pasteback-claim-lock"'), 'Should render claim lock button');
    assert.ok(content.includes('id="pasteback-code"'), 'Should render code textarea');
    assert.ok(content.includes('id="btn-submit-pasteback"'), 'Should render write-back button');
    assert.ok(content.includes("fetch('/paste-back'"), 'Should call /paste-back on submit');
  });

  await t.test('app.js implements 10-second lock auto-poll (T071)', () => {
    const appJsPath = join(process.cwd(), 'public/js/app.js');
    const appJs = readFileSync(appJsPath, 'utf-8');

    assert.ok(appJs.includes('function startLockPolling()'), 'startLockPolling function must be defined');
    assert.ok(appJs.includes('10000'), 'Lock polling must run at 10000ms interval');
    assert.ok(appJs.includes('startLockPolling()'), 'startLockPolling must be called on app init');
  });

  await t.test('D3 loading and main page assets load correctly (T073)', async () => {
    // 1. Fetch main page HTML from server
    const pageRes = await makeRequest('GET', '/');
    assert.strictEqual(pageRes.status, 200, 'GET / should return 200 OK');
    const html = pageRes.raw;
    assert.ok(html.includes('<script src="https://d3js.org/d3.v7.min.js"></script>'), 'Page must load D3 v7 via CDN script tag');

    // 2. Fetch local client scripts and styles referenced by index.html
    const localResources = [
      '/css/variables.css',
      '/css/base.css',
      '/css/graph.css',
      '/css/sidebar.css',
      '/css/terminal.css',
      '/css/modals.css',
      '/css/workstation.css',
      '/js/app.js',
      '/js/graph/render.js'
    ];

    for (const resPath of localResources) {
      const res = await makeRequest('GET', resPath);
      assert.strictEqual(res.status, 200, `Static asset ${resPath} must return 200 OK`);
    }

    // 3. Confirm render.js references d3
    const renderJsPath = join(process.cwd(), 'public/js/graph/render.js');
    const renderJs = readFileSync(renderJsPath, 'utf-8');
    assert.ok(renderJs.includes('d3.select') || renderJs.includes('d3.forceSimulation'), 'render.js must utilize d3');
  });

  await t.test('removed scene 1 artifact and sidecars ignored in .gitignore (T074)', () => {
    const artifactPath = join(process.cwd(), 'test-fixtures/js-sample/scene 1');
    assert.strictEqual(existsSync(artifactPath), false, 'test-fixtures/js-sample/scene 1 must not exist');

    const gitignorePath = join(process.cwd(), '.gitignore');
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    assert.ok(gitignore.includes('.contextforge.*'), '.gitignore must ignore .contextforge.* sidecars');
  });

  await t.test('parseProjectProgress always resolves against loaded project root TASKS.md (T075)', () => {
    const testDir = join(tmpdir(), `cf-test-tasks-${Date.now()}`);
    mkdirSync(join(testDir, 'docs'), { recursive: true });

    // Root TASKS.md
    writeFileSync(join(testDir, 'TASKS.md'), [
      '# My Project Tasks',
      '## Phase 1 — Root Phase',
      '- [x] T001: Root task 1',
      '- [ ] T002: Root task 2'
    ].join('\n'));

    // Template docs/TASKS.md
    writeFileSync(join(testDir, 'docs/TASKS.md'), [
      '# Template Tasks',
      '## Phase 99 — Template Phase',
      '- [ ] T999: Template task'
    ].join('\n'));

    const progress = parseProjectProgress(testDir);
    assert.strictEqual(progress.hasTasks, true);
    assert.strictEqual(progress.totalTasks, 2, 'Should only count root tasks');
    assert.strictEqual(progress.completedTasks, 1);
    assert.strictEqual(progress.phases.length, 1);
    assert.strictEqual(progress.phases[0].title, 'Phase 1 — Root Phase');
    assert.strictEqual(progress.tasksFilePath, join(testDir, 'TASKS.md'), 'tasksFilePath must point to root TASKS.md');

    // Clean up
    rmSync(testDir, { recursive: true, force: true });
  });

  await t.test('all frontend module imports resolve to real files and Files menu button is wired', async () => {
    // 1. Scan all JS files under public/js and verify imports
    const jsDir = join(process.cwd(), 'public/js');
    const checkedImports = [];

    function scan(dir) {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          scan(full);
        } else if (ent.isFile() && ent.name.endsWith('.js')) {
          const content = readFileSync(full, 'utf-8');
          const importMatches = [...content.matchAll(/(?:import|export)\s+(?:.*?from\s+)?['"]([^'"]+)['"]/g)];
          for (const m of importMatches) {
            const specifier = m[1];
            if (specifier.startsWith('.')) {
              const resolved = join(dir, specifier);
              const exists = existsSync(resolved) || existsSync(resolved + '.js');
              assert.ok(exists, `Broken import in ${full}: "${specifier}" must resolve on disk`);
              checkedImports.push(specifier);
            }
          }
        }
      }
    }
    scan(jsDir);
    assert.ok(checkedImports.length > 20, 'Should verify all module imports');

    // 2. Verify Files button in index.html and event wiring in app.js
    const indexHtml = readFileSync(join(process.cwd(), 'public/index.html'), 'utf-8');
    assert.ok(indexHtml.includes('id="btn-sidebar-toggle"'), 'index.html must have btn-sidebar-toggle');
    assert.ok(indexHtml.includes('id="files-menu"'), 'index.html must have files-menu');

    const appJs = readFileSync(join(process.cwd(), 'public/js/app.js'), 'utf-8');
    assert.ok(appJs.includes("getElementById('btn-sidebar-toggle')"), 'app.js must wire btn-sidebar-toggle');
    assert.ok(appJs.includes("filesMenu.style.display = isVisible ? 'none' : 'block'"), 'app.js must toggle files-menu display');
  });
});


