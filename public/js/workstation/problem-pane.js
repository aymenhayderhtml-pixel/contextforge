/**
 * public/js/workstation/problem-pane.js
 * Left Pane: Problem Definition & Runtime Evidence (Clean, Streamlined Workflow).
 */

import { state, notifyStateChange } from '../state.js';
import { fetchConsoleLogs, updateConsoleBadge } from '../terminal/terminal.js';
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
      <div style="display:flex; align-items:center; gap:4px;">
        <button type="button" class="ws-pane-minimize-btn" id="btn-minimize-problem" title="Minimize/Expand Problem Pane">▴</button>
        <button type="button" class="ws-header-link" id="btn-toggle-adv-problem" title="Toggle advanced problem options">
          ⚙️ Advanced ${isAdvancedOpen ? '▴' : '▾'}
        </button>
        <button type="button" class="ws-pane-minimize-btn" id="btn-minimize-workstation" title="Minimize Workstation (▶)">▶</button>
      </div>
    </div>

    <div class="ws-pane-body">
      <!-- Split Mode Compact Error & 1-Click Handoff Strip -->
      <div class="ws-split-compact-strip" id="ws-split-compact-strip">
        <div class="ws-split-strip-error" id="ws-split-strip-error" title="Runtime error / problem summary">
          <span style="color:#ef4444; font-weight:700;">🔴</span>
          <span id="ws-split-error-text" style="color:#ff8585; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px;">${esc(consoleData.redLogs?.[0]?.text || ws.problemText || 'Ready to inspect')}</span>
        </div>
        <button type="button" class="ws-action-copy-btn" id="btn-ws-split-copy-handoff" title="Compile fix context and copy prompt to clipboard in 1 click">
          📋 Copy AI Handoff
        </button>
      </div>

      <!-- What's wrong? -->
      <div class="ws-clean-group">
        <label class="ws-clean-label" for="ws-input-problem">What's wrong?</label>
        <textarea id="ws-input-problem" class="ws-textarea" style="height:65px;" placeholder="Describe what broke or paste the error message...">${esc(ws.problemText)}</textarea>
      </div>

      <!-- Runtime Error -->
      <div class="ws-clean-group">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <label class="ws-clean-label">Runtime error</label>
          <div style="display:flex; align-items:center; gap:0.45rem;">
            <button type="button" class="ws-mini-link" id="btn-ws-clear-error" title="Clear runtime error logs">
              🗑️ Clear
            </button>
            <button type="button" class="ws-mini-link" id="btn-ws-copy-error" title="Copy raw error & stack trace to clipboard">
              📋 Copy
            </button>
            <button type="button" class="ws-mini-link" id="btn-ws-refresh-console" title="Re-check compiler/runtime logs">
              🔄 Re-check
            </button>
          </div>
        </div>
        <div id="ws-console-box" class="ws-error-card" title="Click to copy error text">
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

  // Minimize Problem Pane
  const btnMinProblem = container.querySelector('#btn-minimize-problem');
  btnMinProblem?.addEventListener('click', () => {
    const isCollapsed = container.classList.toggle('collapsed-pane');
    btnMinProblem.textContent = isCollapsed ? '▾' : '▴';
    btnMinProblem.title = isCollapsed ? 'Expand Problem Pane' : 'Minimize Problem Pane';
  });

  // Minimize Workstation Panel
  const btnMinWs = container.querySelector('#btn-minimize-workstation');
  btnMinWs?.addEventListener('click', async () => {
    const { minimizeWorkstation } = await import('./workstation.js');
    minimizeWorkstation();
  });

  // Toggle Advanced
  container.querySelector('#btn-toggle-adv-problem')?.addEventListener('click', () => {
    isAdvancedOpen = !isAdvancedOpen;
    renderProblemPane(container);
  });

  // Console refresh with visual feedback
  const btnRefresh = container.querySelector('#btn-ws-refresh-console');
  btnRefresh?.addEventListener('click', async () => {
    if (btnRefresh.disabled) return;
    const origText = btnRefresh.textContent;
    btnRefresh.disabled = true;
    btnRefresh.textContent = '⏳ Checking...';
    try {
      await refreshConsoleEvidence(container, true);
      const errCount = (consoleData.redLogs && consoleData.redLogs.length) || 0;
      if (errCount > 0) {
        showToast(`${errCount} error(s) detected`, 'warn');
      } else {
        showToast('No errors detected', 'success');
      }
    } catch (err) {
      showToast(`Check failed: ${err.message}`, 'error');
    } finally {
      if (btnRefresh) {
        btnRefresh.disabled = false;
        btnRefresh.textContent = origText || '🔄 Re-check';
      }
    }
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

  // Clear runtime error
  const btnClearError = container.querySelector('#btn-ws-clear-error');
  btnClearError?.addEventListener('click', async (e) => {
    e?.stopPropagation?.();
    const projectPath = state.projectPath || document.getElementById('project-path')?.value.trim();
    if (projectPath) {
      try {
        await fetch(`/console-logs?projectPath=${encodeURIComponent(projectPath)}&clear=true`);
      } catch (_) {}
    }
    consoleData = { logs: [], redLogs: [], errorCount: 0, totalCount: 0 };
    if (state.workstation) {
      state.workstation.activeSyntaxError = null;
      state.workstation.hasRunLiveCheck = true;
      state.workstation.consoleLogs = '';
    }
    renderConsoleBox(container);
    updateConsoleBadge(0);
    showToast('Runtime error logs cleared.', 'info');
  });

  // Copy runtime error
  const btnCopyError = container.querySelector('#btn-ws-copy-error');
  const consoleBox = container.querySelector('#ws-console-box');

  const handleCopyError = (e) => {
    e?.stopPropagation?.();
    copyErrorToClipboard(btnCopyError);
  };

  btnCopyError?.addEventListener('click', handleCopyError);
  consoleBox?.addEventListener('click', handleCopyError);

  // Compile button
  container.querySelector('#btn-ws-compile-handoff')?.addEventListener('click', () => {
    if (onCompileCallback) onCompileCallback();
  });

  // 1-Click Split Handoff Copy button
  const btnSplitCopy = container.querySelector('#btn-ws-split-copy-handoff');
  btnSplitCopy?.addEventListener('click', async () => {
    btnSplitCopy.disabled = true;
    btnSplitCopy.textContent = '⏳ Compiling...';
    try {
      if (onCompileCallback) {
        await onCompileCallback({ copyToClipboard: true });
      }
      btnSplitCopy.textContent = '✓ Copied!';
      btnSplitCopy.style.background = '#238636';
      setTimeout(() => {
        if (btnSplitCopy) {
          btnSplitCopy.textContent = '📋 Copy AI Handoff';
          btnSplitCopy.style.background = '';
          btnSplitCopy.disabled = false;
        }
      }, 2500);
    } catch (err) {
      if (btnSplitCopy) {
        btnSplitCopy.textContent = '📋 Copy AI Handoff';
        btnSplitCopy.disabled = false;
      }
    }
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

function getFullErrorText() {
  const ws = state.workstation;
  if (ws?.activeSyntaxError) {
    return `SYNTAX ERROR in ${ws.activeSyntaxError.file}:\n${ws.activeSyntaxError.message}`;
  }
  if (consoleData.redLogs && consoleData.redLogs.length > 0) {
    return consoleData.redLogs.map(l => l.text).join('\n');
  }
  if (consoleData.logs && consoleData.logs.length > 0) {
    const errorLogs = consoleData.logs.filter(l => l.isError);
    if (errorLogs.length > 0) {
      return errorLogs.map(l => l.text).join('\n');
    }
  }
  return '';
}

async function copyErrorToClipboard(triggerBtn) {
  const text = getFullErrorText();
  if (!text || !text.trim()) {
    showToast('Nothing to copy', 'info');
    return;
  }

  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch (_) {
    copied = false;
  }

  if (!copied) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch (_) {
      copied = false;
    }
  }

  if (copied) {
    if (triggerBtn) {
      const origText = triggerBtn.textContent;
      triggerBtn.textContent = '✓ Copied!';
      triggerBtn.style.color = '#3fb950';
      setTimeout(() => {
        if (triggerBtn) {
          triggerBtn.textContent = origText;
          triggerBtn.style.color = '';
        }
      }, 2000);
    }
    showToast('✓ Runtime error copied to clipboard', 'success');
  } else {
    showToast('Failed to copy to clipboard', 'warn');
  }
}

export async function refreshConsoleEvidence(container, force = false) {
  const targetContainer = container || document.getElementById('ws-pane-problem');
  if (!state.projectPath) return;
  consoleData = await fetchConsoleLogs(state.projectPath, force);
  if (state.workstation && force) {
    state.workstation.hasRunLiveCheck = true;
  }
  renderConsoleBox(targetContainer);

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
              if (topFiles[0].line) {
                state.workstation.targetLine = topFiles[0].line;
              }
            } else {
              state.workstation.selectedFiles.add(data.files[0].file);
              if (data.files[0].line) {
                state.workstation.targetLine = data.files[0].line;
              }
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
  } else if ((!consoleData.redLogs || consoleData.redLogs.length === 0) && !state.workstation?.activeSyntaxError) {
    if (state.workstation) {
      state.workstation.targetLine = null;
    }
  }
  return consoleData;
}

function renderConsoleBox(container) {
  const targetContainer = container || document.getElementById('ws-pane-problem');
  const box = targetContainer?.querySelector('#ws-console-box');
  if (!box) return;

  const ws = state.workstation;
  if (ws.consoleFilter === 'red') {
    if (!consoleData.redLogs || consoleData.redLogs.length === 0) {
      if (ws.hasRunLiveCheck) {
        box.innerHTML = '<div style="color:#34d399; font-style:italic;">✓ Verified: No compiler or runtime errors detected. (Click 🔄 Re-check anytime).</div>';
      } else {
        box.innerHTML = '<div style="color:var(--dim); font-style:italic;">⚠️ Runtime check not run yet for this state. Click 🔄 Re-check to run compiler & runtime checks.</div>';
      }
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

  const splitErrorText = container?.querySelector('#ws-split-error-text');
  if (splitErrorText) {
    if (consoleData.redLogs && consoleData.redLogs.length > 0) {
      splitErrorText.textContent = consoleData.redLogs[0].text;
    } else if (ws.problemText) {
      splitErrorText.textContent = ws.problemText;
    } else if (ws.hasRunLiveCheck) {
      splitErrorText.textContent = '✓ No runtime errors';
    } else {
      splitErrorText.textContent = 'Ready to inspect';
    }
  }
}

export function getProblemPayload() {
  const ws = state.workstation;
  let consoleText = '';

  // Prioritize active syntax error on disk so AI handoff always sees it
  if (ws?.activeSyntaxError) {
    const syn = ws.activeSyntaxError;
    consoleText = `SYNTAX ERROR in ${syn.file}:\n${syn.message}`;
  }

  if (ws.consoleFilter === 'red' && consoleData.redLogs && consoleData.redLogs.length > 0) {
    const redText = consoleData.redLogs.map(l => l.text).join('\n');
    consoleText = consoleText ? `${consoleText}\n\n${redText}` : redText;
  } else if (consoleData.logs && consoleData.logs.length > 0) {
    const logText = consoleData.logs.map(l => l.text).join('\n');
    consoleText = consoleText ? `${consoleText}\n\n${logText}` : logText;
  }

  let description = ws.problemText ? ws.problemText.trim() : '';
  if (!description && ws?.activeSyntaxError) {
    description = `Fix syntax error in ${ws.activeSyntaxError.file}: ${ws.activeSyntaxError.message}`;
  } else if (!description && consoleData.redLogs && consoleData.redLogs.length > 0) {
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
