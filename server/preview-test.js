/**
 * server/preview-test.js — Automated tests for Phase 12: Web Live Preview Panel
 * - T047: Collapsible preview panel embedding <iframe> pointed at dev server URL
 * - T048: Persistence of preview URL per project in .contextforge.preview.json sidecar
 * - T049: Conditional visibility: only show preview panel for projects with JS/HTML nodes
 *
 * Run: node server/preview-test.js
 */

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const jsFixture = join(projectRoot, 'test-fixtures', 'js-sample');
const godotFixture = join(projectRoot, 'test-fixtures', 'godot-sample');
const htmlPath = join(projectRoot, 'public', 'index.html');

const BASE_URL = 'http://localhost:3000';
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  })();
}

console.log('Phase 12 — Web Live Preview Panel tests:\n');

const html = readFileSync(htmlPath, 'utf-8');

// 1. DOM Elements & Iframe verification (T047)
await test('HTML contains collapsible preview panel with embedded iframe (T047)', () => {
  assert(html.includes('id="web-preview-panel"'), 'Missing web-preview-panel element');
  assert(html.includes('id="web-preview-iframe"'), 'Missing web-preview-iframe element');
  assert(html.includes('id="preview-url-input"'), 'Missing preview-url-input field');
  assert(html.includes('id="btn-preview-reload"'), 'Missing preview reload button');
  assert(html.includes('id="btn-preview-newtab"'), 'Missing open in new tab button');
  assert(html.includes('id="btn-preview-collapse"'), 'Missing collapse toggle button');
  assert(html.includes('id="btn-toggle-preview"'), 'Missing header/controls preview toggle button');
  assert(html.includes('class="web-preview-panel collapsed"'), 'Preview panel starts collapsed by default');
});

await test('Client script implements iframe URL loading and collapse toggle (T047)', () => {
  assert(html.includes('function togglePreviewPanel('), 'Missing togglePreviewPanel function');
  assert(html.includes('function reloadPreviewIframe('), 'Missing reloadPreviewIframe function');
  assert(html.includes('webPreviewIframe.src = url'), 'Missing assignment of iframe src');
});

// 2. URL Persistence via Sidecar & API (T048)
await test('POST /preview-url persists URL to project sidecar file (T048)', async () => {
  const sidecarFile = join(jsFixture, '.contextforge.preview.json');
  if (existsSync(sidecarFile)) unlinkSync(sidecarFile);

  const testUrl = 'http://localhost:5173/test-app';
  const postRes = await fetch(`${BASE_URL}/preview-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: jsFixture, url: testUrl })
  });
  assert(postRes.ok, `POST failed with status ${postRes.status}`);
  const postData = await postRes.json();
  assert(postData.success === true, 'Response success should be true');
  assert(postData.url === testUrl, `Expected url ${testUrl}, got ${postData.url}`);

  // Confirm sidecar file on disk
  assert(existsSync(sidecarFile), 'Sidecar file .contextforge.preview.json not created');
  const diskData = JSON.parse(readFileSync(sidecarFile, 'utf-8'));
  assert(diskData.url === testUrl, `Sidecar contains wrong url: ${diskData.url}`);
});

await test('GET /preview-url retrieves previously persisted URL (T048)', async () => {
  const getRes = await fetch(`${BASE_URL}/preview-url?projectPath=${encodeURIComponent(jsFixture)}`);
  assert(getRes.ok, `GET failed with status ${getRes.status}`);
  const getData = await getRes.json();
  assert(getData.url === 'http://localhost:5173/test-app', `Expected persisted url, got ${getData.url}`);
});

// 3. Conditional Visibility for JS vs Godot Projects (T049)
await test('Preview panel is offered for JS projects containing JS nodes (T049)', async () => {
  const res = await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: jsFixture })
  });
  assert(res.ok, `Status ${res.status}`);
  const manifest = await res.json();

  const hasJs = manifest.nodes.some(n =>
    n.engine === 'js' ||
    (n.id && (n.id.endsWith('.js') || n.id.endsWith('.html') || n.id.endsWith('.mjs') || n.id.endsWith('.ts')))
  );
  assert(hasJs === true, 'JS fixture must detect JS nodes');
  assert(html.includes('checkAndSetupPreviewPanel()'), 'doExtract must call checkAndSetupPreviewPanel');
});

await test('Preview panel is hidden for Godot-only projects (T049)', async () => {
  const res = await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: godotFixture })
  });
  assert(res.ok, `Status ${res.status}`);
  const manifest = await res.json();

  const hasJs = manifest.nodes.some(n =>
    n.engine === 'js' ||
    (n.id && (n.id.endsWith('.js') || n.id.endsWith('.html') || n.id.endsWith('.mjs') || n.id.endsWith('.ts')))
  );
  assert(hasJs === false, 'Godot fixture must NOT contain JS nodes');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
