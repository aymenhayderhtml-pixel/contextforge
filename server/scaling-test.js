/**
 * server/scaling-test.js — Tests for Phase 9 & Phase 10:
 * - T032: Medium-scale fixture extraction (~30 nodes, clusters + orphans)
 * - T033: Zoom/pan configuration
 * - T034: Fit to View implementation & DOM control
 * - T035: Threshold-based folder clustering
 * - T036: Fuzzy search & centering
 * - T037: Focus Mode (1-hop neighborhood calculation)
 * - T038: Unconnected/orphaned nodes collection
 * - T039: Hover pure visual styling (no simulation restart)
 * - T040: Alpha cooldown / settle decay
 * - T041: Drag pinning & reset layout
 *
 * Run: node server/scaling-test.js
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const largeFixture = join(projectRoot, 'test-fixtures', 'godot-large-sample');
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

console.log('Graph Scaling & Layout Stability (Phase 9 & 10) tests:\n');

function loadFrontendSource() {
  const htmlDoc = readFileSync(htmlPath, 'utf-8');
  const css = readdirSync(join(projectRoot, 'public', 'css'))
    .map(f => readFileSync(join(projectRoot, 'public', 'css', f), 'utf-8')).join('\n');
  const js = [
    'app.js', 'state.js', 'preview/preview.js', 'sidebar/tree.js',
    'terminal/terminal.js', 'clipboard/clipboard.js', 'history/history.js',
    'issue/issue-modal.js', 'project/wizard.js', 'panel/detail-panel.js',
    'graph/render.js'
  ]
    .filter(f => existsSync(join(projectRoot, 'public', 'js', f)))
    .map(f => readFileSync(join(projectRoot, 'public', 'js', f), 'utf-8')).join('\n');
  return htmlDoc + '\n' + css + '\n' + js;
}

const html = loadFrontendSource();

// 1. Static HTML / DOM Controls Verification
await test('HTML contains all Phase 9 & 10 controls (T033-T041)', () => {
  assert(html.includes('id="search-input"'), 'Missing search input');
  assert(html.includes('id="btn-fit-view"'), 'Missing Fit to View button');
  assert(html.includes('id="btn-focus-mode"'), 'Missing Focus Mode button');
  assert(html.includes('id="btn-reset-layout"'), 'Missing Reset Layout button');
  assert(html.includes('id="chk-cluster"'), 'Missing Cluster checkbox');
  assert(html.includes('id="chk-group-orphans"'), 'Missing Group Orphans checkbox');
  assert(html.includes('id="unconnected-panel"'), 'Missing unconnected panel');
  assert(html.includes('cluster-shape'), 'Missing cluster styling');
});

// 2. JavaScript Implementation Checks
await test('Script implements zoom & pan with d3.zoom (T033)', () => {
  assert(html.includes('d3.zoom()'), 'Missing d3.zoom()');
  assert(html.includes('currentZoom = zoom'), 'currentZoom not tracked');
  assert(html.includes('scaleExtent([0.1, 5])'), 'Missing wide scaleExtent for scaling');
});

await test('Script implements Fit to View calculation (T034)', () => {
  assert(html.includes('function fitToView()'), 'Missing fitToView function');
  assert(html.includes('btnFitView.addEventListener(\'click\', fitToView)'), 'Fit to View button not wired');
  assert(html.includes('currentZoom.transform'), 'Missing zoom transform call in fitToView');
});

await test('Script implements folder clustering above threshold (T035)', () => {
  assert(html.includes('clusterThreshold'), 'Missing clusterThreshold variable');
  assert(html.includes('function getNodeFolder('), 'Missing getNodeFolder helper');
  assert(html.includes('expandedFolders'), 'Missing expandedFolders state');
  assert(html.includes('cluster:'), 'Missing cluster ID prefix');
});

await test('Script implements fuzzy search and match centering (T036)', () => {
  assert(html.includes('function searchAndCenterFirstMatch()'), 'Missing searchAndCenterFirstMatch function');
  assert(html.includes('searchInput.addEventListener(\'input\''), 'Missing search input listener');
  assert(html.includes('searchQuery'), 'Missing searchQuery state');
});

await test('Script implements 1-hop neighborhood Focus Mode (T037)', () => {
  assert(html.includes('isFocusMode'), 'Missing isFocusMode state');
  assert(html.includes('focusNeighborhood'), 'Missing focusNeighborhood calculation');
  assert(html.includes('btnFocusMode.addEventListener'), 'Missing btnFocusMode listener');
});

await test('Script collects unconnected zero-edge nodes into group (T038)', () => {
  assert(html.includes('groupOrphansEnabled'), 'Missing groupOrphansEnabled state');
  assert(html.includes('orphanNodes'), 'Missing orphanNodes detection');
  assert(html.includes('unconnectedCount'), 'Missing unconnectedCount updater');
});

await test('Hover is pure visual style change without simulation restart (T039)', () => {
  // Confirm hover does not call simulation.alpha or simulation.restart
  const hoverSnippet = html.substring(html.indexOf("node.on('mouseenter'"), html.indexOf("node.on('mouseleave'") + 400);
  assert(!hoverSnippet.includes('simulation.alpha('), 'Hover must NOT call simulation.alpha');
  assert(!hoverSnippet.includes('simulation.restart()'), 'Hover must NOT call simulation.restart');
});

await test('Simulation has alpha decay cooldown (T040)', () => {
  assert(html.includes('.alphaDecay(0.04)'), 'Missing alphaDecay for cooldown');
  assert(html.includes('.alphaMin(0.001)'), 'Missing alphaMin to stop simulation');
});

await test('Dragged nodes stay pinned at user coordinates (T041)', () => {
  assert(html.includes('pinnedNodePositions'), 'Missing pinnedNodePositions map');
  assert(html.includes('pinnedNodePositions.set(d.id'), 'DragEnd must record pinned coordinates');
  assert(html.includes('btnResetLayout.addEventListener'), 'Missing reset layout listener');
});

// 3. API Integration against the Medium-Scale Fixture (T032)
await test('POST /extract runs against godot-large-sample and returns ~30 nodes', async () => {
  const res = await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: largeFixture })
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await res.json();

  assert(data.nodes.length >= 25 && data.nodes.length <= 35,
    `Expected 25-35 nodes, got ${data.nodes.length}`);
  assert(data.edges.length >= 10, `Expected at least 10 edges, got ${data.edges.length}`);

  // Test clustering logic on this data
  const folderCounts = {};
  for (const n of data.nodes) {
    const idx = n.id.lastIndexOf('/');
    const folder = idx > 0 ? n.id.substring(0, idx) : '.';
    folderCounts[folder] = (folderCounts[folder] || 0) + 1;
  }

  assert(folderCounts['scenes/ui'] === 4, `scenes/ui should have 4 nodes, got ${folderCounts['scenes/ui']}`);
  assert(folderCounts['scenes/entities'] === 4, `scenes/entities should have 4 nodes, got ${folderCounts['scenes/entities']}`);
  assert(folderCounts['scripts/utils'] === 6, `scripts/utils should have 6 nodes, got ${folderCounts['scripts/utils']}`);
  assert(folderCounts['scripts/tests'] === 3, `scripts/tests should have 3 nodes, got ${folderCounts['scripts/tests']}`);

  // Identify orphans
  const connected = new Set();
  data.edges.forEach(e => { connected.add(e.from); connected.add(e.to); });
  const orphans = data.nodes.filter(n => !connected.has(n.id));
  assert(orphans.length >= 8, `Expected at least 8 orphans, got ${orphans.length}`);
});

// 4. Phase 11 — UI / Screen Space Overhaul Tests (T042 - T046)
await test('Responsive canvas resize handler responds to window events (T042)', () => {
  assert(html.includes('function handleResize('), 'Missing handleResize function');
  assert(html.includes('window.addEventListener(\'resize\', handleResize)'), 'Missing resize listener for canvas');
  assert(html.includes('currentSvg.attr(\'width\', width)'), 'handleResize must update svg width');
  assert(html.includes('.attr(\'height\', height)'), 'handleResize must update svg height');
});

await test('Detail panel is resizable via drag handle and collapsible (T043)', () => {
  assert(html.includes('id="panel-resizer"'), 'Missing panel resizer handle in DOM');
  assert(html.includes('isResizingPanel'), 'Missing isResizingPanel flag');
  assert(html.includes('--panel-w'), 'Missing CSS variable update for panel width');
  assert(html.includes('sidePanel.classList.remove(\'open\')'), 'closePanel must collapse panel');
});

await test('Project path truncates with ellipsis and full value title tooltip (T044)', () => {
  assert(html.includes('text-overflow: ellipsis'), 'Missing CSS text-overflow: ellipsis for project-path');
  assert(html.includes('pathInput.title = pathInput.value'), 'pathInput.title must reflect value for tooltip');
  assert(html.includes('pathInput.addEventListener(\'input\''), 'pathInput must update title on input');
});

await test('Left sidebar tree provides searchable folder hierarchy with selection sync (T045)', () => {
  assert(html.includes('id="left-sidebar"'), 'Missing left-sidebar element');
  assert(html.includes('id="sidebar-search"'), 'Missing sidebar-search input');
  assert(html.includes('id="sidebar-tree"'), 'Missing sidebar-tree container');
  assert(html.includes('function updateSidebarTree('), 'Missing updateSidebarTree function');
  assert(html.includes('.tree-item'), 'Missing tree-item CSS/class');
  assert(html.includes('scrollIntoView'), 'Selection must scroll tree item into view');
});

await test('Medium fixture scale audit maps cleanly to sidebar folders (T046)', async () => {
  const res = await fetch(`${BASE_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: largeFixture })
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await res.json();

  // Simulate updateSidebarTree grouping logic
  const groups = new Map();
  for (const n of data.nodes) {
    const idx = n.id.lastIndexOf('/');
    const folder = idx > 0 ? n.id.substring(0, idx) : '.';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(n);
  }

  assert(groups.size >= 6, `Expected at least 6 folder groups, got ${groups.size}`);
  assert(groups.has('scenes/levels'), 'Missing scenes/levels folder');
  assert(groups.has('scenes/entities'), 'Missing scenes/entities folder');
  assert(groups.has('scripts/core'), 'Missing scripts/core folder');
  assert(groups.has('scripts/utils'), 'Missing scripts/utils folder');

  // Verify total nodes accounted for
  let totalInGroups = 0;
  for (const list of groups.values()) {
    totalInGroups += list.length;
  }
  assert(totalInGroups === data.nodes.length, `All ${data.nodes.length} nodes must belong to a folder`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

