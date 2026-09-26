/**
 * public/js/workstation/problem-pane.js
 * Left Pane: Problem Definition, Console Evidence, Screenshot Dropzone & Strategy Selector.
 */

import { state, notifyStateChange } from '../state.js';
import { fetchConsoleLogs } from '../terminal/terminal.js';
import { showToast } from '../shared/toast.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let activeProblemMode = 'normal'; // 'normal' | 'advanced'
let consoleData = { logs: [], redLogs: [] };
let onCompileCallback = null;

export function initProblemPane(container, { onCompile }) {
  if (!container) return;
  onCompileCallback = onCompile;
  renderProblemPane(container);
  refreshConsoleEvidence(container, false);
}

export function renderProblemPane(container) {
  if (!container) return;

  const ws = state.workstation;
  const isAdv = activeProblemMode === 'advanced';

  container.innerHTML = `
    <div class="ws-pane-header">
      <div class="ws-pane-title">
        <span>🐞 Problem & Evidence</span>
      </div>
      <div class="pill-mode-group" id="ws-problem-mode-group">
        <button type="button" class="pill-mode-btn ${!isAdv ? 'active' : ''}" id="btn-mode-normal">Normal</button>
        <button type="button" class="pill-mode-btn ${isAdv ? 'active' : ''}" id="btn-mode-adv">Advanced</button>
      </div>
    </div>

    <div class="ws-pane-body">
      <!-- Problem Description -->
      <div class="ws-card">
        <div class="ws-card-title">
          <span>What is wrong?</span>
          <span style="font-weight:normal; font-size:0.68rem; color:var(--dim);">Describe bug or expected vs actual</span>
        </div>
        <textarea id="ws-input-problem" class="ws-textarea" style="height:65px;" placeholder="e.g. Player falls through floor when jumping near boxes in level 2...">${esc(ws.problemText)}</textarea>
      </div>

      <!-- Console & Runtime Evidence -->
      <div class="ws-card">
        <div class="ws-card-title">
          <span>📟 Runtime Console</span>
          <div style="display:flex; align-items:center; gap:0.35rem;">
            <div class="pill-mode-group" id="ws-console-filter-group">
              <button type="button" class="pill-mode-btn ${ws.consoleFilter === 'all' ? 'active' : ''}" id="btn-ws-filter-all">All</button>
              <button type="button" class="pill-mode-btn ${ws.consoleFilter === 'red' ? 'active' : ''}" id="btn-ws-filter-red" style="color:#ef4444; font-weight:600;">Red</button>
            </div>
            <button type="button" class="secondary" id="btn-ws-refresh-console" style="font-size:0.68rem; height:19px; padding:0 0.4rem;">🔄 Check</button>
          </div>
        </div>
        <div id="ws-console-box" style="background:#0d1117; color:#c9d1d9; border:1px solid var(--border); border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:0.7rem; max-height:85px; overflow-y:auto; padding:0.35rem 0.55rem; white-space:pre-wrap; line-height:1.35;">
          Checking console...
        </div>
      </div>

      <!-- Screenshot Dropzone -->
      <div class="ws-card">
        <div class="ws-card-title">
          <span>🖼️ Screenshot / Visual Evidence</span>
          <span style="font-weight:normal; font-size:0.68rem; color:var(--dim);">(Optional)</span>
        </div>
        <div class="ws-screenshot-dropzone" id="ws-screenshot-dropzone">
          <input type="file" id="ws-screenshot-file" accept="image/*" style="display:none;">
          <div style="font-size:0.75rem; color:var(--dim);">
            <span>📁 Drag & drop screenshot or </span>
            <span style="color:var(--primary); text-decoration:underline;">browse</span>
          </div>
          <div style="font-size:0.67rem; color:var(--dim); margin-top:2px;">(Or press Ctrl+V while focused)</div>
        </div>
        <div id="ws-screenshot-preview-container">
          ${ws.screenshotBase64 ? `
            <div class="ws-screenshot-preview">
              <img src="${ws.screenshotBase64}" alt="Screenshot evidence">
              <button type="button" class="ws-screenshot-remove" id="btn-remove-screenshot">✕ Remove</button>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Advanced Mode Settings -->
      ${isAdv ? `
        <div class="ws-card" style="border-color:var(--border-focus);">
          <div class="ws-card-title" style="color:var(--primary);">
            <span>⚙️ Advanced Strategy</span>
          </div>
          <div style="display:flex; flex-direction:column; gap:0.4rem; font-size:0.72rem;">
            <div>
              <label style="color:var(--dim); display:block; margin-bottom:2px;">Issue Category:</label>
              <select id="ws-issue-category" style="width:100%; background:#0d1117; color:var(--text); border:1px solid var(--border); border-radius:3px; padding:2px 4px; font-size:0.72rem;">
                <option value="runtime_error" ${ws.issueCategory === 'runtime_error' ? 'selected' : ''}>Runtime Error (Crash/Exception)</option>
                <option value="build_error" ${ws.issueCategory === 'build_error' ? 'selected' : ''}>Build / Syntax Error</option>
                <option value="visual_bug" ${ws.issueCategory === 'visual_bug' ? 'selected' : ''}>Visual / UI Bug</option>
                <option value="logic_bug" ${ws.issueCategory === 'logic_bug' ? 'selected' : ''}>Gameplay Logic Bug</option>
                <option value="perf_bug" ${ws.issueCategory === 'perf_bug' ? 'selected' : ''}>Performance Issue</option>
              </select>
            </div>
            <div>
              <label style="color:var(--dim); display:block; margin-bottom:2px;">Context Depth:</label>
              <div class="pill-mode-group" id="ws-strategy-group" style="width:100%;">
                <button type="button" class="pill-mode-btn ${ws.contextStrategy === 'minimal' ? 'active' : ''}" data-strategy="minimal" style="flex:1;">Minimal</button>
                <button type="button" class="pill-mode-btn ${ws.contextStrategy === 'balanced' ? 'active' : ''}" data-strategy="balanced" style="flex:1;">Balanced</button>
                <button type="button" class="pill-mode-btn ${ws.contextStrategy === 'deep' ? 'active' : ''}" data-strategy="deep" style="flex:1;">Deep</button>
              </div>
            </div>
            <div style="color:var(--dim); font-size:0.67rem; margin-top:2px;">
              <span>• Git / Recent Changes: <em style="color:var(--dim);">Optional (Future)</em></span>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- Compile Action -->
      <div style="margin-top:auto; padding-top:0.4rem;">
        <button id="btn-ws-compile-handoff" style="width:100%; height:32px; font-weight:700; font-size:0.78rem; display:flex; align-items:center; justify-content:center; gap:0.45rem;">
          <span>⚡ Compile Fix Handoff</span>
        </button>
      </div>
    </div>
  `;

  attachProblemEvents(container);
  renderConsoleBox(container);
}

function attachProblemEvents(container) {
  const descArea = container.querySelector('#ws-input-problem');
  descArea?.addEventListener('input', (e) => {
    state.workstation.problemText = e.target.value;
  });

  // Mode buttons
  container.querySelector('#btn-mode-normal')?.addEventListener('click', () => {
    if (activeProblemMode !== 'normal') {
      activeProblemMode = 'normal';
      renderProblemPane(container);
    }
  });
  container.querySelector('#btn-mode-adv')?.addEventListener('click', () => {
    if (activeProblemMode !== 'advanced') {
      activeProblemMode = 'advanced';
      renderProblemPane(container);
    }
  });

  // Console filters
  container.querySelector('#btn-ws-filter-all')?.addEventListener('click', () => {
    state.workstation.consoleFilter = 'all';
    renderProblemPane(container);
  });
  container.querySelector('#btn-ws-filter-red')?.addEventListener('click', () => {
    state.workstation.consoleFilter = 'red';
    renderProblemPane(container);
  });
  container.querySelector('#btn-ws-refresh-console')?.addEventListener('click', () => {
    refreshConsoleEvidence(container, true);
  });

  // Advanced Category & Strategy
  container.querySelector('#ws-issue-category')?.addEventListener('change', (e) => {
    state.workstation.issueCategory = e.target.value;
  });
  container.querySelectorAll('#ws-strategy-group .pill-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.workstation.contextStrategy = btn.getAttribute('data-strategy');
      renderProblemPane(container);
    });
  });

  // Screenshot Upload / Dropzone
  const dropzone = container.querySelector('#ws-screenshot-dropzone');
  const fileInput = container.querySelector('#ws-screenshot-file');

  dropzone?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleScreenshotFile(file, container);
  });

  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleScreenshotFile(file, container);
    }
  });

  // Paste image directly into Problem pane
  container.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.indexOf('image') === 0) {
        const file = item.getAsFile();
        if (file) handleScreenshotFile(file, container);
      }
    }
  });

  container.querySelector('#btn-remove-screenshot')?.addEventListener('click', () => {
    state.workstation.screenshotBase64 = null;
    renderProblemPane(container);
  });

  // Compile button
  container.querySelector('#btn-ws-compile-handoff')?.addEventListener('click', () => {
    if (onCompileCallback) onCompileCallback();
  });
}

