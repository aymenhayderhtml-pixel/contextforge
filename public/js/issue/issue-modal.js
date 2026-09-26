/**
 * public/js/issue/issue-modal.js
 * Issue reporting modal and surgical AI patch prompt compiler.
 */

import { state } from '../state.js';
import { showToast } from '../shared/toast.js';
import { projectDiskFiles } from '../sidebar/tree.js';
import { fetchConsoleLogs } from '../terminal/terminal.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function openIssueReportModal(preselectedFile = '') {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('Please extract a project first before reporting an issue.', 'warn');
    return;
  }

  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const availableFiles = (projectDiskFiles && projectDiskFiles.length > 0)
    ? projectDiskFiles.map(f => f.path)
    : (state.manifest && state.manifest.nodes ? state.manifest.nodes.map(n => n.id) : []);

  const initialSelected = new Set();
  if (preselectedFile) {
    initialSelected.add(preselectedFile);
  } else if (state.selectedNodeId) {
    initialSelected.add(state.selectedNodeId);
  } else if (availableFiles.length > 0) {
    initialSelected.add(availableFiles[0]);
  }

  const fileModes = {};
  availableFiles.forEach(f => {
    fileModes[f] = 'scoped';
  });

  modalRoot.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 680px; max-height: 90vh;">
        <div class="modal-header">
          <div class="modal-title">🐞 Report Issue & Generate AI Patch Prompt</div>
          <button class="panel-close" id="btn-close-issue-modal">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="issue-description" style="font-weight:600; color:var(--text); font-size:0.78rem;">
              Describe the issue / paste error message (e.g. line number or function name):
            </label>
            <textarea id="issue-description" class="modal-textarea" style="height:75px; min-height:55px;" placeholder="e.g. Uncaught TypeError: Cannot read properties of undefined (reading 'position') in src/player.js line 42..."></textarea>
          </div>

          <div class="form-group" style="margin-top:0.35rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">
              <label style="font-weight:600; color:var(--text); font-size:0.78rem; display:flex; align-items:center; gap:0.4rem;">
                <span>📟 Console</span>
                <span id="issue-console-badge" style="font-size:0.7rem; color:var(--dim); font-weight:normal;"></span>
              </label>
              <div style="display:flex; align-items:center; gap:0.45rem;">
                <label style="font-size:0.72rem; color:var(--dim); display:flex; align-items:center; gap:0.25rem; cursor:pointer;" title="Attach console output to prompt">
                  <input type="checkbox" id="issue-include-console" checked>
                  <span>Add to prompt</span>
                </label>
                <div class="pill-mode-group" id="console-filter-group">
                  <button type="button" class="pill-mode-btn" id="btn-console-filter-all" data-mode="all" title="Show all output">All</button>
                  <button type="button" class="pill-mode-btn active" id="btn-console-filter-red" data-mode="red" title="Show only red error lines" style="color:#ef4444; font-weight:600;">Red only</button>
                </div>
                <button type="button" class="secondary" id="btn-refresh-console" style="font-size:0.7rem; height:20px; padding:0 0.45rem;" title="Run check / refresh console">🔄 Check</button>
              </div>
            </div>
            <div id="issue-console-box" style="background:#0d1117; color:#c9d1d9; border:1px solid var(--border); border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:0.72rem; max-height:115px; overflow-y:auto; padding:0.4rem 0.6rem; white-space:pre-wrap; line-height:1.35;">
              Checking console output...
            </div>
          </div>

          <div id="issue-oversized-banner" style="display:none;" class="oversized-banner"></div>

          <div class="form-group" style="margin-top:0.35rem;">
            <label style="font-weight:600; color:var(--text); font-size:0.78rem; display:flex; justify-content:space-between; align-items:center;">
              <span>Select relevant file(s) to attach:</span>
              <span style="font-size:0.7rem; color:var(--dim); font-weight:normal;">Scoped context active by default (signatures & focused snippets)</span>
            </label>
            <div id="issue-files-list" style="max-height:120px; overflow-y:auto; background:var(--bg); border:1px solid var(--border); border-radius:4px; padding:0.4rem 0.6rem; display:flex; flex-direction:column; gap:0.35rem;">
              ${availableFiles.map(filePath => {
                const isTarget = initialSelected.has(filePath);
                return `
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:0.45rem; font-size:0.75rem;">
                    <label style="display:flex; align-items:center; gap:0.45rem; cursor:pointer; flex:1; overflow:hidden;">
                      <input type="checkbox" class="issue-file-chk" value="${esc(filePath)}" ${isTarget ? 'checked' : ''}>
                      <span style="font-family:'JetBrains Mono',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                        ${esc(filePath)}
                      </span>
                    </label>
                    <div class="pill-mode-group" data-file="${esc(filePath)}">
                      <button type="button" class="pill-mode-btn active" data-mode="scoped" title="Send outline & focused snippet">Scoped</button>
                      <button type="button" class="pill-mode-btn full" data-mode="full" title="Send entire file source">Full</button>
                    </div>
                  </div>
                `;
              }).join('') || '<div style="color:var(--dim); font-size:0.75rem;">No files found</div>'}
            </div>
          </div>

          <div class="form-group" style="margin-top:0.35rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">
              <label for="issue-prompt-area" style="font-weight:600; color:var(--text); font-size:0.78rem;">
                Generated AI Surgical Patch Prompt:
              </label>
              <div id="issue-prompt-savings" style="font-size:0.72rem; color:var(--dim);">
                Calculating prompt size...
              </div>
            </div>
            <textarea id="issue-prompt-area" class="modal-textarea" readonly style="height:170px;"></textarea>
          </div>

          <div style="font-size:0.75rem; color:var(--dim); padding:0.4rem 0.6rem; background:var(--bg); border:1px solid var(--border); border-radius:4px; display:flex; align-items:center; gap:0.4rem;">
            <span>💡</span>
            <span>Copy this prompt into your browser AI. When it replies with <code>### EDIT: relative/path.ext</code> (using <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; FIND</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; REPLACE</code>), click <strong>📋 Paste</strong> in the toolbar to apply the patch!</span>
          </div>
          <div id="issue-prompt-status" class="paste-status"></div>
        </div>
        <div class="modal-footer" style="justify-content:space-between; align-items:center;">
          <button class="secondary" id="btn-cancel-issue-modal">Close</button>
          <button id="btn-copy-issue-prompt">📋 Copy Issue Prompt</button>
        </div>
      </div>
    </div>
  `;

  const closeFn = () => { modalRoot.innerHTML = ''; };
  document.getElementById('btn-close-issue-modal')?.addEventListener('click', closeFn);
  document.getElementById('btn-cancel-issue-modal')?.addEventListener('click', closeFn);

  const descArea = document.getElementById('issue-description');
  const checkboxes = document.querySelectorAll('.issue-file-chk');
  const promptArea = document.getElementById('issue-prompt-area');
  const savingsEl = document.getElementById('issue-prompt-savings');
  const oversizedEl = document.getElementById('issue-oversized-banner');
  const issueConsoleBox = document.getElementById('issue-console-box');
  const issueConsoleBadge = document.getElementById('issue-console-badge');
  const includeConsoleChk = document.getElementById('issue-include-console');
  const btnFilterAll = document.getElementById('btn-console-filter-all');
  const btnFilterRed = document.getElementById('btn-console-filter-red');
  const btnRefreshConsole = document.getElementById('btn-refresh-console');

  let consoleFilter = 'red';
  let consoleData = { logs: [], redLogs: [] };

  function renderConsoleBox() {
    if (!issueConsoleBox) return;
    if (consoleFilter === 'red') {
      if (!consoleData.redLogs || consoleData.redLogs.length === 0) {
        issueConsoleBox.innerHTML = '<div style="color:var(--dim); font-style:italic;">No red errors detected in console. (Click "All" to view normal output, or "🔄 Check" to run compiler check).</div>';
      } else {
        issueConsoleBox.innerHTML = consoleData.redLogs.map(l =>
          `<div style="color:#ff6b6b; font-weight:600; padding:1px 0;">${esc(l.text)}</div>`
        ).join('');
      }
    } else {
      if (!consoleData.logs || consoleData.logs.length === 0) {
        issueConsoleBox.innerHTML = '<div style="color:var(--dim); font-style:italic;">Console is empty. Click "🔄 Check" to run engine check.</div>';
      } else {
        issueConsoleBox.innerHTML = consoleData.logs.map(l => {
          const color = l.isError ? '#ff6b6b; font-weight:600;' : '#8b949e;';
          return `<div style="color:${color} padding:1px 0;">${esc(l.text)}</div>`;
        }).join('');
      }
    }

    if (issueConsoleBadge) {
      const errCount = (consoleData.redLogs || []).length;
      if (errCount > 0) {
        issueConsoleBadge.innerHTML = `<span style="color:#ef4444; font-weight:600;">🔴 ${errCount} error${errCount === 1 ? '' : 's'}</span>`;
      } else {
        issueConsoleBadge.innerHTML = `<span style="color:var(--green);">✓ 0 errors</span>`;
      }
    }
  }

  async function updatePrompt() {
    const attachedFiles = [];
    checkboxes.forEach(cb => {
      if (cb.checked) attachedFiles.push(cb.value);
    });

    const targetFile = attachedFiles.length > 0 ? attachedFiles[0] : '';
    const issueDescription = descArea ? descArea.value.trim() : '';

    let consolePayload = '';
    if (includeConsoleChk && includeConsoleChk.checked) {
      if (consoleFilter === 'red' && consoleData.redLogs && consoleData.redLogs.length > 0) {
        consolePayload = consoleData.redLogs.map(l => l.text).join('\n');
      } else if (consoleData.logs && consoleData.logs.length > 0) {
        consolePayload = consoleData.logs.map(l => l.text).join('\n');
      }
    }

    try {
      const res = await fetch('/scoped-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          targetFile,
          issueDescription,
          attachedFiles,
          fileModes,
          consoleLogs: consolePayload,
          consoleMode: consoleFilter
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          if (promptArea) promptArea.value = data.prompt;
          if (savingsEl) {
            savingsEl.innerHTML = `<span>Tokens: ~${data.tokens.toLocaleString()}</span> ${data.savingsPercent > 0 ? `<span style="color:var(--green); font-weight:600; margin-left:0.35rem;">(${data.savingsPercent}% saved vs full)</span>` : ''}`;
          }

          if (oversizedEl) {
            if (data.oversizedFiles && data.oversizedFiles.length > 0) {
              const names = data.oversizedFiles.map(o => `${o.file} (${o.linesCount} lines)`).join(', ');
              oversizedEl.style.display = 'flex';
              oversizedEl.innerHTML = `<span>⚠️ Oversized file detected: ${esc(names)}. Scoped outline mode enabled to conserve context budget.</span>`;
            } else {
              oversizedEl.style.display = 'none';
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to update prompt:', err);
    }
  }

  async function loadConsole(force = false) {
    consoleData = await fetchConsoleLogs(projectPath, force);
    if (consoleData.redLogs.length > 0) {
      consoleFilter = 'red';
      btnFilterRed?.classList.add('active');
      btnFilterAll?.classList.remove('active');
      if (includeConsoleChk) includeConsoleChk.checked = true;

      const allErrText = consoleData.redLogs.map(l => l.text).join('\n');
      checkboxes.forEach(cb => {
        const val = cb.value;
        if (allErrText.includes(val) || allErrText.includes('res://' + val)) {
          cb.checked = true;
        }
      });
    }
    renderConsoleBox();
    await updatePrompt();
  }

  btnFilterAll?.addEventListener('click', () => {
    consoleFilter = 'all';
    btnFilterAll.classList.add('active');
    btnFilterRed?.classList.remove('active');
    renderConsoleBox();
    updatePrompt();
  });

  btnFilterRed?.addEventListener('click', () => {
    consoleFilter = 'red';
    btnFilterRed.classList.add('active');
    btnFilterAll?.classList.remove('active');
    renderConsoleBox();
    updatePrompt();
  });

  btnRefreshConsole?.addEventListener('click', () => loadConsole(true));
  includeConsoleChk?.addEventListener('change', updatePrompt);
  descArea?.addEventListener('input', updatePrompt);
  checkboxes.forEach(cb => cb.addEventListener('change', updatePrompt));

  document.querySelectorAll('.pill-mode-group[data-file]').forEach(group => {
    const file = group.getAttribute('data-file');
    const btns = group.querySelectorAll('.pill-mode-btn');
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fileModes[file] = btn.getAttribute('data-mode');
        updatePrompt();
      });
    });
  });

  document.getElementById('btn-copy-issue-prompt')?.addEventListener('click', copyIssuePrompt);

  await loadConsole(false);
}

export async function copyIssuePrompt() {
  const area = document.getElementById('issue-prompt-area');
  const btn = document.getElementById('btn-copy-issue-prompt');
  const statusEl = document.getElementById('issue-prompt-status');
  if (!area || !area.value) {
    showToast('Prompt is empty', 'warn');
    return;
  }

  try {
    await navigator.clipboard.writeText(area.value);
    if (btn) btn.textContent = '✓ Copied!';
    showToast('✓ Issue prompt copied to clipboard!', 'success');
    if (statusEl) {
      statusEl.className = 'paste-status';
      statusEl.textContent = 'Copied prompt to clipboard! Paste it into your external coding AI.';
    }
    setTimeout(() => { if (btn) btn.textContent = '📋 Copy Issue Prompt'; }, 2500);
  } catch (err) {
    area.select();
    document.execCommand('copy');
    if (btn) btn.textContent = '✓ Copied!';
  }
}
