/**
 * public/js/workstation/problem-pane.js
 * Left Pane: Problem Definition & Runtime Evidence (Clean, Streamlined Workflow).
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

let isAdvancedOpen = false;
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

  container.innerHTML = `
    <div class="ws-pane-header">
      <div class="ws-pane-title">
        <span style="color:#ef4444; font-weight:700;">🔴 Problem</span>
      </div>
      <button type="button" class="ws-header-link" id="btn-toggle-adv-problem" title="Toggle advanced problem options">
        ⚙️ Advanced ${isAdvancedOpen ? '▴' : '▾'}
      </button>
    </div>

    <div class="ws-pane-body">
      <!-- What's wrong? -->
      <div class="ws-clean-group">
        <label class="ws-clean-label" for="ws-input-problem">What's wrong?</label>
        <textarea id="ws-input-problem" class="ws-textarea" style="height:65px;" placeholder="Describe what broke or paste the error message...">${esc(ws.problemText)}</textarea>
      </div>

      <!-- Runtime Error -->
      <div class="ws-clean-group">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <label class="ws-clean-label">Runtime error</label>
          <button type="button" class="ws-mini-link" id="btn-ws-refresh-console" title="Re-check compiler/runtime logs">
            🔄 Re-check
          </button>
        </div>
        <div id="ws-console-box" class="ws-error-card">
          Checking console...
        </div>
      </div>

      <!-- Screenshot Upload (Quiet) -->
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
        <button type="button" class="ws-mini-link" id="btn-trigger-screenshot" style="color:var(--text); font-weight:600;">
          📸 + Add Screenshot
        </button>
        <input type="file" id="ws-screenshot-file" accept="image/*" style="display:none;">
        <span id="ws-screenshot-status" style="font-size:0.7rem; color:var(--dim);">
          ${ws.screenshotBase64 ? '✓ 1 image attached' : ''}
        </span>
      </div>

      <div id="ws-screenshot-preview-container">
        ${ws.screenshotBase64 ? `
          <div class="ws-screenshot-preview" style="position:relative; margin-top:4px;">
            <img src="${ws.screenshotBase64}" alt="Screenshot evidence" style="max-height:90px; border-radius:4px; border:1px solid var(--border); display:block; width:100%; object-fit:cover;">
            <button type="button" class="ws-screenshot-remove" id="btn-remove-screenshot" style="position:absolute; top:4px; right:4px; background:rgba(0,0,0,0.7); border:1px solid #fff; color:#fff; border-radius:3px; font-size:0.65rem; padding:1px 4px; cursor:pointer;">✕ Remove</button>
          </div>
        ` : ''}
      </div>

      <!-- Primary Action: Confident & Clear -->
      <div style="margin-top:auto; padding-top:0.6rem;">
        <button type="button" class="ws-big-primary-btn" id="btn-ws-compile-handoff">
          🔥 Fix This Issue
        </button>
      </div>

      <!-- Collapsible Advanced Drawer -->
      ${isAdvancedOpen ? `
        <div class="ws-collapsible-drawer" id="ws-adv-problem-drawer">
          <div style="font-weight:700; font-size:0.72rem; color:var(--primary); margin-bottom:0.4rem;">
            ⚙️ Advanced Options
          </div>

          <div style="display:flex; flex-direction:column; gap:0.4rem; font-size:0.72rem;">
            <div>
              <label style="color:var(--dim); display:block; margin-bottom:2px;">Category:</label>
              <select id="ws-issue-category" style="width:100%; background:#0d1117; color:var(--text); border:1px solid var(--border); border-radius:3px; padding:2px 4px; font-size:0.72rem;">
                <option value="runtime_error" ${ws.issueCategory === 'runtime_error' ? 'selected' : ''}>Runtime Error (Crash/Exception)</option>
                <option value="build_error" ${ws.issueCategory === 'build_error' ? 'selected' : ''}>Build / Syntax Error</option>
                <option value="visual_bug" ${ws.issueCategory === 'visual_bug' ? 'selected' : ''}>Visual / UI Bug</option>
                <option value="logic_bug" ${ws.issueCategory === 'logic_bug' ? 'selected' : ''}>Gameplay Logic Bug</option>
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

            <div style="display:flex; justify-content:space-between; align-items:center; padding-top:2px;">
              <span style="color:var(--dim);">Console Stream:</span>
              <div class="pill-mode-group">
                <button type="button" class="pill-mode-btn ${ws.consoleFilter === 'red' ? 'active' : ''}" id="btn-ws-filter-red" style="font-size:0.67rem; padding:1px 6px;">Red only</button>
                <button type="button" class="pill-mode-btn ${ws.consoleFilter === 'all' ? 'active' : ''}" id="btn-ws-filter-all" style="font-size:0.67rem; padding:1px 6px;">All stdout</button>
              </div>
            </div>
          </div>
        </div>
      ` : ''}
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

  // Toggle Advanced
  container.querySelector('#btn-toggle-adv-problem')?.addEventListener('click', () => {
    isAdvancedOpen = !isAdvancedOpen;
    renderProblemPane(container);
  });

  // Console refresh
  container.querySelector('#btn-ws-refresh-console')?.addEventListener('click', () => {
    refreshConsoleEvidence(container, true);
  });

  // Advanced filters & options
  container.querySelector('#btn-ws-filter-all')?.addEventListener('click', () => {
    state.workstation.consoleFilter = 'all';
    renderProblemPane(container);
  });
  container.querySelector('#btn-ws-filter-red')?.addEventListener('click', () => {
    state.workstation.consoleFilter = 'red';
    renderProblemPane(container);
  });
  container.querySelector('#ws-issue-category')?.addEventListener('change', (e) => {
    state.workstation.issueCategory = e.target.value;
  });
  container.querySelectorAll('#ws-strategy-group .pill-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.workstation.contextStrategy = btn.getAttribute('data-strategy');
      renderProblemPane(container);
    });
  });

  // Screenshot upload
  const fileInput = container.querySelector('#ws-screenshot-file');
  const btnTrigger = container.querySelector('#btn-trigger-screenshot');
  btnTrigger?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleImageFile(file, container);
  });

  // Remove screenshot
  container.querySelector('#btn-remove-screenshot')?.addEventListener('click', () => {
    state.workstation.screenshotBase64 = null;
    renderProblemPane(container);
    showToast('Screenshot removed.', 'info');
  });

  // Compile button
  container.querySelector('#btn-ws-compile-handoff')?.addEventListener('click', () => {
    if (onCompileCallback) onCompileCallback();
  });
}

function handleImageFile(file, container) {
  if (!file.type.startsWith('image/')) {
    showToast('Please select a valid image file (PNG, JPG, WebP).', 'warn');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    state.workstation.screenshotBase64 = e.target.result;
    renderProblemPane(container);
    showToast('✓ Screenshot attached to problem context.', 'success');
  };
  reader.readAsDataURL(file);
}

export async function refreshConsoleEvidence(container, force = false) {
  if (!state.projectPath) return;
  consoleData = await fetchConsoleLogs(state.projectPath, force);
  renderConsoleBox(container);

  // Background candidate file ranking if errors exist and no files selected yet
  if (consoleData.redLogs && consoleData.redLogs.length > 0 && (!state.workstation?.selectedFiles || state.workstation.selectedFiles.size === 0)) {
    try {
      const res = await fetch('/rank-relevant-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: state.projectPath,
          issueDescription: state.workstation.problemText || consoleData.redLogs[0].text,
          consoleLogs: consoleData.redLogs.map(l => l.text).join('\n')
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.files) && data.files.length > 0) {
          if (!state.workstation.selectedFiles || state.workstation.selectedFiles.size === 0) {
            state.workstation.selectedFiles = new Set();
            const topFiles = data.files.filter(f => f.score >= 90);
            if (topFiles.length > 0) {
              topFiles.forEach(f => state.workstation.selectedFiles.add(f.file));
            } else {
              state.workstation.selectedFiles.add(data.files[0].file);
            }
            const rightPane = document.getElementById('ws-pane-inspector');
            if (rightPane) {
              const { renderInspectorPane, setInspectorRankedFiles } = await import('./inspector-pane.js');
              setInspectorRankedFiles(data.files);
              renderInspectorPane(rightPane);
            }
          }
        }
      }
    } catch (_) {}
  }
}

function renderConsoleBox(container) {
  const box = container?.querySelector('#ws-console-box');
  if (!box) return;

  const ws = state.workstation;
  if (ws.consoleFilter === 'red') {
    if (!consoleData.redLogs || consoleData.redLogs.length === 0) {
      box.innerHTML = '<div style="color:var(--dim); font-style:italic;">No compiler or runtime errors detected. (Click 🔄 Re-check to run live check).</div>';
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

  let description = ws.problemText ? ws.problemText.trim() : '';
  if (!description && consoleData.redLogs && consoleData.redLogs.length > 0) {
    description = consoleData.redLogs[0].text;
  }

  return {
    description,
    consoleLogs: consoleText,
    screenshotBase64: ws.screenshotBase64,
    category: ws.issueCategory,
    strategy: ws.contextStrategy
  };
}