function handleScreenshotFile(file, container) {
  const reader = new FileReader();
  reader.onload = (e) => {
    state.workstation.screenshotBase64 = e.target.result;
    showToast('Screenshot attached as visual evidence', 'info');
    renderProblemPane(container);
  };
  reader.readAsDataURL(file);
}

export async function refreshConsoleEvidence(container, force = false) {
  if (!state.projectPath) return;
  consoleData = await fetchConsoleLogs(state.projectPath, force);
  renderConsoleBox(container);
}

function renderConsoleBox(container) {
  const box = container?.querySelector('#ws-console-box');
  if (!box) return;

  const ws = state.workstation;
  if (ws.consoleFilter === 'red') {
    if (!consoleData.redLogs || consoleData.redLogs.length === 0) {
      box.innerHTML = '<div style="color:var(--dim); font-style:italic;">No red compiler/runtime errors detected. (Click "All" to view stdout or "🔄 Check" to test).</div>';
    } else {
      box.innerHTML = consoleData.redLogs.map(l =>
        `<div style="color:#ff6b6b; font-weight:600; padding:1px 0;">${esc(l.text)}</div>`
      ).join('');
    }
  } else {
    if (!consoleData.logs || consoleData.logs.length === 0) {
      box.innerHTML = '<div style="color:var(--dim); font-style:italic;">Console is empty.</div>';
    } else {
      box.innerHTML = consoleData.logs.map(l => {
        const color = l.isError ? '#ff6b6b; font-weight:600;' : '#8b949e;';
        return `<div style="color:${color} padding:1px 0;">${esc(l.text)}</div>`;
      }).join('');
    }
  }
}

export function getProblemPayload() {
  const ws = state.workstation;
  let consoleText = '';
  if (ws.consoleFilter === 'red' && consoleData.redLogs && consoleData.redLogs.length > 0) {
    consoleText = consoleData.redLogs.map(l => l.text).join('\n');
  } else if (consoleData.logs && consoleData.logs.length > 0) {
    consoleText = consoleData.logs.map(l => l.text).join('\n');
  }

  return {
    description: ws.problemText.trim(),
    consoleLogs: consoleText,
    screenshotBase64: ws.screenshotBase64,
    category: ws.issueCategory,
    strategy: ws.contextStrategy
  };
}
